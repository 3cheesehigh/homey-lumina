'use strict';

const { computeAdaptive, kelvinToLightTemperature } = require('./curve');
const { KEYS, defaults } = require('./fields');

const MIN_TICK_SECONDS = 30;
const MAX_TICK_SECONDS = 1800;
const DEFAULT_TICK_SECONDS = 300;

// Per-Bereich runtime: holds member resolution, capability subscriptions,
// apply timer, and lamp-write state for one configured zone.
class ZoneRuntime {
  constructor(controller, bereichId) {
    this._c = controller;
    this.bereichId = bereichId;

    this._members = [];
    this._memberCandidates = [];
    this._homeyZoneName = null;
    this._memberUnsubs = new Map();
    this._lastApplied = new Map();
    this._pausedDevices = new Set();
    this._writingUntil = new Map();

    this._timer = null;
    this._tickInterval = DEFAULT_TICK_SECONDS * 1000;
    this._applying = false;
    this._pendingOpts = null;
  }

  // Convenience getters that always read live config out of settings, so
  // a setting write is immediately reflected without runtime reloads.
  _config() {
    const zones = this._c.homey.settings.get('zones') || {};
    return zones[this.bereichId] || {};
  }

  getMode() {
    return this._config().mode || 'day';
  }

  getName() {
    return this._homeyZoneName || this.bereichId;
  }

  getMemberCandidates() {
    return [...this._memberCandidates];
  }

  getCurrentValues(opts = {}) {
    let lat, lon;
    try {
      lat = this._c.homey.geolocation.getLatitude();
      lon = this._c.homey.geolocation.getLongitude();
    } catch (_) {}
    const mode = opts.modeOverride ?? this.getMode();
    const v = this._resolveValues();
    return computeAdaptive({
      lat, lon, now: new Date(),
      day: { kelvinMin: v.dayKelvinMin, kelvinMax: v.dayKelvinMax, dimMin: v.dayDimMin, dimMax: v.dayDimMax },
      night: { kelvin: v.nightKelvin, dim: v.nightDim, color: v.nightColor },
      transitions: { sunriseOffsetMin: v.sunriseOffsetMin || 0, sunsetOffsetMin: v.sunsetOffsetMin || 0 },
      nightMode: mode === 'night',
    });
  }

  hasMemberId(id) {
    return this._members.some(m => m.id === id);
  }

  // Public hook so the presence controller can suppress the manual-change
  // detector while it writes its own dim values -- without this our
  // presence-dim would be misread as a user override and pause the lamp
  // from the adaptive tick after motion returns.
  markWriting(deviceId, durationMs) {
    this._writingUntil.set(deviceId, Date.now() + Math.max(durationMs, 1000));
  }

  // Resolve effective curve values: built-in default < group < per-zone override.
  _resolveValues() {
    const out = defaults();
    const cfg = this._config();
    const groups = this._c.homey.settings.get('groups') || {};
    const group = groups[cfg.groupId || 'default'] || groups.default || {};
    for (const key of KEYS) if (group[key] != null) out[key] = group[key];
    if (group.nightColor) out.nightColor = group.nightColor;
    const overrides = cfg.overrides || {};
    for (const key of KEYS) if (overrides[key] != null) out[key] = overrides[key];
    if (overrides.nightColor) out.nightColor = overrides.nightColor;
    return out;
  }

  _trace(msg) {
    this._c._trace(`[${this.getName()}] ${msg}`);
  }

  // ----- lifecycle -----

  async start() {
    await this._refreshMembers().catch(err => this._trace(`refreshMembers failed: ${err.message}`));
    this._startTick();
    this._trace('runtime started');
  }

  async stop() {
    this._stopTick();
    this._unsubscribeAll();
    this._lastApplied.clear();
    this._pausedDevices.clear();
    this._writingUntil.clear();
    this._members = [];
    this._memberCandidates = [];
    this._trace('runtime stopped');
  }

  // Called when the user changes settings for this Bereich (group, overrides,
  // exclusions) or the mode. Refreshes members if exclusions changed and
  // kicks off an immediate apply.
  async reload(reason = 'reload') {
    this._pausedDevices.clear();
    await this._refreshMembers().catch(err => this._trace(`refresh failed: ${err.message}`));
    this._applyNow().catch(err => this._trace(`${reason} apply failed: ${err.message}`));
  }

  async setMode(mode) {
    if (!['off', 'day', 'night'].includes(mode)) {
      throw new Error(`unknown mode: ${mode}`);
    }
    const prev = this.getMode();
    this._c._writeZoneField(this.bereichId, 'mode', mode);
    this._pausedDevices.clear();
    this._trace(`mode -> ${mode}`);
    await this._applyNow({ modeOverride: mode, durationMs: 3000 })
      .catch(err => this._trace(`apply (mode change) failed: ${err.message}`));
    // Notify the trigger card only on actual transitions, not on no-op
    // re-applies of the same mode (e.g. when widget polling overlaps).
    if (prev !== mode && typeof this._c._app.fireModeChanged === 'function') {
      this._c._app.fireModeChanged(this.bereichId, mode, this);
    }
  }

  // ----- membership -----

  async _refreshMembers() {
    const { devices: allDevices, zones: allZones } = await this._c._app.getDevicesAndZones();

    if (!allZones[this.bereichId]) {
      this._unsubscribeAll();
      this._cleanupMemberState(new Set());
      this._members = [];
      this._memberCandidates = [];
      this._homeyZoneName = null;
      this._trace('Bereich no longer exists -> 0 members');
      return;
    }

    this._homeyZoneName = allZones[this.bereichId]?.name || null;

    // Hand-off: any child Bereich that has its OWN configured Lumina-Zone
    // is excluded from our recursion, so outer (e.g. "Wohnbereich") and
    // inner (e.g. "Flur Oben") configs don't fight over the same lamps.
    const otherConfiguredBereiche = new Set(this._c._runtimes.keys());
    otherConfiguredBereiche.delete(this.bereichId);

    const zoneSet = new Set();
    const collect = (zid) => {
      if (zoneSet.has(zid)) return;
      zoneSet.add(zid);
      for (const z of Object.values(allZones)) {
        if (z.parent !== zid) continue;
        if (otherConfiguredBereiche.has(z.id)) continue;
        collect(z.id);
      }
    };
    collect(this.bereichId);

    // Prefer "Group" virtual-driver devices over their individual lamp
    // members -- one write hits the bridge, not N writes hitting the mesh.
    const GROUP_DRIVER_ID = 'homey:virtualdrivergroup:driver';
    const groupChildren = new Set();
    const groupDevs = [];
    for (const d of Object.values(allDevices)) {
      if (!zoneSet.has(d.zone)) continue;
      if (d.driverId !== GROUP_DRIVER_ID) continue;
      if (!(d.capabilities || []).includes('dim')) continue;
      groupDevs.push(d);
      for (const id of (d.settings?.deviceIds || [])) groupChildren.add(id);
    }

    const memberIds = new Set(groupDevs.map(d => d.id));
    for (const d of Object.values(allDevices)) {
      if (!zoneSet.has(d.zone)) continue;
      if (d.driverId === GROUP_DRIVER_ID) continue;
      if (groupChildren.has(d.id)) continue;
      if (d.class === 'light' || (d.capabilities || []).includes('dim')) {
        memberIds.add(d.id);
      }
    }

    const excluded = new Set(this._config().excludedLights || []);
    const activeIds = new Set();
    this._memberCandidates = [];

    this._unsubscribeAll();
    this._members = [];
    for (const id of memberIds) {
      const dev = allDevices[id];
      if (!dev) continue;
      this._memberCandidates.push({ id, name: dev.name || id });
      if (excluded.has(id)) continue;
      activeIds.add(id);
      this._members.push(dev);
      this._subscribeMember(dev);
    }
    this._cleanupMemberState(activeIds);
    this._trace(`zone=${this._homeyZoneName || this.bereichId} -> ${this._members.length}/${this._memberCandidates.length} members (${excluded.size} excluded)`);
  }

  _cleanupMemberState(validIds) {
    for (const id of this._lastApplied.keys()) {
      if (!validIds.has(id)) this._lastApplied.delete(id);
    }
    for (const id of this._writingUntil.keys()) {
      if (!validIds.has(id)) this._writingUntil.delete(id);
    }
    for (const id of this._pausedDevices) {
      if (!validIds.has(id)) this._pausedDevices.delete(id);
    }
  }

  _subscribeMember(dev) {
    const onOnoff = async (value) => {
      try {
        if (value === true) {
          this._pausedDevices.delete(dev.id);
          await this._applyToDevice(dev, 0, this.getCurrentValues(), {
            assumeOn: true,
            tempDurationMs: 800,
          });
        } else if (value === false) {
          this._pausedDevices.delete(dev.id);
          this._lastApplied.delete(dev.id);
        }
      } catch (err) {
        this._trace(`onoff handler failed for ${dev.name}: ${err.message}`);
      }
    };
    const onDim = async (value) => this._detectManualChange(dev.id, 'dim', value);
    const onTemp = async (value) => this._detectManualChange(dev.id, 'light_temperature', value);

    const instances = [];
    try {
      const i1 = dev.makeCapabilityInstance?.('onoff', onOnoff);
      if (i1) instances.push(i1);
      if ((dev.capabilities || []).includes('dim')) {
        const i2 = dev.makeCapabilityInstance?.('dim', onDim);
        if (i2) instances.push(i2);
      }
      if ((dev.capabilities || []).includes('light_temperature')) {
        const i3 = dev.makeCapabilityInstance?.('light_temperature', onTemp);
        if (i3) instances.push(i3);
      }
    } catch (err) {
      this._trace(`subscribe failed for ${dev.name}: ${err.message}`);
    }

    this._memberUnsubs.set(dev.id, () => {
      for (const inst of instances) {
        try { inst.destroy?.(); } catch (_) {}
      }
    });
  }

  _detectManualChange(deviceId, capId, value) {
    if (this._c.homey.settings.get('respectManualChanges') === false) return;
    const writingUntil = this._writingUntil.get(deviceId) || 0;
    if (Date.now() < writingUntil) return;
    const expected = this._lastApplied.get(deviceId);
    if (!expected) return;
    if (capId === 'dim') {
      const expectedDim = expected.dimPct / 100;
      if (Math.abs(value - expectedDim) > 0.02) this._pausedDevices.add(deviceId);
    } else if (capId === 'light_temperature') {
      if (expected.color) return;
      const expectedTemp = kelvinToLightTemperature(expected.kelvin);
      if (Math.abs(value - expectedTemp) > 0.02) this._pausedDevices.add(deviceId);
    }
  }

  _unsubscribeAll() {
    for (const fn of this._memberUnsubs.values()) {
      try { fn(); } catch (_) {}
    }
    this._memberUnsubs.clear();
  }

  // ----- tick -----

  _startTick() {
    const sec = Number(this._c.homey.settings.get('tickSeconds'));
    const safe = Number.isFinite(sec) && sec >= MIN_TICK_SECONDS && sec <= MAX_TICK_SECONDS ? sec : DEFAULT_TICK_SECONDS;
    this._tickInterval = safe * 1000;
    this._timer = setInterval(() => this._applyNow().catch(err => this._trace(`tick failed: ${err.message}`)),
      this._tickInterval);
    this._applyNow().catch(err => this._trace(`initial apply failed: ${err.message}`));
  }

  _stopTick() {
    if (this._timer) { clearInterval(this._timer); this._timer = null; }
  }

  restartTick() {
    this._stopTick();
    this._startTick();
  }

  async _applyNow(opts = {}) {
    if (this._applying) {
      this._pendingOpts = opts;
      return;
    }
    this._applying = true;
    let currentOpts = opts;
    try {
      do {
        this._pendingOpts = null;
        await this._applyOnce(currentOpts);
        currentOpts = this._pendingOpts;
      } while (currentOpts);
    } finally {
      this._applying = false;
    }
  }

  async _applyOnce(opts) {
    const mode = opts.modeOverride ?? this.getMode();
    if (mode === 'off') {
      this._trace('applyNow skipped (mode=off)');
      return;
    }

    const v = this.getCurrentValues(opts);
    this._trace(`apply: elev=${v.elevationDeg?.toFixed?.(1) ?? '-'}° -> ${v.kelvin}K / ${v.dimPct}% night=${v.isNight} members=${this._members.length}`);

    const duration = opts.durationMs ?? this._tickInterval ?? 300000;
    const results = await Promise.all(this._members.map(dev =>
      this._applyToDevice(dev, duration, v).catch(err => {
        this._trace(`apply to ${dev.name} failed: ${err.message}`);
        return null;
      })
    ));
    let sentCount = 0, onCount = 0, skipCount = 0;
    for (const r of results) {
      if (r === 'sent') { sentCount++; onCount++; }
      else if (r === 'paused') onCount++;
      else if (r === 'unchanged') { onCount++; skipCount++; }
    }
    this._trace(`applied to ${sentCount}/${this._members.length} (on: ${onCount}, skipped-unchanged: ${skipCount})`);
  }

  async _applyToDevice(dev, durationMs, v, opts = {}) {
    if (this._pausedDevices.has(dev.id)) return 'paused';
    const isOn = opts.assumeOn === true ? true : dev.capabilitiesObj?.onoff?.value;
    if (isOn !== true) return 'off';

    // Per-lamp tuning: scale dim and shift kelvin off the computed values.
    // Lets users compensate for relative brightness mismatches across lamps
    // (e.g. the ceiling lamp is twice as bright as the bedside table at the
    // same percentage). Clamped to capability ranges so an aggressive scale
    // can't push a value out of bounds.
    const tuning = this._config().lampOverrides?.[dev.id] || {};
    const scale = typeof tuning.dimScale === 'number' ? tuning.dimScale : 1;
    const offsetK = typeof tuning.tempOffsetK === 'number' ? tuning.tempOffsetK : 0;
    const effDimPct = Math.max(1, Math.min(100, Math.round(v.dimPct * scale)));
    const effKelvin = Math.max(1500, Math.min(6500, Math.round(v.kelvin + offsetK)));

    const dimVal = effDimPct / 100;
    const caps = dev.capabilities || [];
    const dimDur = opts.dimDurationMs ?? durationMs;
    const tempDur = opts.tempDurationMs ?? durationMs;
    const dimOpts = dimDur > 0 ? { duration: dimDur } : {};
    const tempOpts = tempDur > 0 ? { duration: tempDur } : {};

    const useColor = !!(v.color && caps.includes('light_hue') && caps.includes('light_saturation'));
    const newColor = useColor ? (v.colorHex || null) : null;

    // Compare against the effective values we computed for THIS lamp so the
    // unchanged-check stays correct when only the tuning changed.
    const last = this._lastApplied.get(dev.id);
    if (last
        && last.kelvin === effKelvin
        && last.dimPct === effDimPct
        && last.color === newColor) {
      return 'unchanged';
    }

    this._writingUntil.set(dev.id, Date.now() + Math.max(dimDur, tempDur, 1000) + 2000);

    const api = await this._c._app.getApi();
    const writes = [];
    // Explicit light_mode toggle forces the lamp out of whichever mode it was
    // in. Without this many Zigbee bulbs keep their previous hue/sat state
    // when we only write light_temperature -- the user then sees "night
    // colour" persist into day mode.
    if (caps.includes('light_mode')) {
      writes.push(api.devices.setCapabilityValue({
        deviceId: dev.id, capabilityId: 'light_mode', value: useColor ? 'color' : 'temperature',
      }));
    }
    if (useColor) {
      writes.push(api.devices.setCapabilityValue({
        deviceId: dev.id, capabilityId: 'light_hue', value: v.color.hue, opts: tempOpts,
      }));
      writes.push(api.devices.setCapabilityValue({
        deviceId: dev.id, capabilityId: 'light_saturation', value: v.color.sat, opts: tempOpts,
      }));
    } else if (caps.includes('light_temperature')) {
      writes.push(api.devices.setCapabilityValue({
        deviceId: dev.id, capabilityId: 'light_temperature', value: kelvinToLightTemperature(effKelvin), opts: tempOpts,
      }));
    }
    if (caps.includes('dim')) {
      writes.push(api.devices.setCapabilityValue({
        deviceId: dev.id, capabilityId: 'dim', value: dimVal, opts: dimOpts,
      }));
    }
    await Promise.all(writes);
    this._lastApplied.set(dev.id, {
      kelvin: effKelvin,
      dimPct: effDimPct,
      color: newColor,
    });
    return 'sent';
  }
}

// Controller: owns the lifecycle of all ZoneRuntimes and reacts to settings
// changes. Single instance per app.
class ZonesController {
  constructor(app) {
    this._app = app;
    this.homey = app.homey;
    this._runtimes = new Map(); // bereichId -> ZoneRuntime
    this._settingsDebounce = null;
  }

  _trace(msg) {
    this._app.trace(`zones: ${msg}`);
  }

  async start() {
    // Bring up one runtime per configured Bereich.
    const zones = this.homey.settings.get('zones') || {};
    for (const bereichId of Object.keys(zones)) {
      await this._addRuntime(bereichId);
    }

    this._onSettingChange = (key) => {
      if (key === 'tickSeconds') {
        this._trace('tickSeconds changed -> restart all ticks');
        for (const rt of this._runtimes.values()) rt.restartTick();
        return;
      }
      if (key !== 'zones' && key !== 'groups') return;
      // Multiple settings writes within one event-loop tick (e.g. saving the
      // group editor that touches several keys) would otherwise trigger
      // redundant reloads. Debounce + diff.
      if (this._settingsDebounce) clearTimeout(this._settingsDebounce);
      this._settingsDebounce = setTimeout(() => {
        this._settingsDebounce = null;
        this._reconcile().catch(err => this._trace(`reconcile failed: ${err.message}`));
      }, 250);
    };
    this.homey.settings.on('set', this._onSettingChange);

    this._trace(`started with ${this._runtimes.size} runtime(s)`);
  }

  async stop() {
    if (this._onSettingChange) {
      this.homey.settings.removeListener('set', this._onSettingChange);
      this._onSettingChange = null;
    }
    if (this._settingsDebounce) {
      clearTimeout(this._settingsDebounce);
      this._settingsDebounce = null;
    }
    for (const rt of this._runtimes.values()) {
      await rt.stop().catch(() => {});
    }
    this._runtimes.clear();
  }

  // Reconcile in-memory runtimes against the persisted zones config: spin up
  // new ones, tear down removed ones, reload changed ones.
  async _reconcile() {
    const zones = this.homey.settings.get('zones') || {};
    const wanted = new Set(Object.keys(zones));

    // Remove runtimes whose Bereich was deleted.
    for (const bereichId of [...this._runtimes.keys()]) {
      if (!wanted.has(bereichId)) {
        const rt = this._runtimes.get(bereichId);
        await rt.stop().catch(() => {});
        this._runtimes.delete(bereichId);
      }
    }
    // Add runtimes for new Bereiche.
    for (const bereichId of wanted) {
      if (!this._runtimes.has(bereichId)) {
        await this._addRuntime(bereichId);
      } else {
        // Existing runtime: nudge it to re-resolve in case its config changed.
        await this._runtimes.get(bereichId).reload('settings change').catch(() => {});
      }
    }
  }

  async _addRuntime(bereichId) {
    const rt = new ZoneRuntime(this, bereichId);
    this._runtimes.set(bereichId, rt);
    await rt.start();
    return rt;
  }

  // ----- public accessors -----

  getRuntime(bereichId) {
    return this._runtimes.get(bereichId) || null;
  }

  listRuntimes() {
    return [...this._runtimes.values()];
  }

  // Find the runtime that controls the given foreign light id.
  findRuntimeForLight(lightId) {
    for (const rt of this._runtimes.values()) {
      if (rt.hasMemberId(lightId)) return rt;
    }
    return null;
  }

  // ----- config writers (called by the API layer) -----

  // Merges a partial update into the zone's stored config. Returns the new
  // config object. Triggers a reload if structural fields changed.
  async upsertZone(bereichId, patch) {
    const zones = { ...(this.homey.settings.get('zones') || {}) };
    const prev = zones[bereichId] || {};
    const next = { ...prev };

    if (Object.prototype.hasOwnProperty.call(patch, 'groupId')) {
      next.groupId = patch.groupId || 'default';
    }
    if (Object.prototype.hasOwnProperty.call(patch, 'overrides')) {
      next.overrides = this._cleanOverrides(patch.overrides, next.groupId || 'default');
    }
    if (Object.prototype.hasOwnProperty.call(patch, 'excludedLights')) {
      next.excludedLights = [...new Set((patch.excludedLights || []).filter(x => typeof x === 'string'))];
    }
    if (Object.prototype.hasOwnProperty.call(patch, 'lampOverrides')) {
      next.lampOverrides = this._cleanLampOverrides(patch.lampOverrides);
    }
    if (Object.prototype.hasOwnProperty.call(patch, 'mode')) {
      if (!['off', 'day', 'night'].includes(patch.mode)) throw new Error(`unknown mode: ${patch.mode}`);
      next.mode = patch.mode;
    }
    if (!next.mode) next.mode = 'day';
    if (!next.groupId) next.groupId = 'default';
    if (!next.overrides) next.overrides = {};
    if (!next.excludedLights) next.excludedLights = [];
    if (!next.lampOverrides) next.lampOverrides = {};

    zones[bereichId] = next;
    this.homey.settings.set('zones', zones);

    // Make sure a runtime exists for this Bereich; reconcile will pick it up
    // anyway via the settings listener, but doing it here gives synchronous
    // semantics for the caller.
    let rt = this._runtimes.get(bereichId);
    if (!rt) {
      rt = await this._addRuntime(bereichId);
    } else {
      await rt.reload('upsert').catch(() => {});
    }
    return next;
  }

  async removeZone(bereichId) {
    const zones = { ...(this.homey.settings.get('zones') || {}) };
    if (!zones[bereichId]) return false;
    delete zones[bereichId];
    this.homey.settings.set('zones', zones);
    const rt = this._runtimes.get(bereichId);
    if (rt) {
      await rt.stop().catch(() => {});
      this._runtimes.delete(bereichId);
    }
    return true;
  }

  _cleanOverrides(raw, groupId) {
    if (!raw || typeof raw !== 'object') return {};
    const groups = this.homey.settings.get('groups') || {};
    const group = groups[groupId] || {};
    const out = {};
    for (const [k, v] of Object.entries(raw)) {
      if (k === 'nightColor') {
        if (typeof v !== 'string' || !/^#[0-9a-f]{6}$/i.test(v)) continue;
        const norm = v.toLowerCase();
        if ((group.nightColor || '').toLowerCase() === norm) continue;
        out[k] = norm;
        continue;
      }
      const n = Number(v);
      if (!Number.isFinite(n)) continue;
      if (group[k] != null && n === group[k]) continue;
      out[k] = n;
    }
    return out;
  }

  // Normalises per-lamp tuning input from the settings UI: drops invalid
  // numbers, drops entries that are effectively "default" (scale=1, offset=0)
  // so the stored object stays compact and audit-friendly.
  _cleanLampOverrides(raw) {
    if (!raw || typeof raw !== 'object') return {};
    const out = {};
    for (const [lampId, cfg] of Object.entries(raw)) {
      if (!lampId || typeof cfg !== 'object' || cfg == null) continue;
      const entry = {};
      const scale = Number(cfg.dimScale);
      if (Number.isFinite(scale) && scale > 0 && scale !== 1 && scale <= 2) {
        entry.dimScale = Number(scale.toFixed(3));
      }
      const offset = Number(cfg.tempOffsetK);
      if (Number.isFinite(offset) && offset !== 0 && Math.abs(offset) <= 3000) {
        entry.tempOffsetK = Math.round(offset);
      }
      if (Object.keys(entry).length > 0) out[lampId] = entry;
    }
    return out;
  }

  // Direct setter used by ZoneRuntime.setMode -- bypasses the upsert validate
  // path so the runtime doesn't trigger a reload of itself.
  _writeZoneField(bereichId, key, value) {
    const zones = { ...(this.homey.settings.get('zones') || {}) };
    const prev = zones[bereichId] || {};
    zones[bereichId] = { ...prev, [key]: value };
    this.homey.settings.set('zones', zones);
  }
}

module.exports = { ZonesController, ZoneRuntime };
