'use strict';

// Single source of truth for the curve and night-value fields shared by:
//   - lib/curve.js       (computation input shape)
//   - drivers/zone/*     (zone overrides, pair/repair UI, settings schema in app.json)
//   - settings/index.html (group editor)
//   - api.js             (exposed to client UIs via GET /fields)
//
// `section` groups them visually in UIs ("day" vs "night"). `unit` is purely
// for label rendering. `defaultValue` is the seed value for new groups/zones.

const FIELDS = [
  { key: 'dayKelvinMin', section: 'day',   unit: 'K', min: 1500, max: 6500, defaultValue: 2200,
    label: { de: 'Tag Kelvin min (Sonnenauf-/-untergang)', en: 'Day Kelvin min (sunrise/sunset)' } },
  { key: 'dayKelvinMax', section: 'day',   unit: 'K', min: 1500, max: 6500, defaultValue: 5500,
    label: { de: 'Tag Kelvin max (Sonnenhöchststand)',    en: 'Day Kelvin max (solar noon)' } },
  { key: 'dayDimMin',    section: 'day',   unit: '%', min: 1,    max: 100,  defaultValue: 60,
    label: { de: 'Tag Helligkeit min',                    en: 'Day brightness min' } },
  { key: 'dayDimMax',    section: 'day',   unit: '%', min: 1,    max: 100,  defaultValue: 100,
    label: { de: 'Tag Helligkeit max',                    en: 'Day brightness max' } },
  // Offsets shift the morning ramp-up and evening ramp-down by N minutes.
  // Negative = transition earlier (lights brighten before sunrise / dim before
  // sunset). Positive = later (stay dim after sunrise / bright after sunset).
  { key: 'sunriseOffsetMin', section: 'transitions', unit: 'min', min: -120, max: 120, step: 5, inputType: 'range', defaultValue: 0,
    label: { de: 'Sonnenaufgang-Offset (− = früher hell)',  en: 'Sunrise offset (− = brighten earlier)' } },
  { key: 'sunsetOffsetMin',  section: 'transitions', unit: 'min', min: -120, max: 120, step: 5, inputType: 'range', defaultValue: 0,
    label: { de: 'Sonnenuntergang-Offset (+ = später dunkel)', en: 'Sunset offset (+ = stay bright later)' } },
  { key: 'nightKelvin',  section: 'night', unit: 'K', min: 1500, max: 6500, defaultValue: 1800,
    label: { de: 'Nacht Kelvin',                          en: 'Night Kelvin' } },
  { key: 'nightDim',     section: 'night', unit: '%', min: 1,    max: 100,  defaultValue: 15,
    label: { de: 'Nacht Helligkeit',                      en: 'Night brightness' } },
];

const KEYS = FIELDS.map(f => f.key);

function defaults() {
  const out = {};
  for (const f of FIELDS) out[f.key] = f.defaultValue;
  return out;
}

module.exports = { FIELDS, KEYS, defaults };
