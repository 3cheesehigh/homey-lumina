'use strict';

const Homey = require('homey');
const { HomeyAPI } = require('homey-api');
const { defaults } = require('./lib/fields');
const { ZonesController } = require('./lib/zones');
const { PresenceController } = require('./lib/presence');
const { kelvinToLightTemperature, computeAdaptive } = require('./lib/curve');

const DEVICE_CACHE_TTL_MS = 30_000;

class LuminaApp extends Homey.App {

  async onInit() {
    this.log('Lumina started');
    this._ring = [];
    this._push('app.onInit');

    // Seed a default group on first install so a freshly-added zone has
    // something sane to inherit from without the user having to set one up.
    const groups = this.homey.settings.get('groups') || {};
    if (Object.keys(groups).length === 0) {
      const seeded = { default: { name: 'Standard', ...defaults() } };
      this.homey.settings.set('groups', seeded);
      this._push('seeded default group "Standard"');
    }

    // Seed presence-dim defaults so the "(defaults)" flow card has sane
    // values out of the box and the settings page renders pre-filled.
    if (!this.homey.settings.get('presenceDefaults')) {
      this.homey.settings.set('presenceDefaults', {
        mode: 'relative', percent: 50, seconds: 30, fadeSeconds: 5,
      });
      this._push('seeded default presence config');
    }

    // Shared HomeyAPI instance + 30 s cache for devices/zones. Without this
    // every runtime's tick would hit getDevices() (160+ devices) several
    // times every 5 minutes; with N zones that's NxM redundant calls.
    this._cacheUntil = 0;
    this._cachePending = null;

    this._zones = new ZonesController(this);
    await this._zones.start();

    this._presence = new PresenceController(this);

    await this._registerFlowCards();
    await this._registerWidgets();
  }

  async onUninit() {
    if (this._presence) this._presence.stop();
    if (this._zones) {
      await this._zones.stop().catch(() => {});
    }
  }

  _push(line) {
    const ts = new Date().toISOString().slice(11, 23);
    this._ring.push(`${ts} ${line}`);
    if (this._ring.length > 300) this._ring.shift();
  }

  trace(line) {
    this.log(line);
    this._push(line);
  }

  getRecentLog() {
    return this._ring.slice();
  }

  getZones() {
    return this._zones;
  }

  async getApi() {
    if (!this._api) this._api = await HomeyAPI.createAppAPI({ homey: this.homey });
    return this._api;
  }

  // Returns { devices, zones } from a shared 30 s cache. Concurrent callers
  // wait on the same in-flight promise so we never fire multiple parallel
  // getDevices() calls. Pass { fresh: true } to bypass the cache (e.g. after
  // a known mutation).
  async getDevicesAndZones(opts = {}) {
    const now = Date.now();
    if (!opts.fresh && this._cacheUntil > now && this._devicesCache && this._zonesCache) {
      return { devices: this._devicesCache, zones: this._zonesCache };
    }
    if (this._cachePending) return this._cachePending;
    this._cachePending = (async () => {
      try {
        const api = await this.getApi();
        const [devices, zones] = await Promise.all([
          api.devices.getDevices(),
          api.zones.getZones(),
        ]);
        this._devicesCache = devices;
        this._zonesCache = zones;
        this._cacheUntil = Date.now() + DEVICE_CACHE_TTL_MS;
        return { devices, zones };
      } finally {
        this._cachePending = null;
      }
    })();
    return this._cachePending;
  }

  invalidateDevicesCache() {
    this._cacheUntil = 0;
  }

  // ----- flow cards (registered once at app level) -----

  async _registerFlowCards() {
    // Autocomplete listener shared by all zone-targeting cards. Returns the
    // configured Bereiche by their Homey-zone name so users can search by
    // the name they already know.
    const zoneAutocomplete = async (query) => {
      const q = (query || '').toLowerCase();
      const { zones: allZones } = await this.getDevicesAndZones();
      const items = [];
      for (const rt of this._zones.listRuntimes()) {
        const name = rt._homeyZoneName || allZones[rt.bereichId]?.name || rt.bereichId;
        if (q && !name.toLowerCase().includes(q)) continue;
        items.push({ id: rt.bereichId, name });
      }
      items.sort((a, b) => a.name.localeCompare(b.name));
      return items.slice(0, 50);
    };

    const resolveZone = (sel) => {
      if (!sel || !sel.id) throw new Error('no zone chosen');
      const rt = this._zones.getRuntime(sel.id);
      if (!rt) throw new Error(`zone ${sel.id} not configured`);
      return rt;
    };

    this._tryRegister('set_mode', (card) => {
      card.registerArgumentAutocompleteListener('zone', zoneAutocomplete);
      card.registerRunListener(async (args) => {
        const rt = resolveZone(args.zone);
        this.trace(`flow: set_mode -> ${rt.getName()} = ${args.mode}`);
        await rt.setMode(args.mode);
      });
    });

    this._tryRegister('mode_is', (card) => {
      card.registerArgumentAutocompleteListener('zone', zoneAutocomplete);
      card.registerRunListener(async (args) => {
        const rt = resolveZone(args.zone);
        return rt.getMode() === args.mode;
      });
    }, 'condition');

    this._tryRegister('mode_changed', (card) => {
      card.registerArgumentAutocompleteListener('zone', zoneAutocomplete);
      // The runListener filters by the user's selected (zone, mode) tuple --
      // the trigger card itself fires on every mode change, this listener
      // narrows it to the rows the user actually wired up.
      card.registerRunListener(async (args, state) => {
        return state.bereichId === args.zone?.id && state.mode === args.mode;
      });
      this._modeChangedTrigger = card;
    }, 'trigger');

    this._tryRegister('cycle_mode', (card) => {
      card.registerArgumentAutocompleteListener('zone', zoneAutocomplete);
      card.registerRunListener(async (args) => {
        const rt = resolveZone(args.zone);
        const selected = Array.isArray(args.modes) ? args.modes : [];
        const sequence = ['off', 'day', 'night'].filter((m) => selected.includes(m));
        if (sequence.length === 0) throw new Error('select at least one mode to cycle through');
        const current = rt.getMode();
        const curIdx = sequence.indexOf(current);
        const nextIdx = curIdx >= 0 ? (curIdx + 1) % sequence.length : 0;
        const next = sequence[nextIdx];
        this.trace(`flow: cycle_mode -> ${rt.getName()} ${current} -> ${next} (cycle: ${sequence.join('->')})`);
        await rt.setMode(next);
      });
    });

    // ----- smart-on / smart-toggle: target is a lamp, find its zone -----

    const lightAutocomplete = async (query) => {
      const { devices: all, zones } = await this.getDevicesAndZones();
      const q = (query || '').toLowerCase();
      const items = [];
      for (const d of Object.values(all)) {
        const caps = d.capabilities || [];
        if (!caps.includes('onoff')) continue;
        if (!caps.includes('dim') && !caps.includes('light_temperature')) continue;
        const name = d.name || '';
        const zoneName = zones[d.zone]?.name || '';
        const hay = `${name} ${zoneName}`.toLowerCase();
        if (q && !hay.includes(q)) continue;
        items.push({
          id: d.id,
          name: zoneName ? `${name} (${zoneName})` : name,
          description: zoneName,
        });
      }
      items.sort((a, b) => a.name.localeCompare(b.name));
      return items.slice(0, 50);
    };

    const resolveLightTarget = async (sel) => {
      if (!sel || !sel.id) throw new Error('no target chosen');
      const { devices } = await this.getDevicesAndZones();
      const target = devices[sel.id];
      if (!target) throw new Error(`target ${sel.id} not found`);
      return target;
    };

    const performSmartOn = async (target) => {
      // Cancel any presence dim-then-off involving this lamp -- covers both
      // a lamp-level timer and any zone-wide timer the lamp belongs to, so
      // the user's existing motion-detect -> smart_on flow automatically
      // aborts the auto-off without needing a separate cancel card.
      this._presence?.cancelForLamp(target.id);

      const rt = this._zones.findRuntimeForLight(target.id);
      const v = rt ? rt.getCurrentValues() : this._defaultValues();
      if (!v) throw new Error('no adaptive values available (no default group?)');

      this.trace(`smart-on writes -> ${target.name} via zone=${rt?.getName() ?? 'default'} -> ${v.kelvin}K / ${v.dimPct}%`);

      const api = await this.getApi();
      const caps = target.capabilities || [];
      const writes = [];
      if (caps.includes('dim')) {
        writes.push(api.devices.setCapabilityValue({
          deviceId: target.id, capabilityId: 'dim', value: v.dimPct / 100,
        }));
      }
      if (caps.includes('light_temperature')) {
        writes.push(api.devices.setCapabilityValue({
          deviceId: target.id, capabilityId: 'light_temperature',
          value: kelvinToLightTemperature(v.kelvin),
        }));
      }
      await Promise.all(writes);
    };

    this._tryRegister('smart_on', (card) => {
      card.registerArgumentAutocompleteListener('target', lightAutocomplete);
      card.registerRunListener(async (args) => {
        const target = await resolveLightTarget(args.target);
        this.trace(`flow: smart_on -> ${target.name}`);
        await performSmartOn(target);
      });
    });

    this._tryRegister('smart_toggle', (card) => {
      card.registerArgumentAutocompleteListener('target', lightAutocomplete);
      card.registerRunListener(async (args) => {
        const target = await resolveLightTarget(args.target);
        const api = await this.getApi();
        const isOn = await api.devices.getCapabilityValue({
          deviceId: target.id, capabilityId: 'onoff',
        });
        if (isOn === true) {
          this.trace(`flow: smart_toggle -> ${target.name} on, turning off`);
          this._presence?.cancelForLamp(target.id);
          await api.devices.setCapabilityValue({
            deviceId: target.id, capabilityId: 'onoff', value: false,
          });
        } else {
          this.trace(`flow: smart_toggle -> ${target.name} off, smart-on`);
          await performSmartOn(target);
        }
      });
    });

    // ----- presence dim & auto-off (typically wired to motion sensors) -----

    const parsePresenceArgs = (args) => {
      const mode = args.mode;
      const percent = Number(args.percent);
      const seconds = Number(args.seconds);
      const fade = Number(args.fade);
      if (mode !== 'relative' && mode !== 'absolute') {
        throw new Error(`invalid mode: ${mode}`);
      }
      if (!Number.isFinite(percent) || percent < 1 || percent > 99) {
        throw new Error(`invalid percent: ${args.percent}`);
      }
      if (!Number.isFinite(seconds) || seconds < 1 || seconds > 3600) {
        throw new Error(`invalid seconds: ${args.seconds}`);
      }
      if (!Number.isFinite(fade) || fade < 0 || fade > 60) {
        throw new Error(`invalid fade: ${args.fade}`);
      }
      return { mode, percent, seconds, fadeSeconds: fade };
    };

    this._tryRegister('presence_dim_light', (card) => {
      card.registerArgumentAutocompleteListener('target', lightAutocomplete);
      card.registerRunListener(async (args) => {
        const target = await resolveLightTarget(args.target);
        const { mode, percent, seconds, fadeSeconds } = parsePresenceArgs(args);
        this.trace(`flow: presence_dim_light -> ${target.name} ${mode} ${percent}% / ${seconds}s / fade ${fadeSeconds}s`);
        await this._presence.startLight(target.id, { mode, percent, seconds, fadeSeconds });
      });
    });

    this._tryRegister('presence_dim_light_default', (card) => {
      card.registerArgumentAutocompleteListener('target', lightAutocomplete);
      card.registerRunListener(async (args) => {
        const target = await resolveLightTarget(args.target);
        this.trace(`flow: presence_dim_light_default -> ${target.name} (using settings defaults)`);
        await this._presence.startLight(target.id);
      });
    });
  }

  // Dashboard widgets: register backend autocomplete + state hooks.
  // Wrapped in try/catch because dashboards.getWidget is firmware-gated
  // (>=12.3) and we don't want a startup crash on slightly older Homeys.
  async _registerWidgets() {
    try {
      const widget = this.homey.dashboards.getWidget('zone-mode');
      widget.registerSettingAutocompleteListener('zone', async (query) => {
        const q = (query || '').toLowerCase();
        const { zones: allZones } = await this.getDevicesAndZones();
        const items = [];
        for (const rt of this._zones.listRuntimes()) {
          const name = rt._homeyZoneName || allZones[rt.bereichId]?.name || rt.bereichId;
          if (q && !name.toLowerCase().includes(q)) continue;
          items.push({ id: rt.bereichId, name });
        }
        items.sort((a, b) => a.name.localeCompare(b.name));
        return items.slice(0, 50);
      });
      this.trace('widget registered: zone-mode');
    } catch (err) {
      this.trace(`widget registration failed: ${err.message}`);
    }
  }

  _tryRegister(cardId, setup, kind = 'action') {
    try {
      const card = kind === 'condition'
        ? this.homey.flow.getConditionCard(cardId)
        : kind === 'trigger'
          ? this.homey.flow.getTriggerCard(cardId)
          : this.homey.flow.getActionCard(cardId);
      setup(card);
      this.trace(`flow card registered: ${cardId} (${kind})`);
    } catch (err) {
      this.trace(`flow card registration failed: ${cardId} -- ${err.message}`);
    }
  }

  // Called by ZoneRuntime.setMode after the new mode is persisted. We pass
  // (tokens, state) -- state is what the trigger card's runListener filters
  // on (bereichId + mode), tokens are flow-tag values exposed to downstream
  // cards.
  fireModeChanged(bereichId, mode, runtime) {
    if (!this._modeChangedTrigger) return;
    const tokens = { zone: runtime?._homeyZoneName || bereichId, mode };
    const state = { bereichId, mode };
    this._modeChangedTrigger.trigger(tokens, state).catch(err =>
      this.trace(`mode_changed trigger emit failed: ${err.message}`)
    );
  }

  // Fallback adaptive values for smart-on when the target light is not a
  // member of any configured zone -- uses the default group + Homey
  // geolocation.
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
}

module.exports = LuminaApp;
