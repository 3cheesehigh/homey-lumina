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

function serializeRuntime(rt, allZones) {
  return {
    bereichId: rt.bereichId,
    homeyZoneName: rt._homeyZoneName || allZones[rt.bereichId]?.name || rt.bereichId,
    groupId: rt._config().groupId || 'default',
    overrides: rt._config().overrides || {},
    excludedLights: rt._config().excludedLights || [],
    lampOverrides: rt._config().lampOverrides || {},
    mode: rt.getMode(),
    members: rt.getMemberCandidates(),
  };
}

module.exports = {
  async getLog({ homey }) {
    return homey.app.getRecentLog();
  },

  async getFields() {
    return FIELDS;
  },

  // List all configured Lumina zones with their full state, so the settings
  // UI can render groups, overrides, member checkboxes and current mode
  // without further round trips.
  async getZones({ homey }) {
    const controller = homey.app.getZones();
    const { zones: allZones } = await homey.app.getDevicesAndZones();
    return controller.listRuntimes().map(rt => serializeRuntime(rt, allZones));
  },

  // List Homey-Bereiche that don't yet have a Lumina zone configured -- used
  // to populate the "+ Bereich hinzufügen" dropdown.
  async getAvailableZones({ homey }) {
    const controller = homey.app.getZones();
    const { zones: allZones } = await homey.app.getDevicesAndZones();
    const configured = new Set(controller.listRuntimes().map(rt => rt.bereichId));
    const out = [];
    for (const z of Object.values(allZones)) {
      if (configured.has(z.id)) continue;
      out.push({ id: z.id, name: z.name, parent: z.parent || null });
    }
    out.sort((a, b) => (a.name || '').localeCompare(b.name || ''));
    return out;
  },

  // Upsert: create or update a zone's config (group, overrides, excludedLights,
  // mode). The settings UI uses this for both "+ Bereich" and "edit existing".
  async postZoneUpsert({ homey, body }) {
    const { bereichId } = body || {};
    if (!bereichId) throw new Error('bereichId required');

    const { zones: allZones } = await homey.app.getDevicesAndZones();
    if (!allZones[bereichId]) throw new Error(`Bereich ${bereichId} unknown`);

    const controller = homey.app.getZones();
    const patch = {};
    if (body.groupId != null) {
      const groups = homey.settings.get('groups') || {};
      if (!groups[body.groupId]) throw new Error(`group ${body.groupId} not found`);
      patch.groupId = body.groupId;
    }
    if (body.overrides != null) patch.overrides = body.overrides;
    if (body.excludedLights != null) patch.excludedLights = body.excludedLights;
    if (body.lampOverrides != null) patch.lampOverrides = body.lampOverrides;
    if (body.mode != null) patch.mode = body.mode;

    const next = await controller.upsertZone(bereichId, patch);
    homey.app.trace(`api: upserted zone "${allZones[bereichId].name}" -> ${JSON.stringify({ groupId: next.groupId, mode: next.mode })}`);
    return { ok: true };
  },

  async postZoneRemove({ homey, body }) {
    const { bereichId } = body || {};
    if (!bereichId) throw new Error('bereichId required');
    const controller = homey.app.getZones();
    const removed = await controller.removeZone(bereichId);
    homey.app.trace(`api: removed zone ${bereichId} (${removed ? 'ok' : 'not configured'})`);
    return { ok: removed };
  },

  // Compute the 24-hour adaptive curve (kelvin + dim per quarter-hour) for a
  // given group/zone profile. Used by the settings UI to draw the daily curve.
  async postCurve({ homey, body }) {
    const day = body?.day;
    const night = body?.night;
    const transitions = body?.transitions;
    if (!day || !night) throw new Error('day and night required');
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
    const cleanTransitions = transitions ? {
      sunriseOffsetMin: clampNumber('sunriseOffsetMin', transitions.sunriseOffsetMin),
      sunsetOffsetMin:  clampNumber('sunsetOffsetMin',  transitions.sunsetOffsetMin),
    } : undefined;
    return buildDailyCurve({ homey, day: cleanDay, night: cleanNight, transitions: cleanTransitions });
  },
};
