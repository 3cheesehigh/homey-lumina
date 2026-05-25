'use strict';

const Homey = require('homey');
const { computeAdaptive, kelvinToLightTemperature } = require('../../lib/curve');
const { FIELDS, KEYS, defaults } = require('../../lib/fields');

const ZONE_DRIVER_ID = 'homey:app:de.cqnc.lumina:zone';
const GROUP_DRIVER_ID = 'homey:virtualdrivergroup:driver';

class ZoneDevice extends Homey.Device {

  async onInit() {
    const name = this.getName();
    this._trace = (msg) => {
      try { this.homey.app.trace(`[${name}] ${msg}`); } catch (e) {}
    };
    this._trace('onInit: start');

    try {
      this._api = await this.homey.app.getApi();
    } catch (err) {
      this._trace(`HomeyAPI failed: ${err.message}`);
      return;
    }

    // Member-state maps -- kept in sync with this._members in _refreshMembers
    // so they don't grow unbounded across zone moves / device removals.
    this._memberUnsubs = new Map(); // deviceId -> unsubscribe fn
    this._lastApplied = new Map();  // deviceId -> { kelvin, dimPct }
    this._pausedDevices = new Set();
    this._writingUntil = new Map(); // deviceId -> epoch ms cutoff
    this._timer = null;
    this._members = [];

    // Re-entrancy / overlap protection on _applyNow. If a tick is in flight
    // when another fires, the new opts get coalesced and applied immediately
    // after the current run finishes. Last opts win.
    this._applying = false;
    this._pendingOpts = null;

    // Live-binding migration (legacy settings -> store.overrides).
    // Runs at most once per device: the marker is stored after a successful
    // pass so subsequent boots skip the work entirely.
    const MIGRATION_VERSION = 1;
    if ((this.getStoreValue('migrationVersion') || 0) < MIGRATION_VERSION) {
      try {
        const s = this.getSettings() || {};
        let groupId = this.getStoreValue('groupId');
        if (!groupId && s.groupId) {
          groupId = s.groupId;
          this._trace(`migrated legacy groupId from settings -> store: ${groupId}`);
        }
        if (!groupId) groupId = 'default';
        await this.setStoreValue('groupId', groupId);

        // Build the override set from any leftover settings values. A value
        // counts as an "override" only if it differs from the group's value
        // — equal values are treated as inherited.
        const groups = this.homey.settings.get('groups') || {};
        const group = groups[groupId] || groups.default || {};
        const overrides = (this.getStoreValue('overrides') && typeof this.getStoreValue('overrides') === 'object')
          ? { ...this.getStoreValue('overrides') } : {};
        let migrated = 0;
        for (const k of KEYS) {
          if (s[k] != null && overrides[k] == null) {
            if (group[k] != null && s[k] !== group[k]) {
              overrides[k] = s[k];
              migrated++;
            }
          }
        }
        if (migrated > 0) {
          await this.setStoreValue('overrides', overrides);
          this._trace(`migrated ${migrated} legacy settings -> overrides`);
        }
        await this.setStoreValue('migrationVersion', MIGRATION_VERSION);
      } catch (err) {
        this._trace(`migration failed: ${err.message}`);
      }
    }

    if (this.getCapabilityValue('adaptive_mode') == null) {
      await this.setCapabilityValue('adaptive_mode', 'day').catch(() => {});
    }
    if (!this.hasCapability('measure_sun_elevation')) {
      await this.addCapability('measure_sun_elevation').catch(() => {});
    }

    this.registerCapabilityListener('adaptive_mode', async (value) => {
      this._trace(`adaptive_mode -> ${value}`);
      this._pausedDevices.clear();
      // Fire and forget -- 30+ lamp writes can take more than Homey's 10 s
      // capability-listener timeout. Apply in the background.
      this._applyNow({ modeOverride: value, durationMs: 3000 })
        .catch(err => this._trace(`apply (mode change) failed: ${err.message}`));
    });

    await this._refreshMembers().catch(err => this._trace(`refreshMembers failed: ${err.message}`));
    this._startTick();

    // Snapshot the values we'd compute right now so the settings listener can
    // tell whether a 'groups' write actually changed anything that matters
    // for this zone.
    this._lastResolvedSnapshot = this._resolveSnapshot();
    this._settingsDebounce = null;

    this._onAppSettingChange = (key) => {
      if (key === 'tickSeconds') {
        this._trace('tickSeconds changed -> restart tick');
        this._restartTick();
        return;
      }
      if (key !== 'groups') return;
      // Saving a group in the settings UI rewrites the entire `groups`
      // object, which fires this listener synchronously for every zone in
      // the same event-loop tick. Without a debounce + diff, N zones × M
      // member lamps = a write storm for what was logically a single edit.
      if (this._settingsDebounce) clearTimeout(this._settingsDebounce);
      this._settingsDebounce = setTimeout(() => {
        this._settingsDebounce = null;
        const next = this._resolveSnapshot();
        if (next === this._lastResolvedSnapshot) {
          this._trace('groups changed but resolved values unchanged -> skip');
          return;
        }
        this._lastResolvedSnapshot = next;
        this._trace('groups changed -> re-apply');
        this._applyNow().catch(err => this._trace(`apply after groups change failed: ${err.message}`));
      }, 250);
    };
    this.homey.settings.on('set', this._onAppSettingChange);

    this._trace('onInit: done');
  }

  async onDeleted() {
    await this._cleanup();
  }

  // Called by Homey when the app is being unloaded (e.g. on code reload during
  // dev). Without this the settings listener + tick timer would survive across
  // reloads and accumulate — a real leak that bites you after a few iterations.
  async onUninit() {
    await this._cleanup();
  }

  async _cleanup() {
    this._stopTick();
    this._unsubscribeAll();
    if (this._onAppSettingChange) {
      this.homey.settings.removeListener('set', this._onAppSettingChange);
      this._onAppSettingChange = null;
    }
    if (this._settingsDebounce) {
      clearTimeout(this._settingsDebounce);
      this._settingsDebounce = null;
    }
    // Drop all per-device state references so the GC can reclaim them even
    // if a Homey-side reference to this Device instance lingers.
    this._lastApplied?.clear();
    this._pausedDevices?.clear();
    this._writingUntil?.clear();
    this._members = [];
  }

  async onSettings({ changedKeys }) {
    this._trace(`settings changed: ${(changedKeys || []).join(',')}`);
    this._pausedDevices.clear();
    setImmediate(async () => {
      await this._refreshMembers().catch(() => {});
      await this._applyNow().catch(() => {});
    });
  }

  // ----- value resolution -----

  // Compact JSON snapshot of the resolved values, used to cheaply decide
  // whether a 'groups' settings change actually affects this zone (vs. e.g.
  // a save that only touched a different group).
  _resolveSnapshot() {
    return JSON.stringify(this._resolveValues());
  }

  _resolveValues() {
    // Live binding: group defines values, zone-level overrides win per key.
    //   value = override ?? group ?? built-in default
    // Changing a group's value propagates to every zone that doesn't have an
    // explicit override for that key.
    const out = defaults();
    const groups = this.homey.settings.get('groups') || {};
    const groupId = this.getStoreValue('groupId') || 'default';
    const group = groups[groupId] || groups.default || {};
    for (const key of KEYS) if (group[key] != null) out[key] = group[key];
    // nightColor lives outside the numeric KEYS list because it's an
    // optional hex string. Merged with the same precedence as the numeric
    // values: group < override.
    if (group.nightColor) out.nightColor = group.nightColor;
    const overrides = this.getStoreValue('overrides') || {};
    for (const key of KEYS) if (overrides[key] != null) out[key] = overrides[key];
    if (overrides.nightColor) out.nightColor = overrides.nightColor;
    return out;
  }

  // Public accessor for the driver's smart-on flow card.
  getCurrentValues() {
    return this._currentValues();
  }

  // Returns true if the given foreign-device id is one of this zone's
  // resolved members. Used by the smart-on card to pick the right zone.
  hasMemberId(id) {
    return (this._members || []).some(m => m.id === id);
  }

  _currentValues(opts = {}) {
    let lat, lon;
    try {
      lat = this.homey.geolocation.getLatitude();
      lon = this.homey.geolocation.getLongitude();
    } catch (_) {}
    const mode = opts.modeOverride ?? this.getCapabilityValue('adaptive_mode') ?? 'day';
    const v = this._resolveValues();
    return computeAdaptive({
      lat, lon, now: new Date(),
      day: { kelvinMin: v.dayKelvinMin, kelvinMax: v.dayKelvinMax, dimMin: v.dayDimMin, dimMax: v.dayDimMax },
      night: { kelvin: v.nightKelvin, dim: v.nightDim, color: v.nightColor },
      nightMode: mode === 'night',
    });
  }

  // ----- membership (driven by the Homey-zone this device sits in) -----

  async _refreshMembers() {
    const { devices: allDevices, zones: allZones } = await this.homey.app.getDevicesAndZones();

    const myDataId = this.getData().id;
    let myself = Object.values(allDevices).find(d =>
      d.driverId === ZONE_DRIVER_ID && d.data?.id === myDataId
    );
    if (!myself) {
      const myName = this.getName();
      myself = Object.values(allDevices).find(d =>
        d.driverId === ZONE_DRIVER_ID && d.name === myName
      );
    }
    const myZoneId = myself?.zone;

    if (!myZoneId) {
      this._unsubscribeAll();
      this._cleanupMemberState(new Set());
      this._members = [];
      this._trace('no Homey-zone resolved -> 0 members');
      return;
    }

    // Hand-off: any child Homey-zone that already has its own Lumina-Zone
    // device is excluded from our recursion. Otherwise an outer zone (e.g.
    // "Wohnbereich") and an inner zone (e.g. "Flur Oben") would both claim
    // the inner zone's lamps as members and fight over them on every apply.
    const otherLuminaHomeyZones = new Set();
    for (const d of Object.values(allDevices)) {
      if (d.driverId !== ZONE_DRIVER_ID) continue;
      if (d.data?.id === myDataId) continue;
      if (d.zone) otherLuminaHomeyZones.add(d.zone);
    }

    const zoneSet = new Set();
    const collect = (zid) => {
      if (zoneSet.has(zid)) return;
      zoneSet.add(zid);
      for (const z of Object.values(allZones)) {
        if (z.parent !== zid) continue;
        if (otherLuminaHomeyZones.has(z.id)) continue;
        collect(z.id);
      }
    };
    collect(myZoneId);

    // Prefer Homey "Group" devices over their individual member lamps --
    // writing to a group hits all members in one upstream call (Hue Bridge
    // multicast) and avoids per-lamp staggering on the Zigbee mesh.
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
      if (d.driverId === ZONE_DRIVER_ID) continue;
      if (d.driverId === GROUP_DRIVER_ID) continue;
      if (groupChildren.has(d.id)) continue;
      if (d.class === 'light' || (d.capabilities || []).includes('dim')) {
        memberIds.add(d.id);
      }
    }

    this._unsubscribeAll();
    this._members = [];
    for (const id of memberIds) {
      const dev = allDevices[id];
      if (!dev) continue;
      this._members.push(dev);
      this._subscribeMember(dev);
    }
    this._cleanupMemberState(memberIds);
    this._lastMyZoneId = myZoneId;
    this._trace(`zone=${allZones[myZoneId]?.name || myZoneId} -> ${this._members.length} members`);
  }

  _cleanupMemberState(validIds) {
    // Remove entries for devices that are no longer members so the maps don't
    // grow unbounded over months of zone moves / re-pairs.
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
          // Asymmetric turn-on: brightness snaps instantly (stops glare from
          // the old hardware-stored value), color temperature fades smoothly
          // (looks natural). Both can't be combined into one Bridge command
          // through Homey's API, so this is the next-best mitigation.
          await this._applyToDevice(dev, 0, this._currentValues(), {
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

    // Keep references to each CapabilityInstance so we can destroy them
    // individually on unsubscribe -- without this the underlying event
    // subscriptions linger and accumulate over zone moves / re-pairs.
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
    if (this.homey.settings.get('respectManualChanges') === false) return;
    const writingUntil = this._writingUntil.get(deviceId) || 0;
    if (Date.now() < writingUntil) return;
    const expected = this._lastApplied.get(deviceId);
    if (!expected) return;
    if (capId === 'dim') {
      const expectedDim = expected.dimPct / 100;
      if (Math.abs(value - expectedDim) > 0.02) this._pausedDevices.add(deviceId);
    } else if (capId === 'light_temperature') {
      // When we last wrote a color (no temperature), the lamp's CT report is
      // not driven by us -- skip the check, otherwise we'd self-pause.
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
    const sec = Number(this.homey.settings.get('tickSeconds'));
    const safe = Number.isFinite(sec) && sec >= 30 && sec <= 1800 ? sec : 300;
    this._tickInterval = safe * 1000;
    this._timer = setInterval(() => this._applyNow().catch(err => this._trace(`tick failed: ${err.message}`)),
      this._tickInterval);
    this._applyNow().catch(err => this._trace(`initial apply failed: ${err.message}`));
  }

  _stopTick() {
    if (this._timer) { clearInterval(this._timer); this._timer = null; }
  }

  _restartTick() {
    this._stopTick();
    this._startTick();
  }

  // ----- apply (serialized via _applying flag) -----

  async _applyNow(opts = {}) {
    if (this._applying) {
      // Coalesce: latest opts overwrite any earlier pending ones; the
      // in-flight call will pick them up after it finishes.
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
    const mode = opts.modeOverride ?? this.getCapabilityValue('adaptive_mode') ?? 'day';
    if (mode === 'off') {
      this._trace('applyNow skipped (mode=off)');
      return;
    }

    // Detect Homey-zone moves between ticks. Cheap because getDevicesAndZones
    // is shared/cached across the whole app.
    try {
      const { devices } = await this.homey.app.getDevicesAndZones();
      const myDataId = this.getData().id;
      const myself = Object.values(devices).find(d =>
        d.driverId === ZONE_DRIVER_ID && d.data?.id === myDataId
      );
      if (myself && myself.zone !== this._lastMyZoneId) {
        this._trace('Homey-zone changed -> refresh members');
        await this._refreshMembers();
      }
    } catch (_) {}

    const v = this._currentValues(opts);
    this._trace(`apply: elev=${v.elevationDeg?.toFixed?.(1) ?? '-'}° -> ${v.kelvin}K / ${v.dimPct}% night=${v.isNight} members=${this._members.length}`);
    await this.setCapabilityValue('adaptive_kelvin', v.kelvin).catch(() => {});
    await this.setCapabilityValue('adaptive_dim', v.dimPct).catch(() => {});
    if (this.hasCapability('measure_sun_elevation') && typeof v.elevationDeg === 'number') {
      await this.setCapabilityValue('measure_sun_elevation', Number(v.elevationDeg.toFixed(1))).catch(() => {});
    }

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

    const dimVal = v.dimPct / 100;
    const caps = dev.capabilities || [];
    // Per-capability duration overrides — used by the turn-on handler to
    // snap dim while fading temperature.
    const dimDur = opts.dimDurationMs ?? durationMs;
    const tempDur = opts.tempDurationMs ?? durationMs;
    const dimOpts = dimDur > 0 ? { duration: dimDur } : {};
    const tempOpts = tempDur > 0 ? { duration: tempDur } : {};

    // Color path is only taken when both hue + saturation are available --
    // writing hue alone leaves saturation at whatever the lamp last had,
    // which would show up as a washed-out unintended tint.
    const useColor = !!(v.color && caps.includes('light_hue') && caps.includes('light_saturation'));
    const newColor = useColor ? (v.colorHex || null) : null;

    // Skip the bridge round-trip entirely when nothing changed since our
    // last successful write. _lastApplied is cleared on off→on transitions
    // so a freshly turned-on lamp always gets the values applied.
    const last = this._lastApplied.get(dev.id);
    if (last
        && last.kelvin === v.kelvin
        && last.dimPct === v.dimPct
        && last.color === newColor) {
      return 'unchanged';
    }

    this._writingUntil.set(dev.id, Date.now() + Math.max(dimDur, tempDur, 1000) + 2000);

    // Fire all writes in parallel so they hit the bridge in the same
    // event-loop tick. Sequential awaits would visibly stagger transitions.
    const writes = [];
    if (useColor) {
      writes.push(this._api.devices.setCapabilityValue({
        deviceId: dev.id, capabilityId: 'light_hue', value: v.color.hue, opts: tempOpts,
      }));
      writes.push(this._api.devices.setCapabilityValue({
        deviceId: dev.id, capabilityId: 'light_saturation', value: v.color.sat, opts: tempOpts,
      }));
    } else if (caps.includes('light_temperature')) {
      writes.push(this._api.devices.setCapabilityValue({
        deviceId: dev.id, capabilityId: 'light_temperature', value: kelvinToLightTemperature(v.kelvin), opts: tempOpts,
      }));
    }
    if (caps.includes('dim')) {
      writes.push(this._api.devices.setCapabilityValue({
        deviceId: dev.id, capabilityId: 'dim', value: dimVal, opts: dimOpts,
      }));
    }
    await Promise.all(writes);
    this._lastApplied.set(dev.id, {
      kelvin: v.kelvin,
      dimPct: v.dimPct,
      color: newColor,
    });
    return 'sent';
  }
}

module.exports = ZoneDevice;
