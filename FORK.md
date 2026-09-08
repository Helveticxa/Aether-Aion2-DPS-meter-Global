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
