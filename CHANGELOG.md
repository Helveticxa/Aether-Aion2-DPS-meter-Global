# Changelog

Aether's own releases. Versions start at 0.1.0 rather than continuing NOIA2's
numbering: this fork publishes to its own release channel, and the updater
compares an installed build against these releases. Upstream's release history
lives in the [NOIA2 repository](https://github.com/ZDYoung0519/NOIA2).

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
