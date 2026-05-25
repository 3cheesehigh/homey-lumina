# Lumina

HomeKit-style adaptive lighting for Homey Pro. Lights follow the sun:
color temperature and brightness shift smoothly through the day, anchored
on solar elevation.

The design goal is the simplest possible setup: install, add one Lumina
Zone per room, done. Sane defaults, one screen for everything, a visual
24h preview so you see what changes before you save them. Per-zone
overrides and group profiles exist for when you actually need them — but
not for the common case.

**User-facing description and pairing flow:** see [README.txt](README.txt).

## Architecture notes

- **Live binding** — groups define the values; zones override per key.
  Changing a group cascades to every zone that doesn't have an explicit
  override for that key.
- **Member resolution** — a Lumina Zone owns every dim-capable light in
  its Homey zone and child zones, *unless* a child has its own Lumina
  Zone (which then takes over). Homey "Group" devices are preferred over
  individual lamps where possible (one Bridge command per group instead
  of N).
- **Manual override detection** — if a user dims a lamp via Hue/wall
  switch, Lumina pauses adaptive control on that lamp until it goes
  off/on again. Configurable.
- **i18n** — settings + pair UI ship inline EN/DE string packs, picked
  via `navigator.language`. App metadata (capability titles, flow card
  titles, store description) uses Homey's standard `{ en, de }` blocks
  in `app.json`.

## Development

```sh
npm install
npx homey app run         # foreground, with live log
npx homey app install     # build + push to your Homey
npx homey app validate --level publish
```

## License

MIT — see [LICENSE](LICENSE).

Support: hello@3cheesehigh.com
