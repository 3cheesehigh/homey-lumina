'use strict';

// Tracks "dim then auto-off after delay" timers triggered by Flow cards
// (typically wired to a motion sensor's no-motion event). One timer per
// "lamp:<deviceId>" key. A re-fire on the same key replaces the existing
// timer. Any smart_on / smart_toggle for the lamp cancels it (so the
// user's existing "motion -> smart_on" flow automatically restores the
// lamp and aborts the auto-off).

const WRITE_GRACE_MS = 3000;
const FADE_SETTLE_MS = 200;
const HARDCODED_FALLBACKS = Object.freeze({
  mode: 'relative',
  percent: 50,
  seconds: 30,
  fadeSeconds: 5,
});

class PresenceController {
  constructor(app) {
    this._app = app;
    this._timers = new Map(); // key -> { timeoutId, lampIds, key }
  }

  stop() {
    for (const t of this._timers.values()) {
      if (t.timeoutId) clearTimeout(t.timeoutId);
      if (t.fadeTimeoutId) clearTimeout(t.fadeTimeoutId);
    }
    this._timers.clear();
  }

  // opts: { mode, percent, seconds, fadeSeconds } -- each missing field
  // falls back to the user's configured presenceDefaults, then to the
  // hardcoded fallbacks. Called by both flow-card variants: the override
  // card passes all fields, the "defaults" card passes none.
  async startLight(lampId, opts = {}) {
    const { devices } = await this._app.getDevicesAndZones();
    const lamp = devices[lampId];
    if (!lamp) throw new Error(`light ${lampId} not found`);
    const p = this._resolveParams(opts);
    await this._start(`lamp:${lampId}`, [lamp], p);
  }

  _resolveParams(opts) {
    const stored = this._app.homey.settings.get('presenceDefaults') || {};
    const pick = (key) => opts[key] != null ? opts[key] : (stored[key] != null ? stored[key] : HARDCODED_FALLBACKS[key]);
    return {
      mode: pick('mode'),
      percent: pick('percent'),
      seconds: pick('seconds'),
      fadeSeconds: pick('fadeSeconds'),
    };
  }

  cancelForLamp(lampId) {
    this._cancel(`lamp:${lampId}`, `lamp ${lampId} re-activated`);
  }

  _cancel(key, reason) {
    const t = this._timers.get(key);
    if (!t) return false;
    if (t.timeoutId) clearTimeout(t.timeoutId);
    if (t.fadeTimeoutId) clearTimeout(t.fadeTimeoutId);
    this._timers.delete(key);
    this._app.trace(`presence: cancelled ${key} (${reason})`);
    return true;
  }

  async _start(key, lamps, p) {
    if (p.mode !== 'relative' && p.mode !== 'absolute') {
      throw new Error(`invalid mode: ${p.mode}`);
    }
    const pct = Math.max(1, Math.min(99, Math.round(p.percent)));
    const holdSec = Math.max(1, Math.min(3600, Math.round(p.seconds)));
    const fadeMs = Math.max(0, Math.min(60, Math.round(p.fadeSeconds))) * 1000;
    const mode = p.mode;

    this._cancel(key, 'replaced by new presence_dim');

    const api = await this._app.getApi();
    const zones = this._app.getZones();
    // Suppress the manual-change detector for the whole hold period; without
    // this, our dim write would look like a user override and pause the lamp
    // from the adaptive tick after motion returns.
    const writeWindow = holdSec * 1000 + WRITE_GRACE_MS;

    const dimmedIds = [];
    const writes = [];
    for (const lamp of lamps) {
      const caps = lamp.capabilities || [];
      if (!caps.includes('dim')) continue;
      if (lamp.capabilitiesObj?.onoff?.value !== true) continue;

      const rt = zones.findRuntimeForLight(lamp.id);
      let newDim;
      if (mode === 'absolute') {
        newDim = pct;
      } else {
        const last = rt?._lastApplied.get(lamp.id);
        const baseDim = last?.dimPct
          ?? Math.round((lamp.capabilitiesObj?.dim?.value ?? 1) * 100);
        newDim = Math.round(baseDim * (pct / 100));
      }
      newDim = Math.max(1, Math.min(100, newDim));

      if (rt) rt.markWriting(lamp.id, writeWindow);
      writes.push(api.devices.setCapabilityValue({
        deviceId: lamp.id, capabilityId: 'dim', value: newDim / 100,
        opts: { duration: 800 },
      }).catch(err => this._app.trace(`presence dim failed for ${lamp.name}: ${err.message}`)));
      dimmedIds.push(lamp.id);
    }

    await Promise.all(writes);

    if (dimmedIds.length === 0) {
      this._app.trace(`presence: ${key} -- no lamps to dim (all off?)`);
      return;
    }

    const timeoutId = setTimeout(() => this._fireOff(key).catch(err =>
      this._app.trace(`presence off failed (${key}): ${err.message}`)
    ), holdSec * 1000);

    this._timers.set(key, { key, timeoutId, fadeTimeoutId: null, lampIds: dimmedIds, fadeMs });
    this._app.trace(`presence: ${key} dimmed ${dimmedIds.length} lamp(s) ${mode === 'absolute' ? 'to' : 'by'} ${pct}%, hold ${holdSec}s, fade ${fadeMs}ms`);
  }

  // Hold expired: start a firmware-interpolated dim-to-0 fade and schedule
  // the actual onoff=false write for after the fade settles. The timer
  // stays in _timers so a smart_on during the fade can still abort the
  // pending off via cancelForLamp() -- without that, a re-triggering
  // motion event would let smart_on bring the lamp back up only to have
  // our delayed off write turn it off again seconds later.
  async _fireOff(key) {
    const t = this._timers.get(key);
    if (!t) return;
    t.timeoutId = null;
    const api = await this._app.getApi();
    const zones = this._app.getZones();
    const fadeMs = t.fadeMs ?? 0;

    if (fadeMs === 0) {
      // No fade requested -- skip straight to off.
      await this._finishOff(key);
      return;
    }

    // Extend the manual-change suppression so the dim ramp from N% -> 0%
    // isn't misread as user overrides by the per-zone tick subscriptions.
    for (const id of t.lampIds) {
      const rt = zones.findRuntimeForLight(id);
      if (rt) rt.markWriting(id, fadeMs + WRITE_GRACE_MS);
    }

    const fades = t.lampIds.map(id =>
      api.devices.setCapabilityValue({
        deviceId: id, capabilityId: 'dim', value: 0,
        opts: { duration: fadeMs },
      }).catch(err => this._app.trace(`presence fade failed for ${id}: ${err.message}`))
    );
    await Promise.all(fades);

    t.fadeTimeoutId = setTimeout(() => this._finishOff(key).catch(err =>
      this._app.trace(`presence finish-off failed (${key}): ${err.message}`)
    ), fadeMs + FADE_SETTLE_MS);

    this._app.trace(`presence: ${key} fading ${t.lampIds.length} lamp(s) to 0 over ${fadeMs}ms`);
  }

  async _finishOff(key) {
    const t = this._timers.get(key);
    if (!t) return;
    this._timers.delete(key);
    const api = await this._app.getApi();
    const offs = t.lampIds.map(id =>
      api.devices.setCapabilityValue({ deviceId: id, capabilityId: 'onoff', value: false })
        .catch(err => this._app.trace(`presence off write failed for ${id}: ${err.message}`))
    );
    await Promise.all(offs);
    this._app.trace(`presence: ${key} faded out and turned off ${t.lampIds.length} lamp(s)`);
  }
}

module.exports = { PresenceController };
