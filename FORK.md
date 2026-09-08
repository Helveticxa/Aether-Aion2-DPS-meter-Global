# Fork notes

This is a personal fork of [NOIA2](https://github.com/ZDYoung0519/NOIA2) by zdyoung,
tracked as the git remote `upstream`.

Licensed **GPL-3.0-only**, same as upstream. Any distributed build must ship its
source under the same terms.

## Why this base

Four AION2 meters were evaluated before forking:

| Project | Verdict |
|---|---|
| [TK-open-public/Aion2-Dps-Meter](https://github.com/TK-open-public/Aion2-Dps-Meter) | MIT but **discontinued 19 June** and deliberately incomplete -- `.gitignore` withholds `resources/json/` (skills, mobs, buffs), the `/addon/` module, and the frontend's `constants/`. Does not build or run as published. Useful only as a licence-safe protocol reference. |
| [p62003/aletheia_AION2_DPS_Meter](https://github.com/p62003/aletheia_AION2_DPS_Meter) | **Not open source** -- docs and screenshots only, zero code, "All Rights Reserved", derivative works forbidden. UX benchmark only. |
| [Kuroukihime/AIon2-Dps-Meter](https://github.com/Kuroukihime/AIon2-Dps-Meter) | C# / .NET 10 / WPF, GPL-3.0, complete game data. Good **cross-reference** -- carries opcodes this base lacks (`PLAYER_STATS 0x49,0x36`, `ENTITY_DEATH`). |
| **NOIA2** (this base) | Rust + Tauri 2 + React 19, GPL-3.0, complete game data, actively developed. |

The deciding factor for a global-server target: NOIA2 **does not hardcode a server
address**. It scans every network interface for the heartbeat magic
`[0x0E, 0x00, 0x36]` and infers the device and port from whichever interface
answers (`src-tauri/src/dps_meter/capture/capturer.rs`, `inspect_device_for_magic`).
The Kotlin project, by contrast, pins the Korean server (`206.127.156.0/24:13328`)
in a properties file. Auto-discovery should carry to the global servers unchanged.

Opcodes are also identical across the Korean and Taiwanese clients -- verified by
comparing all three open implementations -- which is good evidence they will hold
on global too. Still to be confirmed against a real global capture.

## Changes against upstream

### Cloud features made optional

Upstream reads `VITE_SUPABASE_URL` / `VITE_SUPABASE_ANON_KEY` from a gitignored
`.env`, so a fresh clone has neither. `createClient(undefined, undefined)` throws
`supabaseUrl is required.` at module load, and because `main-title-bar.tsx`
imports `AuthModal` eagerly, that took down the whole app at startup.

`src/lib/supabase.ts` now exports:

- `isCloudEnabled` -- whether both env vars are present
- `supabase: SupabaseClient | null` -- constructed only when they are
- `requireSupabase()` -- throws a readable error, for handlers that already catch

Reactive code (`use-user`, the deep-link handler) degrades quietly to a
logged-out state; imperative handlers surface the error through their existing
error paths; the account button is hidden when cloud is off.

The meter itself never depended on any of this. Nothing is uploaded anywhere by
default.

Note: upstream's premium flag only drives cosmetics -- an avatar glow and a badge.
No meter functionality is gated behind it.

## Running

Packet capture needs Npcap **and Administrator rights** -- upstream bakes
`requireAdministrator` into the Windows manifest in `src-tauri/build.rs`, so the
app cannot start from a normal shell (it fails with OS error 740).

Launch from an **elevated** terminal:

```
pnpm tauri:dev
```

## Staying current with upstream

```
git fetch upstream
git merge upstream/main
```

Changes here are deliberately kept to small, anchored edits so these merges stay
cheap.

### Region profiles (Taiwan / Korea / global)

Upstream hardcoded Taiwan's server catalogue inside the player-name parser:

```rust
fn is_available_server_id(server_id: u32) -> bool {
    (1001..=1021).contains(&server_id) || (2001..=2021).contains(&server_id)
}
```

That value is not cosmetic -- it is used *structurally*, to decide where the
server field sits inside a player-info packet. On any service whose ids fall
outside Taiwan's range, `find_server_id` returns `None` and **no player is ever
named**: a silent, total failure with no error to go on.

`src-tauri/src/dps_meter/region.rs` replaces it with per-region profiles:

| Profile | Server-id rule |
|---|---|
| `Auto` (default) | `1001..=1999`, `2001..=2999` |
| `Taiwan` | `1001..=1021`, `2001..=2021` (the bundled catalogue) |
| `Korea`, `Global` | same permissive rule as `Auto` |

The permissive rule is structural, not a shrug: server ids are
`raceId * 1000 + index` (race 1 Elyos, race 2 Asmodian), confirmed by the bundled
Taiwan list. It keeps the disambiguation the parser depends on -- an arbitrary
`u16` still fails -- without assuming how many servers a region runs.

**Detection is deliberately conservative.** It only claims a region on evidence.
Korea is identifiable by its server block (`206.127.156.0/24`, from the MIT
TK-open-public meter); Taiwan's and global's blocks are unknown, so detection
returns "no fingerprint matched" rather than guessing from an id range they may
well share. Settings → Backend shows the observed server IPs and ids so an
uncatalogued service can be characterised from a real session -- which is exactly
how the global fingerprint gets filled in after Early Access.

Server names now fall back to `Server <id>` instead of a hardcoded
`"未知服务器"`, so non-Taiwan players stay distinguishable.

## Upstream quality gates

`pnpm check` (format + lint + build) fails on a clean upstream checkout: 119
files have Prettier issues and ESLint reports 65 errors. Those are pre-existing.
Use the gates that are actually meaningful here:

```
pnpm build                  # tsc + vite -- must pass
cd src-tauri && cargo test --lib   # must pass
```

`cargo test` (without `--lib`) fails on the binary target only, because the
Windows manifest demands elevation and the test runner cannot launch it.

Do not run `pnpm format`: it rewrites 119 upstream files and would make every
future merge expensive.

Note that `CLAUDE.md` in this repo is upstream's unedited Tauri-template
boilerplate and describes a different app. Trust this file instead.

## Gotcha: moving the repository folder

Cargo and Tauri bake absolute paths into `src-tauri/target/`. After renaming or
moving the project directory, the next build fails with something like:

```
failed to read file '\?\...\<old-folder>\src-tauri\target\debug\build\
tauri-<hash>\out\permissions\app\autogenerated\commands\app_hide.toml'
```

That is stale build cache pointing at the old path, not a broken checkout. Fix:

```
cd src-tauri && cargo clean
```

The frontend is unaffected -- `pnpm build` keeps working across a move.

## Removed upstream leftovers

Four files committed to upstream by accident, none referenced by the build:

- `1.txt` — a raw packet hex dump from a live Taiwanese session. It contains
  other players' in-game nicknames, so it is not something to republish here.
- `gh-proxy.sh`, `proxy.sh` — local proxy wrappers for the maintainer's machine.
- `down_zed_remote.py` — a Zed remote-server installer, unrelated to this app.

## Versioning and releases

The version was reset to **0.1.0**. Upstream sits at 4.1.0, but that number
belongs to NOIA2's release channel; this fork publishes to its own, and the
updater compares an installed build against *these* releases. Carrying 4.1.0
forward would mean the first tag actually shipped here reads as a downgrade and
never offers itself.

0.1.0 rather than 1.0.0 is deliberate: nothing has been verified against a real
global session yet. 1.0.0 is worth saving for the build that demonstrably works
on the global servers.

### The updater points at this repository by construction

`.github/workflows/release.yml` derives the manifest URL from
`${{ github.repository }}`, so it resolves to whichever repo the workflow runs
in. Nothing points at upstream.

Upstream routed the primary endpoint through `gh-proxy.com`, a Chinese GitHub
mirror that exists to work around slow access there. That is an unnecessary third
party in this project's update path, so it was removed along with the two
workflow steps and the script that produced its manifest. GitHub is now the only
endpoint.

### Signing keys

A keypair was generated on 2026-09-08. The **public** key and the endpoint are
committed in `src-tauri/tauri.conf.json`, because both are public values and
baking them in means a local build behaves exactly like a CI build -- and it
drops one secret the workflow would otherwise need.

The private key and its password live outside this repository, at
`C:/Users/kapte/.aether-release/`, with a README explaining what goes where.
They are deliberately not in the project vault either: a signing key is the only
thing proving an update genuinely came from this project, and a vault that gains
a Git remote later would carry it in history.

The workflow needs two repository secrets, under Settings → Secrets and variables
→ Actions:

- `TAURI_SIGNING_PRIVATE_KEY`
- `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`

`GITHUB_TOKEN` is automatic. The `VITE_SUPABASE_*` secrets can stay unset; the
build simply ships with cloud features off.

### A broken build script, fixed

Upstream's `tauri:build` pointed at `src-tauri/tauri.bundle.conf.json` -- a file
that has never existed in the repository, verified with `git log --all`. Local
release builds could not run at all. It now matches what CI does:
`tauri build --bundles nsis,updater`, so a local build produces the same
artifacts the updater expects.

## Background

The home-screen background is a looping 1080p video (`public/aion2/bg.mp4`) drawn
over a still (`public/aion2/background.webp`) that the other pages use on its own.

Both were replaced. The still is now a frame of the video, so the pages agree with
each other, and it was moved from PNG to WebP: 1.8 MB to 143 KB for the same
image.

The video is re-encoded at CRF 26 -- 1.45 Mbps, below the 1.68 Mbps of the clip it
replaced, so it costs less to decode per frame despite running longer.

Playback pauses whenever nobody can see it. Upstream already paused on window
blur; that now also honours the Page Visibility API, which covers states the
window API alone does not report.

## Protocol tooling

Two additions exist for one purpose: the global servers launch once, and being
in game for every parser attempt is the slow part.

### Packet recording and replay

`src-tauri/src/dps_meter/capture/recorder.rs` writes raw packets to
`%APPDATA%/<app>/recordings/*.aetherpc`, tapped in the dispatcher **before**
reassembly, so a recording holds exactly what capture produced.

Replay pushes those packets back into the same channel the capturer feeds.
Reassembly, dispatch, parsing and aggregation then run identically to a live
session, because it is the same code path with the same input. Capture once,
iterate offline as many times as it takes.

The format is deliberately plain -- a 12-byte header, then one length-prefixed
record per packet, little-endian. A recording cut short by the app exiting reads
up to the cut rather than failing, which is covered by a test.

Recording is off by default and capped at 512 MB. Replay applies backpressure
when the queue runs deep: `Channel::try_send` drops the packet it is handed when
full, and a silently lossy replay would be worse than a slow one.

### Opcode census

`src-tauri/src/dps_meter/capture/census.rs` counts every dispatched packet by
opcode, recording payload size ranges and whether a parser claims it.

This answers the question that decides everything else on day one: are the
global opcodes the ones we already parse? Korea and Taiwan agree on all of them,
which is good evidence -- but a mismatch would present as an empty meter with no
error, so it is worth measuring rather than assuming.

Off by default; it sits on the per-packet path, so disabled costs one relaxed
atomic load.

### On Early Access day

1. Settings → Backend: switch on **Opcode census**, then **Start recording**.
2. Play for a few minutes -- ideally including real combat and a party.
3. Read the census. Familiar opcodes (`04,38` damage, `05,38` DoT, `2A/2B,38`
   buffs, `33,36` player info, `41,36` summon) at familiar sizes means the
   parsers should hold. Amber `?` rows are the work list.
4. Read Settings → Backend → **Observed traffic** for the server IPs and ids.
   Those fill in the global region fingerprint.
5. Stop recording. From then on, replay that file instead of playing.

### Diagnostics report

Settings → Runtime → **Copy report** turns a session into a plain-text summary:
version, region profile, the server IPs and ids observed, and the full opcode
tally. A copy is always written to `recordings/diagnostics-*.txt` as well, since
the clipboard can fail quietly and launch day happens once.

It exists so a session can be handed over by pasting rather than described screen
by screen.
