# Aether — working notes

A real-time DPS meter for AION 2, aimed at the global servers. Fork of
[NOIA2](https://github.com/ZDYoung0519/NOIA2) (GPL-3.0). Rust + Tauri 2 backend,
React 19 + TypeScript frontend.

Read [FORK.md](./FORK.md) for what diverges from upstream and why. It is the
authoritative record; this file is the short version.

## Commands

PowerShell 5.1 on the development machine has no `&&` — chain with `;`.

```
pnpm install
pnpm build                        # tsc + vite, ~6s
cd src-tauri; cargo test --lib    # 24 tests
pnpm tauri:dev                    # must be an ELEVATED terminal
pnpm tauri:build                  # NSIS installer + updater bundle
```

`pnpm tauri:dev` fails with OS error 740 outside an Administrator terminal:
packet capture needs elevation, and the Windows manifest demands it.

## Quality gates

**`pnpm check` fails on a clean checkout** — Prettier flags 119 files, ESLint
reports 65 errors, all inherited from upstream. **Never run `pnpm format`**: it
rewrites those files and makes every future upstream merge expensive.

The gates that mean something:

```
pnpm build
cd src-tauri; cargo test --lib
```

`cargo test` without `--lib` fails on the binary target only, because the test
runner cannot launch an executable that demands elevation.

## Conventions

- **Comments and logs in English**, everywhere.
- Keep diffs against upstream **small and anchored**. Upstream is still active,
  and `git fetch upstream && git merge upstream/main` should stay cheap.
- Files use **CRLF** with `core.autocrlf=true`. Scripts that rewrite files must
  preserve CRLF, or the diff becomes a whole-file rewrite.
- Moving the project directory requires `cargo clean` — Cargo and Tauri bake
  absolute paths into `src-tauri/target`.
- Path alias `@/` maps to `src/`.

## Layout

| Path | What lives there |
|---|---|
| `src-tauri/src/dps_meter/capture/` | Capture, TCP reassembly, dispatch, opcode parsing |
| `src-tauri/src/dps_meter/capture/recorder.rs` | Packet recording and replay |
| `src-tauri/src/dps_meter/capture/census.rs` | Opcode census |
| `src-tauri/src/dps_meter/region.rs` | Region profiles and traffic observations |
| `src-tauri/src/dps_meter/engine/` | DPS calculation, meter lifecycle |
| `src-tauri/src/plugins/` | Overlay windows, tray, logger, shortcuts |
| `src/games/aion2/` | Game UI, five overlay windows, bundled game data |
| `src/components/` | Shared UI, including the Runtime tools panel |
| `src/i18n/locales/` | English and Korean only |
| `docs/` | `AION2_PACKET_PROTOCOL_ANALYSIS.zh-CN.md` — upstream's protocol notes, in Chinese. Useful reference; not yet translated. |

## Things that will bite you

- **Cloud is optional and off.** Upstream reads Supabase credentials from a
  gitignored `.env`; without them `createClient` throws at module load. Anything
  touching it must go through `isCloudEnabled` or `requireSupabase()`.
- **Region profiles are load-bearing.** A server id is used *structurally* to
  locate fields inside player-info packets. Upstream hardcoded Taiwan's catalogue,
  which silently named no players anywhere else.
- **Overlays carry their own defaults.** They are separate HTML+JS entry points
  with their own config fallbacks and their own tiny i18n module. Changing an
  app-level default does not reach them.
- **Overlays are `.js`**, so `tsc` does not check them. Always run the full
  `pnpm build`, not just `tsc --noEmit`.
