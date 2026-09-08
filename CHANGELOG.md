# Changelog

Aether's own releases. Versions start at 0.1.0 rather than continuing NOIA2's
numbering: this fork publishes to its own release channel, and the updater
compares an installed build against these releases. Upstream's release history
lives in the [NOIA2 repository](https://github.com/ZDYoung0519/NOIA2).

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
