# Changelog

Aether's own releases. Versions start at 0.1.0 rather than continuing NOIA2's
numbering: this fork publishes to its own release channel, and the updater
compares an installed build against these releases. Upstream's release history
lives in the [NOIA2 repository](https://github.com/ZDYoung0519/NOIA2).

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
