'use strict';

const { FIELDS } = require('./lib/fields');
const { buildDailyCurve } = require('./lib/curve');

const FIELD_BY_KEY = Object.fromEntries(FIELDS.map(f => [f.key, f]));

// Clamp a numeric input to its declared FIELDS range; fall back to default if
// the value can't be parsed. Used to harden the API surface against bad UI
// state (empty inputs, NaN) before values feed into the curve math.
function clampNumber(key, val) {
  const f = FIELD_BY_KEY[key];
  if (!f) return Number(val);
  const x = Number(val);
  if (!Number.isFinite(x)) return f.defaultValue;
  return Math.max(f.min, Math.min(f.max, x));
}

function getZoneDevices(homey) {
  return homey.drivers.getDriver('zone').getDevices();
}

module.exports = {
  async getLog({ homey }) {
    return homey.app.getRecentLog();
  },

  async getFields() {
    return FIELDS;
  },

  // List Lumina Zone devices for the settings UI -- includes override values
  // so the inline editor can pre-fill its fields without an extra round trip.
  async getZones({ homey }) {
    const devices = getZoneDevices(homey);
    return devices.map(d => ({
      id: d.getData().id,
      name: d.getName(),
      groupId: d.getStoreValue('groupId') || 'default',
      overrides: d.getStoreValue('overrides') || {},
    }));
  },

  // Update a zone's name and/or overrides from the settings UI.
  async postZoneUpdate({ homey, body }) {
    const { zoneId, name, overrides } = body || {};
    if (!zoneId) throw new Error('zoneId required');
    const devices = getZoneDevices(homey);
    const dev = devices.find(d => d.getData().id === zoneId);
    if (!dev) throw new Error(`zone ${zoneId} not found`);

    if (name && name !== dev.getName()) {
      await dev.setName(name.toString().trim() || 'Lumina-Zone');
    }
    if (overrides && typeof overrides === 'object') {
      // Filter overrides: only keep keys that differ from the group's value
      // (keys equal to group = inherit, not an override).
      const groupId = dev.getStoreValue('groupId') || 'default';
      const groups = homey.settings.get('groups') || {};
      const group = groups[groupId] || {};
      const clean = {};
      for (const [k, v] of Object.entries(overrides)) {
        if (k === 'nightColor') {
          // Optional hex string. Drop if invalid or equal to the group's
          // value (== inherit, not an override).
          if (typeof v !== 'string' || !/^#[0-9a-f]{6}$/i.test(v)) continue;
          const norm = v.toLowerCase();
          if ((group.nightColor || '').toLowerCase() === norm) continue;
          clean[k] = norm;
          continue;
        }
        const n = Number(v);
        if (!Number.isFinite(n)) continue;
        if (group[k] != null && n === group[k]) continue;
        clean[k] = n;
      }
      await dev.setStoreValue('overrides', clean);
    }
    homey.app.trace(`api: updated zone "${dev.getName()}" -> trigger apply`);
    // Fire-and-forget apply so the new values reach the lamps immediately
    // instead of waiting up to the next 5-minute tick.
    if (typeof dev._applyNow === 'function') {
      dev._applyNow().catch(err => homey.app.trace(`apply after zone update failed: ${err.message}`));
    }
    return { ok: true };
  },

  // Compute the 24-hour adaptive curve (kelvin + dim per quarter-hour) for a
  // given group/zone profile. Used by the settings UI to draw the daily curve.
  async postCurve({ homey, body }) {
    const day = body?.day;
    const night = body?.night;
    if (!day || !night) throw new Error('day and night required');
    // Clamp inputs to the declared FIELDS ranges so a stray NaN from the
    // settings UI can't produce broken SVG coordinates downstream.
    const cleanDay = {
      kelvinMin: clampNumber('dayKelvinMin', day.kelvinMin),
      kelvinMax: clampNumber('dayKelvinMax', day.kelvinMax),
      dimMin: clampNumber('dayDimMin', day.dimMin),
      dimMax: clampNumber('dayDimMax', day.dimMax),
    };
    const cleanNight = {
      kelvin: clampNumber('nightKelvin', night.kelvin),
      dim: clampNumber('nightDim', night.dim),
      color: typeof night.color === 'string' ? night.color : undefined,
    };
    return buildDailyCurve({ homey, day: cleanDay, night: cleanNight });
  },

  // Assign a zone to a different group. Updates the zone's store.groupId
  // only -- in live-binding mode the values come from the group at apply
  // time, so no seeding is needed. Any per-key overrides the user set on the
  // zone stay intact across group changes (they remain the user's explicit
  // choice for those keys).
  async postAssignZone({ homey, body }) {
    const { zoneId, groupId } = body || {};
    if (!zoneId || !groupId) throw new Error('zoneId and groupId required');

    const devices = getZoneDevices(homey);
    const dev = devices.find(d => d.getData().id === zoneId);
    if (!dev) throw new Error(`zone ${zoneId} not found`);

    const groups = homey.settings.get('groups') || {};
    const group = groups[groupId];
    if (!group) throw new Error(`group ${groupId} not found`);

    await dev.setStoreValue('groupId', groupId);
    homey.app.trace(`api: assigned zone "${dev.getName()}" -> group "${group.name}" -> trigger apply`);
    if (typeof dev._applyNow === 'function') {
      dev._applyNow().catch(err => homey.app.trace(`apply after group change failed: ${err.message}`));
    }
    return { ok: true };
  },
};
