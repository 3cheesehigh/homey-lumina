'use strict';

// Widget-side API: small wrapper around the ZonesController so the widget
// frontend doesn't need to know about the app's internal structure. All
// real logic lives in lib/zones.js; this file is the dashboard surface.

function pickRuntime(homey, bereichId) {
  if (!bereichId) return null;
  const controller = homey.app.getZones?.();
  if (!controller) return null;
  return controller.getRuntime(bereichId);
}

module.exports = {
  // Returns the current state for one Bereich -- mode + computed live values
  // (kelvin, dim, sun elevation). The widget polls this on a short interval
  // so the displayed values stay roughly in sync with the apply ticks.
  async getStatus({ homey, query }) {
    const bereichId = query?.bereichId;
    const rt = pickRuntime(homey, bereichId);
    if (!rt) return null;
    const live = rt.getCurrentValues();
    return {
      bereichId: rt.bereichId,
      homeyZoneName: rt._homeyZoneName || rt.bereichId,
      mode: rt.getMode(),
      kelvin: live?.kelvin ?? null,
      dimPct: live?.dimPct ?? null,
      elevationDeg: typeof live?.elevationDeg === 'number'
        ? Number(live.elevationDeg.toFixed(1)) : null,
      isNight: !!live?.isNight,
    };
  },

  async setMode({ homey, body }) {
    const bereichId = body?.bereichId;
    const mode = body?.mode;
    if (!bereichId || !['off', 'day', 'night'].includes(mode)) {
      throw new Error('bereichId and valid mode required');
    }
    const rt = pickRuntime(homey, bereichId);
    if (!rt) throw new Error(`zone ${bereichId} not configured`);
    await rt.setMode(mode);
    return { ok: true, mode };
  },
};
