'use strict';

const Homey = require('homey');
const { FIELDS, KEYS } = require('../../lib/fields');
const { computeAdaptive, kelvinToLightTemperature, buildDailyCurve } = require('../../lib/curve');

function pickValues(payload) {
  const out = {};
  if (!payload || typeof payload !== 'object') return out;
  const src = payload.overrides || {};
  for (const key of KEYS) {
    const v = src[key];
    if (v === '' || v == null) continue;
    const n = Number(v);
    if (Number.isFinite(n)) out[key] = n;
  }
  return out;
}

// In live-binding mode the device stores only the explicit overrides; the
// group is the source of truth for everything else. Filter out any "fake"
// overrides where the value equals the group's value -- those should inherit.
function trimOverrides(groups, groupId, raw) {
  const group = (groupId && groups[groupId]) || groups.default || {};
  const out = {};
  for (const k of KEYS) {
    const v = raw[k];
    if (v == null) continue;
    if (group[k] != null && v === group[k]) continue; // matches group -> inherit
    out[k] = v;
  }
  return out;
}

class ZoneDriver extends Homey.Driver {

  async onInit() {
    this.log('Lumina Zone driver initialised');
    // Reuse the App's HomeyAPI instance instead of spinning up our own.
    // Both share the 30 s devices/zones cache that way, so the autocomplete
    // listener below doesn't bypass it on every keystroke.
    try {
      this._api = await this.homey.app.getApi();
      this.homey.app.trace('driver.onInit: HomeyAPI ready');
    } catch (err) {
      this.homey.app.trace(`driver.onInit: HomeyAPI failed: ${err.message}`);
      throw err;
    }

    try {
      const card = this.homey.flow.getActionCard('set_mode');
      card.registerRunListener(async (args) => {
        const dev = args.device;
        const mode = args.mode;
        this.homey.app.trace(`flow: set_mode -> ${mode} on ${dev?.getName?.()}`);
        await dev.triggerCapabilityListener('adaptive_mode', mode);
      });
      this.homey.app.trace('driver.onInit: set_mode runListener registered');
    } catch (err) {
      this.homey.app.trace(`driver.onInit: set_mode registration failed: ${err.message}`);
    }

    try {
      const cond = this.homey.flow.getConditionCard('mode_is');
      cond.registerRunListener(async (args) => {
        const dev = args.device;
        const current = dev.getCapabilityValue('adaptive_mode');
        return current === args.mode;
      });
      this.homey.app.trace('driver.onInit: mode_is condition registered');
    } catch (err) {
      this.homey.app.trace(`driver.onInit: mode_is registration failed: ${err.message}`);
    }

    const autocompleteListener = async (query) => this._findLightTargets(query);

    try {
      const smartOn = this.homey.flow.getActionCard('smart_on');
      smartOn.registerArgumentAutocompleteListener('target', autocompleteListener);
      smartOn.registerRunListener(async (args) => {
        const target = await this._resolveLightTarget(args.target);
        this.homey.app.trace(`flow: smart_on -> ${target.name}`);
        await this._performSmartOn(target);
      });
      this.homey.app.trace('driver.onInit: smart_on action registered');
    } catch (err) {
      this.homey.app.trace(`driver.onInit: smart_on registration failed: ${err.message}`);
    }

    try {
      const smartToggle = this.homey.flow.getActionCard('smart_toggle');
      smartToggle.registerArgumentAutocompleteListener('target', autocompleteListener);
      smartToggle.registerRunListener(async (args) => {
        const target = await this._resolveLightTarget(args.target);
        const isOn = await this._api.devices.getCapabilityValue({
          deviceId: target.id, capabilityId: 'onoff',
        });
        if (isOn === true) {
          this.homey.app.trace(`flow: smart_toggle -> ${target.name} on, turning off`);
          await this._api.devices.setCapabilityValue({
            deviceId: target.id, capabilityId: 'onoff', value: false,
          });
        } else {
          this.homey.app.trace(`flow: smart_toggle -> ${target.name} off, smart-on`);
          await this._performSmartOn(target);
        }
      });
      this.homey.app.trace('driver.onInit: smart_toggle action registered');
    } catch (err) {
      this.homey.app.trace(`driver.onInit: smart_toggle registration failed: ${err.message}`);
    }

    try {
      const cycleMode = this.homey.flow.getActionCard('cycle_mode');
      cycleMode.registerRunListener(async (args) => {
        const dev = args.device;
        // Multiselect arrives as an array of selected ids; normalise the
        // user's pick into our canonical off → day → night ordering so the
        // cycle direction is predictable regardless of selection order.
        const selected = Array.isArray(args.modes) ? args.modes : [];
        const sequence = ['off', 'day', 'night'].filter((m) => selected.includes(m));
        if (sequence.length === 0) {
          throw new Error('select at least one mode to cycle through');
        }
        const current = dev.getCapabilityValue('adaptive_mode');
        const curIdx = sequence.indexOf(current);
        // If the current mode isn't in the cycle, jump to the first selected
        // mode -- otherwise advance to the next one, wrapping around.
        const nextIdx = curIdx >= 0 ? (curIdx + 1) % sequence.length : 0;
        const next = sequence[nextIdx];
        this.homey.app.trace(`flow: cycle_mode -> ${dev.getName()} ${current} -> ${next} (cycle: ${sequence.join('->')})`);
        await dev.triggerCapabilityListener('adaptive_mode', next);
      });
      this.homey.app.trace('driver.onInit: cycle_mode action registered');
    } catch (err) {
      this.homey.app.trace(`driver.onInit: cycle_mode registration failed: ${err.message}`);
    }
  }

  // Autocomplete source for smart-on / smart-toggle: any device with onoff
  // plus at least one of dim/light_temperature, excluding our own zones.
  async _findLightTargets(query) {
    const { devices: all, zones } = await this.homey.app.getDevicesAndZones();
    const q = (query || '').toLowerCase();
    const items = [];
    for (const d of Object.values(all)) {
      if (d.driverId === 'homey:app:com.3cheesehigh.lumina:zone') continue;
      const caps = d.capabilities || [];
      if (!caps.includes('onoff')) continue;
      if (!caps.includes('dim') && !caps.includes('light_temperature')) continue;
      const name = d.name || '';
      const zoneName = zones[d.zone]?.name || '';
      // Match against both name and zone name so the user can type either.
      const hay = `${name} ${zoneName}`.toLowerCase();
      if (q && !hay.includes(q)) continue;
      items.push({
        id: d.id,
        // Fold the zone into the displayed name so it's visible regardless
        // of how the Homey UI renders the description field.
        name: zoneName ? `${name} (${zoneName})` : name,
        description: zoneName,
      });
    }
    items.sort((a, b) => a.name.localeCompare(b.name));
    return items.slice(0, 50);
  }

  async _resolveLightTarget(sel) {
    if (!sel || !sel.id) throw new Error('no target chosen');
    const { devices: allDevices } = await this.homey.app.getDevicesAndZones();
    const target = allDevices[sel.id];
    if (!target) throw new Error(`target ${sel.id} not found`);
    return target;
  }

  // Off-to-on transition with adaptive values: writes dim + light_temperature
  // in one shot so the lamp wakes at the right state instead of flashing the
  // last stored value. Modern bulbs treat a dim write while off as power-on
  // at that level, so we don't need to send onoff=true separately.
  async _performSmartOn(target) {
    let zoneDev = null;
    for (const z of this.getDevices()) {
      if (z.hasMemberId && z.hasMemberId(target.id)) { zoneDev = z; break; }
    }
    const v = zoneDev ? zoneDev.getCurrentValues() : this._defaultValues();
    if (!v) throw new Error('no adaptive values available (no default group?)');

    this.homey.app.trace(`smart-on writes -> ${target.name} via zone=${zoneDev?.getName() ?? 'default'} -> ${v.kelvin}K / ${v.dimPct}%`);

    const caps = target.capabilities || [];
    const writes = [];
    if (caps.includes('dim')) {
      writes.push(this._api.devices.setCapabilityValue({
        deviceId: target.id, capabilityId: 'dim', value: v.dimPct / 100,
      }));
    }
    if (caps.includes('light_temperature')) {
      writes.push(this._api.devices.setCapabilityValue({
        deviceId: target.id, capabilityId: 'light_temperature',
        value: kelvinToLightTemperature(v.kelvin),
      }));
    }
    await Promise.all(writes);
  }

  _computeCurveForUI(payload) {
    const day = payload?.day;
    const night = payload?.night;
    if (!day || !night) return null;
    return buildDailyCurve({ homey: this.homey, day, night });
  }

  // Fallback for the smart-on card when the target light isn't a member of
  // any Lumina Zone -- compute the current adaptive values from the default
  // group + Homey's geolocation.
  _defaultValues() {
    const groups = this.homey.settings.get('groups') || {};
    const g = groups.default;
    if (!g) return null;
    let lat, lon;
    try {
      lat = this.homey.geolocation.getLatitude();
      lon = this.homey.geolocation.getLongitude();
    } catch (_) {}
    return computeAdaptive({
      lat, lon, now: new Date(),
      day: { kelvinMin: g.dayKelvinMin, kelvinMax: g.dayKelvinMax, dimMin: g.dayDimMin, dimMax: g.dayDimMax },
      night: { kelvin: g.nightKelvin, dim: g.nightDim },
      nightMode: false,
    });
  }

  async onPair(session) {
    this.homey.app.trace('driver.onPair: session opened');

    const draft = { name: '', groupId: 'default', overrides: {} };

    session.setHandler('list_groups', async () => this.homey.settings.get('groups') || {});
    session.setHandler('list_fields', async () => FIELDS);
    session.setHandler('compute_curve', async (payload) => this._computeCurveForUI(payload));

    session.setHandler('save_draft', async (payload) => {
      this.homey.app.trace(`pair: save_draft -- name=${payload?.name}, group=${payload?.groupId || '-'}`);
      if (!payload || typeof payload !== 'object') return false;
      draft.name = (payload.name || '').toString().trim();
      draft.groupId = (payload.groupId || '').toString();
      draft.overrides = pickValues(payload);
      return true;
    });

    session.setHandler('list_devices', async () => {
      const groups = this.homey.settings.get('groups') || {};
      const overrides = trimOverrides(groups, draft.groupId, draft.overrides);
      this.homey.app.trace(`pair: list_devices -- name=${draft.name}, group=${draft.groupId}, overrides=${Object.keys(overrides).length}`);
      return [{
        name: draft.name || 'Lumina Zone',
        data: { id: `zone-${Date.now()}-${Math.random().toString(36).slice(2, 8)}` },
        store: { groupId: draft.groupId || 'default', overrides },
      }];
    });

    session.setHandler('showView', async (viewId) => {
      this.homey.app.trace(`pair: view -> ${viewId}`);
    });
    session.setHandler('disconnect', async () => {
      this.homey.app.trace('pair: session closed');
    });
    session.setHandler('get_initial', async () => null);
  }

  async onRepair(session, device) {
    this.homey.app.trace(`driver.onRepair: ${device.getName()}`);

    session.setHandler('list_groups', async () => this.homey.settings.get('groups') || {});
    session.setHandler('list_fields', async () => FIELDS);
    session.setHandler('compute_curve', async (payload) => this._computeCurveForUI(payload));

    session.setHandler('get_initial', async () => {
      const overrides = device.getStoreValue('overrides') || {};
      return {
        name: device.getName(),
        groupId: device.getStoreValue('groupId') || 'default',
        overrides,
      };
    });

    session.setHandler('save_changes', async (payload) => {
      this.homey.app.trace(`repair: save_changes -- name=${payload?.name}, group=${payload?.groupId || '-'}`);
      if (!payload) return false;
      if (payload.name && payload.name !== device.getName()) {
        await device.setName(payload.name.toString().trim() || 'Lumina Zone');
      }
      const groups = this.homey.settings.get('groups') || {};
      const groupId = payload.groupId || 'default';
      const overrides = trimOverrides(groups, groupId, pickValues(payload));
      await device.setStoreValue('groupId', groupId);
      await device.setStoreValue('overrides', overrides);
      return true;
    });

    session.setHandler('save_draft', async () => true);

    session.setHandler('showView', async (viewId) => {
      this.homey.app.trace(`repair: view -> ${viewId}`);
    });
    session.setHandler('disconnect', async () => {
      this.homey.app.trace('repair: session closed');
    });
  }
}

module.exports = ZoneDriver;
