'use strict';

const SunCalc = require('suncalc');

// HomeKit-like adaptive curve.
// We anchor on solar elevation rather than wall-clock time: that way the
// behavior is symmetric around solar noon, scales with day length through the
// seasons, and degenerates gracefully near the poles.
//
// Domain mapping (sun elevation θ in degrees):
//   θ ≤ -6°    civil twilight passed → ramp at 0 (warm/dim end of day curve)
//   θ ≥ +30°   high day              → ramp at 1 (cool/bright end)
//   in between: smoothstep, so the derivative is zero at the edges → no kink
//   at sunrise/sunset.
//
// Returns ramp ∈ [0, 1]; callers interpolate min↔max with it.

function smoothstep(t) {
  if (t <= 0) return 0;
  if (t >= 1) return 1;
  return t * t * (3 - 2 * t);
}

function elevationRamp(elevationDeg) {
  const lo = -6;
  const hi = 30;
  return smoothstep((elevationDeg - lo) / (hi - lo));
}

function computeAdaptive({ lat, lon, now, day, night, nightMode }) {
  if (nightMode) {
    const out = {
      kelvin: night.kelvin,
      dimPct: night.dim,
      ramp: 0,
      elevationDeg: null,
      isNight: true,
    };
    // Optional color-mode for night: if a valid hex was configured, surface
    // it as { hue, sat } so the apply layer can branch onto light_hue +
    // light_saturation instead of light_temperature. Lamps without color
    // capability degrade silently to the kelvin path.
    const c = hexToHueSat(night.color);
    if (c) {
      out.color = c;
      out.colorHex = String(night.color).toLowerCase();
    }
    return out;
  }

  const pos = SunCalc.getPosition(now, lat, lon);
  const elevationDeg = (pos.altitude * 180) / Math.PI;
  const ramp = elevationRamp(elevationDeg);

  return {
    kelvin: Math.round(day.kelvinMin + (day.kelvinMax - day.kelvinMin) * ramp),
    dimPct: Math.round(day.dimMin + (day.dimMax - day.dimMin) * ramp),
    ramp,
    elevationDeg,
    isNight: false,
  };
}

// Homey light_temperature convention: 0 = COOLEST, 1 = WARMEST.
// Higher kelvin (cooler) → lower light_temperature.
const KELVIN_LO = 1500;
const KELVIN_HI = 6500;
function kelvinToLightTemperature(k) {
  const t = (KELVIN_HI - k) / (KELVIN_HI - KELVIN_LO);
  return Math.max(0, Math.min(1, t));
}

// Hex "#rrggbb" → { hue: 0..1, sat: 0..1 } in HSV space, suitable for Homey's
// light_hue / light_saturation capabilities. Returns null on any invalid
// input so the caller can fall back to the kelvin path.
function hexToHueSat(hex) {
  if (!hex || typeof hex !== 'string') return null;
  const m = hex.trim().replace(/^#/, '').match(/^([0-9a-f]{6})$/i);
  if (!m) return null;
  const r = parseInt(m[1].slice(0, 2), 16) / 255;
  const g = parseInt(m[1].slice(2, 4), 16) / 255;
  const b = parseInt(m[1].slice(4, 6), 16) / 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const d = max - min;
  let h = 0;
  if (d > 0) {
    if (max === r) h = ((g - b) / d + 6) % 6;
    else if (max === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    h *= 60;
  }
  const s = max === 0 ? 0 : d / max;
  return { hue: h / 360, sat: s };
}

// --- timezone helpers --------------------------------------------------------
// The Homey Pro container runs in UTC, but users (and SunCalc results) live in
// a wall-clock timezone. We can't use Date.prototype.getHours() to format times
// for display — that would show UTC. Instead we pull the user's timezone from
// homey.clock and format via Intl.DateTimeFormat.

function tzParts(d, tz) {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: tz,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
    hour12: false,
  }).formatToParts(d);
  const map = {};
  for (const p of parts) map[p.type] = p.value;
  return map;
}

function hmInTz(d, tz) {
  if (!d) return null;
  const p = tzParts(d, tz);
  // Intl emits "24" for midnight in some locales; normalise to "00".
  const hh = p.hour === '24' ? '00' : p.hour;
  return `${hh}:${p.minute}`;
}

function hoursInTz(d, tz) {
  if (!d) return null;
  const p = tzParts(d, tz);
  const h = p.hour === '24' ? 0 : Number(p.hour);
  return h + Number(p.minute) / 60;
}

// Returns the absolute Date that corresponds to 00:00 local time on the same
// calendar day as `d` in `tz`. Used as the anchor for the 24h curve sampling.
function startOfDayInTz(d, tz) {
  const p = tzParts(d, tz);
  // Build the same Y-M-D 00:00 as if it were UTC, then correct by the tz
  // offset at that moment. One probe round-trip is enough because day-of-year
  // doesn't change across the offset for a "00:00 local" anchor.
  const asUtcMs = Date.UTC(Number(p.year), Number(p.month) - 1, Number(p.day));
  const probe = tzParts(new Date(asUtcMs), tz);
  let offsetMin = Number(probe.hour) * 60 + Number(probe.minute);
  // If the probe rolls into the previous calendar day, the offset is negative.
  const probeDay = Number(probe.year) * 10000 + Number(probe.month) * 100 + Number(probe.day);
  const targetDay = Number(p.year) * 10000 + Number(p.month) * 100 + Number(p.day);
  if (probeDay < targetDay) offsetMin -= 24 * 60;
  return new Date(asUtcMs - offsetMin * 60 * 1000);
}

// Sample the 24-hour adaptive curve at 15-minute resolution. Used by the
// settings UI (and pair flow) to draw the daily preview. Returns labels
// formatted in the user's timezone so the chart matches the wall clock.
function buildDailyCurve({ homey, day, night }) {
  let lat, lon;
  try {
    lat = homey.geolocation.getLatitude();
    lon = homey.geolocation.getLongitude();
  } catch (_) { /* no geo permission yet */ }

  let tz = 'UTC';
  try { tz = homey.clock.getTimezone() || 'UTC'; } catch (_) {}

  const now = new Date();
  const dayStart = startOfDayInTz(now, tz);
  const times = (lat != null && lon != null) ? SunCalc.getTimes(now, lat, lon) : {};
  const points = [];
  for (let i = 0; i <= 96; i++) {
    const t = new Date(dayStart.getTime() + i * 15 * 60 * 1000);
    const v = computeAdaptive({ lat, lon, now: t, day, night, nightMode: false });
    points.push({
      hour: i / 4,
      kelvin: v.kelvin,
      dimPct: v.dimPct,
      elevation: v.elevationDeg,
    });
  }
  return {
    nowLabel: hmInTz(now, tz),
    nowHour: hoursInTz(now, tz),
    sunriseLabel: hmInTz(times.sunrise, tz),
    sunsetLabel: hmInTz(times.sunset, tz),
    sunriseHour: hoursInTz(times.sunrise, tz),
    sunsetHour: hoursInTz(times.sunset, tz),
    points,
  };
}

module.exports = {
  computeAdaptive,
  elevationRamp,
  smoothstep,
  kelvinToLightTemperature,
  hexToHueSat,
  buildDailyCurve,
  hmInTz,
  hoursInTz,
};
