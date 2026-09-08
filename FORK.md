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

### Before the first release

The workflow triggers on a `v*` tag and needs three repository secrets, none of
which exist yet:

- `TAURI_SIGNING_PUBLIC_KEY`
- `TAURI_SIGNING_PRIVATE_KEY`
- `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`

Generate the pair locally with `pnpm tauri signer generate`, then add them under
Settings → Secrets and variables → Actions. Without them the updater cannot
verify a download and the release job fails its own guard check.

The `VITE_SUPABASE_*` secrets referenced by the workflow can stay unset; the
build simply ships with cloud features off.

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
