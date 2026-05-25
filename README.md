# Lumina

HomeKit-style adaptive lighting for Homey Pro. Lights follow the sun:
color temperature and brightness shift smoothly through the day, anchored
on solar elevation.

The design goal is the simplest possible setup: install, add one Lumina
Zone per room, done. Sane defaults, one screen for everything, a visual
24h preview so you see what changes before you save them. Per-zone
overrides and group profiles exist for when you actually need them — but
not for the common case.

## What it does

You group your lights into **Lumina Zones** (one per Homey-Bereich). Each
zone inherits day/night curve values from a shared **Group** profile and
can override individual values per zone if a specific room wants
different behaviour. Every five minutes the app recomputes the target
from the current solar elevation and writes it to every member lamp that
is currently on.

Three modes per zone:
- **Adaptive** — follows the sun
- **Night** — fixed warm dim state (or an optional color like deep red,
  on lamps that support `light_hue` + `light_saturation`)
- **Off** — Lumina stops touching the lamps

Lamps without color-temperature capability are still dimmed adaptively;
lamps without color capability fall back to color temperature when night
color is enabled.

## Flow cards

- **Action: Set mode** — switch a zone between Off / Adaptive / Night.
- **Condition: Mode is …** — check a zone's current mode.
- **Action: Smart turn on** — turn a light on at the current adaptive
  values, so it wakes at the right brightness/color instead of flashing
  its last hardware-stored state.

## Settings

Open the app's Configure screen to:
- Edit the Day/Night curve parameters per Group.
- Assign zones to a Group, or override specific values per zone.
- Enable an optional fixed color for night mode.
- Preview the 24h kelvin + brightness curve before saving.

## Architecture notes

- **Live binding**: groups define the values; zones override per key.
  Changing a group cascades to every zone that doesn't have an explicit
  override for that key.
- **Member resolution**: a Lumina Zone owns every dim-capable light in
  its Homey-Bereich and child Bereiche, *unless* a child has its own
  Lumina Zone (which then takes over). Homey "Group" devices are
  preferred over individual lamps where possible.
- **Manual override detection**: if a user dims a lamp via Hue/wall
  switch, Lumina pauses adaptive control on that lamp until it goes
  off/on again. Configurable.

## License

MIT — see [LICENSE](LICENSE).

Source: https://github.com/3cheesehigh/homey-lumina
Support: hello@3cheesehigh.com
