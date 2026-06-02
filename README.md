<p>
  <a href="https://buymeacoffee.com/3cheesehigh"><img alt="Buy Me A Coffee" src="https://www.buymeacoffee.com/assets/img/custom_images/orange_img.png" height="50"></a>
  &nbsp;
  <a href="https://www.paypal.com/donate/?business=clemens.bott@gmail.com&item_name=Lumina+for+Homey&currency_code=EUR"><img alt="PayPal" src="https://img.shields.io/badge/PayPal-Donate-00457C?style=for-the-badge&logo=paypal&logoColor=white" height="50"></a>
</p>

# Lumina

HomeKit-style adaptive lighting for Homey Pro. Lights follow the sun:
color temperature and brightness shift smoothly through the day,
anchored on solar elevation.

The design goal is the simplest possible setup: open Lumina's app
settings, pick a Homey Zone, choose a curve preset, done. Sane
defaults, one screen for everything, a visual 24h preview so you see
what changes before you save them. Per-zone overrides and group
profiles exist for when you actually need them — but not for the
common case.

**User-facing description:** see [README.txt](README.txt).

## Architecture notes

- **Config-only** — Lumina has no virtual devices. All zones live in
  `homey.settings.zones`, indexed by Homey-Bereich id. A central
  `ZonesController` (see [lib/zones.js](lib/zones.js)) owns one
  `ZoneRuntime` per configured Bereich, which holds its member
  resolution, apply timer, and lamp-write state.
- **Live binding** — groups define the curve values; zones override
  per key. Changing a group cascades to every zone that doesn't have
  an explicit override for that key.
- **Member resolution** — a configured Bereich covers every
  dim-capable light in itself plus its child Bereiche, *unless* a
  child Bereich has its own Lumina configuration (which then takes
  over). Homey "Group" devices are preferred over individual lamps
  where possible (one Bridge command per group instead of N).
- **Per-lamp tuning** — each lamp inside a Bereich can carry an
  optional dim-scale (multiplier) and Kelvin offset, for setups with
  relative brightness or temperature mismatches.
- **Manual override detection** — if a user dims a lamp via Hue or a
  wall switch, Lumina pauses adaptive control on that lamp until it
  goes off/on again. Toggleable in the app settings.
- **light\_mode toggle** — apply writes the lamp's `light_mode`
  capability explicitly so the lamp reliably switches between colour
  and CT modes (some Zigbee bulbs otherwise keep the night colour
  into the next day).
- **i18n** — settings UI ships inline EN/DE string packs, picked via
  `navigator.language`. App metadata (flow card titles, store
  description) uses Homey's standard `{ en, de }` blocks in
  `app.json`.

## License

MIT — see [LICENSE](LICENSE).

Support: hello@3cheesehigh.com
