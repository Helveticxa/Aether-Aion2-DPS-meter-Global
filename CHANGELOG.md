# Changelog

Aether's own releases. Versions start at 0.1.0 rather than continuing NOIA2's
numbering: this fork publishes to its own release channel, and the updater
compares an installed build against these releases. Upstream's release history
lives in the [NOIA2 repository](https://github.com/ZDYoung0519/NOIA2).

## [0.1.11]

**The meter was set to ignore everything that is not a boss.** `Boss only` and
`My training dummy only` both defaulted to on, inherited from upstream, so every
hit on an ordinary mob was discarded before it reached the meter. Levelling
showed a permanently empty overlay with nothing on screen to explain it.

Both now default to off, and existing settings are migrated rather than merely
re-defaulted — a stored value survives a changed default forever otherwise.
`Hide unknown players` is off too: it was hiding your own row whenever the game
had not re-sent the player packet since the meter started.

**"What to count" is now two named modes** rather than a switch. As a switch it
read as a refinement; it decides whether the meter records anything at all.

**And the overlay says when a setting is the reason it is empty.** With Boss only
on it now reports how many hits were ignored and where to change it. An empty
meter that explains itself is a setting to fix; an empty meter that says nothing
reads as a broken app.

**CPU and memory are shown.** The backend has emitted them alongside ping every
two seconds since the fork; nothing ever displayed them. They report Aether's own
footprint, which is the number worth knowing when deciding whether to leave it
running alongside the game.

### Not getting heavier the longer it runs

`dps_stats` — the combat totals, keyed by target — was the one map here that was
not bounded, and it is deep-cloned five times a second to build the overlay
snapshot. While the meter only counted bosses that was a handful of entries.
Counting ordinary mobs, which is now the default, would have added one per kill
and made every snapshot fractionally more expensive than the last, for the whole
session. It is now capped at 512 targets, oldest evicted first.

The ping history — a hundred samples serialised into every memory event, twice a
second, read by nothing — is gone.

### Correction

0.1.10 said the reset bug explained a history record showing damage but "0
players". That was wrong: `clear()` deliberately preserves the actor name tables,
so it cannot have caused it. The reset fix stands on its own; that particular
detail is still unexplained.

## [0.1.10]

**The meter was clearing itself mid-fight.** Identifying the player fired a
silent reset — intended to start clean when you log in. But the game re-sends
the own-player packet throughout a session, ten times in one recorded session
here, and every one of them wiped the accumulated damage. That is why the
overlay sat at `--` while the fight was plainly happening.

It now resets only when the player actually changes, keyed on the character name
rather than the actor id: ids are per-session entity handles that change across
zones — the same character appeared as both `15056` and `5492` in one recording
— so keying on them would have cleared the meter every time you zoned.

**The same bug emptied the Main Character card.** A reset clears the actor name
table while damage keeps accumulating against actor ids, so a fight that ended
in that window was filed as a record with damage but no players. The card builds
its character list from those records, found no named player in any of them, and
said "No main character recorded yet". With the resets gone, records keep their
players and the card has something to read.

Nothing was wrong with capture or parsing. The log from the reported session
shows the player identified correctly ten times over — name, server, and class —
and no errors at all.

## [0.1.9]

**Minimising no longer throws the map view away.** Restoring the window brought
the map back at 1× as though it had reloaded, and the refit was expensive enough
to feel like a freeze. The fit ran from an effect that depended on the viewport
size, so *every* resize refit the map — and minimising and restoring is two of
them. The map now fits once per zone; a resize keeps the view and only stops it
drifting off screen.

**The map draws even when the window is not painting.** First paint depended
entirely on a `ResizeObserver` callback, and observer delivery is tied to the
rendering lifecycle — an occluded or minimised window may not get one for a long
time, leaving the map blank until it does. The viewport is now measured directly
as well.

**Markers outside the view are dropped once you zoom in.** Past 1.5× most of a
zone is off screen, and keeping those elements mounted meant the browser laid
out, painted and composited content nobody could see — felt as sluggishness
across the whole window, not just the map. At 12× that is 522 markers instead of
825, and 2,281 DOM nodes instead of 3,326. The cull keeps a full viewport of
margin on each side so an ordinary pan moves through markers that are already
mounted.

**Switching tabs is instant.** The map is a route, so navigating away and back
remounted it, and every visit re-ran the dataset load — a Tauri call plus four
dynamic imports — before anything could render. It is resolved once per session
now.

**Zooming keeps up with the wheel.** Each wheel event read the view from the
render it was created in, so events arriving faster than React re-renders
collapsed into a single step. Sixteen events moved the map 1.4× instead of 12×.

Also: the base image is no longer rendered underneath the tile layer once tiles
cover the zone, and the map's floating labels dropped their backdrop blur, which
repaints whatever is behind it on every frame that touches the window.

## [0.1.8]

**The map was blurry and slow for the same reason, and it was my optimisation
that caused it.** The viewer kept a fixed 1000px plane and scaled it up, with
`will-change: transform` so that panning stayed cheap. A promoted layer is
rasterised at its *unscaled* size, so at 10× every pixel — the 4096px image, the
downloaded tiles, every glyph — was being resampled from a 1000px raster. The
same layer was about 9500px square to composite, which is what made scrolling
crawl. Downloading full-resolution tiles could not help: they were being thrown
away before they reached the screen.

The plane is now sized in real pixels and moved with translate only. Panning got
*faster* (0.013 ms per update, from 0.023) because there is no oversized layer
to composite, and zooming costs one reflow of 1.5 ms — nine percent of a frame,
on a gesture that is discrete. The minimap overlay has always worked this way,
which is why it looked sharp while the main map did not.

The base image also steps aside once tiles cover the zone, rather than being
decoded and composited underneath them.

**The map starts with the landmarks, not everything.** Waystones, monoliths,
seals, regions, battlefields, villages and hidden cubes are on; the fifteen
gathering materials and NPCs are off. That is 825 markers instead of 1,364 on a
first look. It is an allow-list, so a category added later starts hidden rather
than quietly crowding the map, and the choice is remembered once you change it.
Both the map page and the overlay read the same default, so they cannot
disagree about what a fresh install shows.

**Minimap waypoints are legible.** They were sized for a dense overview and
disappeared into the terrain; they are larger now, and the glyph fills them.

## [0.1.7]

**Updates no longer fail on the WinDivert driver.** Installing 0.1.6 over 0.1.5
stopped with *"Error opening file for writing: WinDivert64.sys"*, and clicking
Ignore left a new executable beside an old driver.

Windows locks the image of a loaded kernel driver, and Aether's own startup
check is what loads it: probing WinDivert means calling `WinDivertOpen`, which
starts the service, and closing the handle afterwards does not unload it. So on
any machine that had run Aether once, the file was locked by the time the next
update arrived. The installer now stops and deregisters the driver before
touching files — and does the same on uninstall, which previously left the
service registered against a path that no longer existed.

**Full-resolution maps.** The bundled images are 4096px and soften past about
8×. The source's own tiles are 1024px each on grids up to 8×8, which
reconstructs a zone at its native 8192px — twice the linear resolution, and the
most detail that exists. All eight zones would be roughly 52 MB, so tiles are
optional and per zone: the map panel offers to download the zone you are looking
at, and the viewer layers them over the base once you zoom in far enough to tell
the difference. The zoom ceiling follows what is actually installed — 12× on the
base image, 32× with tiles — rather than a fixed number, so it never invites you
into mush or holds you back from detail you already have.

The minimap overlay does the same, and picks up whatever the map page has
downloaded.

**Markers are pure glyphs.** The dark disc and coloured ring are gone. The disc
was carrying legibility over a busy map, so a dark outline that follows the
glyph does that job instead — the shape stays readable without being boxed in.
The legend matches.

## [0.1.6]

**An interactive map.** A new tab beside Home, with an always-on-top minimap
that behaves like the DPS overlay. Eight zones, 4,799 markers, 77 region
outlines: waystones, seals, hidden cubes, monolith materials, gathering nodes,
villages and NPCs, filterable by category and searchable by name. Clicking a
marker marks it found, and that is remembered — the full map and the minimap
share the same state, so hiding a category in one hides it in the other.

The marker database and map images come from
[AION2 Hub](https://aion2hub.com/maps). It is their work; if the map is useful
to you, visit and support them. `public/aion2/maps/SOURCE.md` records exactly
what was taken and how.

Markers carry a glyph rather than only a colour, because fifteen categories
separated by hue alone makes a map a memory test. Shape says what kind of thing
it is — gem, ore, log, leaf, waystone — and colour says which one, with the
palette arranged so that same-shaped categories land far apart.

Pan and zoom move one transformed plane rather than repositioning every marker,
which keeps the cost independent of how many are on screen: 0.023 ms per view
update with 1,364 markers loaded. Markers shrink as the map zooms out, since
holding them at a constant size turns a busy zone into a solid mass. Zoom stops
at 12×, where the 4096px images stop being sharp.

### Removed

Four pages nothing could reach: the damage leaderboard, the account screen, and
the two character-search pages. All needed a backend this build does not have,
all were still in Chinese, and every audit kept re-reporting them. Deleting them
freed a further 1.1 MB of data that only they held up. Git keeps them if the
global service ever turns out to want a leaderboard.

### Also

- The setup guide and the startup gate now point at the same Npcap build.

## [0.1.5]

**WinDivert was never shipped.** `WinDivert64.sys` sat in the repository and was
copied into the build directory for local runs, but the installer's resource
list named only `WinDivert.dll` — so every installed copy of Aether had the
fallback capture backend permanently unavailable, reporting "WinDivert64.sys was
not found" on a machine where nothing was wrong. The driver is now bundled, and
the fallback works out of the box.

**The startup screen is a real gate.** It used to run its checks and then let
you through regardless, which is defensible — capture needs one backend, not
both — but it said so while showing an amber warning and a Repair button, so a
healthy machine looked broken. Now the checks are weighed: anything genuinely
required holds the app closed until it passes, and anything optional is shown in
plain grey with an "Optional" tag and never blocks. The gate cannot be walked
around either; the tray icon and a second launch both land on it rather than
opening the main window behind it.

**Npcap installs from the gate.** When no capture backend is available, one
button fetches the official Npcap installer, verifies it against a pinned
SHA-256 before running anything, launches it, and re-checks by itself when it
closes. Npcap reserves unattended installation for its OEM licence, so its own
window still appears — the gate says which option to tick.

**Checks test the driver, not the file.** Npcap used to count as present if
`wpcap.dll` could be loaded, which stays true after its service stops or its
driver is removed underneath. The check now enumerates adapters, so "available"
means capture can actually start. Administrator rights are checked too, rather
than assumed from the manifest.

**Removed the WinDivert download.** Repairing WinDivert used to pull a kernel
driver from a third-party storage bucket inherited from upstream, over plain
HTTP semantics with no integrity check, and write it into the install directory.
Bundling the driver makes that unnecessary and the code is gone.

### Also

- Starting the meter reports *why* it failed instead of "Failed to toggle DPS
  meter" — the backend already names the backend and the error.
- A failed meter start no longer leaves an empty overlay pinned over the game.
- The setup guide points at the same Npcap build the gate installs.

## [0.1.4]

**Window controls are readable now.** Minimise, maximise and close had no
backdrop of their own and used a muted foreground colour, so they washed out
against the background image. They now carry the same translucent round backing
the left-hand actions use — the treatment that already reads well over that
image — with a slightly larger glyph and a clearer hover.

**Removed the language toggle from the title bar.** It occupied permanent space
for something changed once, if ever. It still lives in Settings → Appearance,
so Korean remains reachable.

**The installer no longer offers Simplified Chinese.** That option was inherited
from upstream and had no place in an English build.

Also removed `main-title-bar-old.tsx`, a superseded copy nothing imported.

### On the taskbar icon

If the taskbar or Start Menu still shows the old mark after updating, the
executable is fine — Windows caches icons per path and does not re-read them
when a file is replaced in place, which is exactly what an update does. Clearing
the icon cache, or signing out and back in, refreshes it.

## [0.1.3]

New application icon, replacing the NOIA2 artwork the fork inherited.

Generated from a 1254×1254 source with transparent corners, so every size Tauri
ships is derived from one master rather than resized by hand. `icon.ico` carries
six sizes up to 256×256, which is what Windows needs for the installer, the
taskbar, and high-DPI displays.

The source image is committed as `app-icon.png`, the name Tauri looks for, so
regenerating every size is `npx tauri icon` with no arguments.

The AION 2 logo in the title bar is unchanged on purpose: it is the game picker,
and it identifies which game the meter is reading.

## [0.1.2]

Fixes the updater itself, on both ends.

**"Check for Updates" did nothing.** The button ran its check in one hook
instance while the dialog that displays a result lived in another. It found the
update, stored it somewhere nothing rendered, and stopped — a spinner, then
silence. The dialog now owns that state and the button drives it.

**The update dialog overflowed the window.** It had no height limit, and its body
was placed inside `DialogDescription`, which renders a paragraph — so block
content sat inside a `<p>`. Release notes now scroll inside a bounded panel, the
dialog caps at 85% of window height, and the markup is valid.

Two smaller things found on the way:

- Installing re-ran the update check instead of using the release the user had
  just been shown. A wasted round trip, and it could have fetched a different
  release than the one they agreed to.
- The settings route sat inside the layout that mounts the automatic startup
  check, so opening About could stack two update dialogs.

Also removed `src/pages/about.tsx`, template scaffolding with no route to it.

## [0.1.1]

The overlay still said "NoiA METER" on screen. Renaming it in the HTML was not
enough: `overlay/meter/main.js` writes the title again at runtime, so the markup
change never survived. Fixed at the source.

That miss exposed a wider gap. The overlays are plain `.js`, and the earlier
translation passes only scanned `.ts`, `.tsx`, `.html` and `.json` — so all five
overlay scripts were still partly Chinese.

- The copied battle report was written in Chinese and formatted damage on the
  万/亿 scale regardless of the chosen setting. It is English now, on K/M/B, and
  credits Aether rather than upstream's Bilibili channel.
- Buff overlay: class names, slot labels, and every button tooltip.
- PVP overlay: watch-list tooltips and the unknown-server fallback.
- The WinDivert repair dialog reported all sixteen of its progress steps in
  Chinese. Those are the messages shown when capture is broken — exactly when
  being unable to read them hurts most.

Also fixed two corrupted locale entries: a stale `language.zh` option left over
from dropping Chinese, and a `PvEAddDamage` stat whose value had a duplicated key
name and stray Chinese glued onto it.

Known gap: 59 of 7,105 skill names in the English catalogue are still Chinese,
almost all Fighter skills. They come from upstream's data and need a global
client to replace properly.

## [0.1.0]

First release of the fork. Everything below is relative to NOIA2 at the point it
was forked.

**Built for the global servers.** Upstream validated server ids against Taiwan's
exact catalogue, and that value is used structurally to locate fields inside
player-info packets. On any other service every candidate was rejected and no
player was ever named -- an empty meter with no error to go on. Region profiles
replace that constant, with a permissive structural rule that holds on services
not catalogued yet.

**Region detection only claims a region on evidence.** Korea is identifiable by
its server block; Taiwan and global are not yet, so it reports "no fingerprint
matched" instead of guessing. Settings → Runtime shows the server IPs and ids
actually observed, which is how an uncatalogued service gets characterised.

**Protocol tooling for launch day.** Packet recording writes a session's raw
packets to disk and replays them back through the live pipeline, so a session
captured once can be iterated against offline. An opcode census counts every
dispatched packet, recognised or not. A diagnostics report turns all of it into
one pasteable summary.

**English throughout.** Upstream defaulted to Simplified Chinese in three
separate places and carried roughly 500 hardcoded Chinese strings. Those are
translated and the Chinese locales removed; English and Korean remain.

**Runs fully offline.** Cloud features are optional and off by default -- the
meter never depended on them. Pages that need a community backend are hidden
rather than left to fail: character search needs a Taiwan-only API, and the
damage leaderboard needs a Supabase project.

**Fixes**

- The app could not start at all in a fresh clone: upstream reads Supabase
  credentials from a gitignored `.env`, and the resulting `createClient` throw
  took the whole window down at module load.
- Number formatting defaulted to the 万/亿 scale in four places the app-level
  setting did not reach; each overlay carries its own fallback.
- `pnpm tauri:build` pointed at a config file that has never existed in the
  repository, so local release builds could not run.
- An upstream notice telling users to download NoiA 5.0 from its official site
  opened on every visit to the home screen.
