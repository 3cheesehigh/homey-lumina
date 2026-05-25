'use strict';

const Homey = require('homey');
const { HomeyAPI } = require('homey-api');
const { defaults } = require('./lib/fields');

const DEVICE_CACHE_TTL_MS = 30_000;

class LuminaApp extends Homey.App {

  async onInit() {
    this.log('Lumina started');
    this._ring = [];
    this._push('app.onInit');

    // Seed a default group on first install so a freshly-paired zone has
    // something sane to inherit from without the user having to set one up.
    const groups = this.homey.settings.get('groups') || {};
    if (Object.keys(groups).length === 0) {
      const seeded = { default: { name: 'Standard', ...defaults() } };
      this.homey.settings.set('groups', seeded);
      this._push('seeded default group "Standard"');
    }

    // Shared HomeyAPI instance + 30 s cache for devices/zones. Without this
    // every Zone device's tick would hit getDevices() (160+ devices) several
    // times every 5 minutes; with N zones that's NxM redundant calls.
    this._cacheUntil = 0;
    this._cachePending = null;
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
}

module.exports = LuminaApp;
