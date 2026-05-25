Lumina — lights that follow the sun.

Lumina is a HomeKit-style adaptive lighting controller for Homey Pro. It
continuously adjusts the color temperature and brightness of your lights
based on the sun's elevation at your location: cool and bright around solar
noon, warm and dim around sunrise and sunset, and a configurable fixed
night state after dusk.

Why another adaptive lighting app
---------------------------------
The goal is the simplest possible setup. You install Lumina, add one
"Lumina Zone" device per room (or wing of the house), and you're done —
every dim-capable light in that area is now sun-following. No mapping
each lamp individually, no flows to wire up, no per-light tweaking
needed for the common case. Defaults are tuned to feel right out of the
box; the curve, group, and per-zone overrides only exist when you
actually want to deviate. The whole thing is built around usability:
sane defaults, one screen for everything, a visual 24h preview so you
see what changes before you save them.

How it works
------------
You group your lights into "Lumina Zones" (one per Homey zone). Each
zone inherits day/night curve values from a shared Group profile, and you
can override individual values per zone if a room needs different
behaviour. Every five minutes the app recomputes the target values from
the current solar elevation and writes them to every member lamp that is
currently on.

Three modes per zone, selectable via the device picker or a flow:
  - Adaptive (day): follow the sun
  - Night: fixed warm dim state (or an optional color, e.g. red, on lamps
    that support light_hue + light_saturation)
  - Off: Lumina stops touching the lamps

Lamps without color-temperature support are still dimmed adaptively;
lamps without color support fall back to color temperature in night mode.

Flow cards
----------
  - Action "Set mode": switch a zone between Off / Adaptive / Night.
  - Condition "Mode is …": check a zone's current mode in a flow.
  - Action "Smart turn on": turns a light on using the current adaptive
    target values, so it wakes at the right brightness and color instead
    of flashing its last hardware-stored state.

Pairing
-------
After installing, add a "Lumina Zone" device per Homey zone you want
the app to manage. The zone automatically picks up every dim-capable
light in its Homey zone (and recursively in child zones, unless
those have their own Lumina Zone). If a Homey "Group" device sits in the
same zone, Lumina prefers writing to the group (one bridge command for
all members) instead of to each lamp individually.

Settings
--------
Open the app's Configure screen to:
  - Edit the shared Day/Night curve parameters per Group.
  - Assign zones to a Group, or override specific values per zone.
  - Enable an optional fixed color for night mode.
  - Preview the 24h kelvin + brightness curve before saving.

Manual changes
--------------
By default Lumina pauses adaptive control on a lamp when it detects a
manual change (someone dimmed the lamp via the Hue app or a wall switch).
The lamp stays paused until you turn it off and on again. This can be
disabled in the app settings.

Source code: https://github.com/3cheesehigh/homey-lumina
Support: hello@3cheesehigh.com
