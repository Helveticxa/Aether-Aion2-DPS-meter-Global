<div align="center">

# Aether

**A real-time DPS meter for AION 2, built for the global servers.**

[![Tauri](https://img.shields.io/badge/Tauri-2.x-24C8DB?logo=tauri&logoColor=white)](https://tauri.app/)
[![React](https://img.shields.io/badge/React-19-61DAFB?logo=react&logoColor=111)](https://react.dev/)
[![Rust](https://img.shields.io/badge/Rust-backend-000000?logo=rust&logoColor=white)](https://www.rust-lang.org/)
[![License](https://img.shields.io/badge/License-GPL--3.0--only-22C55E)](./LICENSE)

</div>

---

> [!IMPORTANT]
> **Pre-release.** AION 2 launches globally on **5 October 2026** (Early Access from
> 30 September). Every existing AION 2 meter targets the Korean or Taiwanese
> service; this fork exists to be ready for the global one on day one.
>
> The capture pipeline and the region profiles described below are implemented and
> tested. What is **not** yet confirmed against a real global session: the exact
> opcodes, the global server-id range, and the server-name catalogue. Those get
> filled in from the first Early Access capture.

## What it is

Aether reads AION 2 combat data by **passively sniffing network packets**. It does
not read or write game memory, inject code, modify packets, or automate any part
of the game. It is a monitor.

It shows a floating overlay with live DPS while you play, keeps a searchable
history of past fights, and breaks each encounter down by skill, buff uptime, and
damage type.

## Credit

Aether is a fork of **[NOIA2](https://github.com/ZDYoung0519/NOIA2)** by
[zdyoung](https://github.com/ZDYoung0519), which does the heavy lifting: the Rust
capture pipeline, the packet parsers, the overlay, and the game-data catalogues.
That project is the reason this one could start from a working meter instead of a
blank page. If Aether is useful to you, consider
[supporting upstream](https://ifdian.net/a/zdyoung).

Both projects are **GPL-3.0-only**. Screenshots below are from the upstream build;
the interface is shared.

## Why a fork

The upstream project targets the Taiwanese service, and one detail made it unable
to work anywhere else.

Its player-name parser validated server ids against Taiwan's exact catalogue:

```rust
fn is_available_server_id(server_id: u32) -> bool {
    (1001..=1021).contains(&server_id) || (2001..=2021).contains(&server_id)
}
```

That value is not cosmetic. It is used **structurally** — the parser scans candidate
offsets and uses "is this a valid server id?" to decide where the server field sits
inside a player-info packet. On a service whose ids fall outside Taiwan's range,
every candidate is rejected, `find_server_id` returns `None`, and **no player is
ever named**. Not an error, not a warning: an empty meter.

Aether replaces that constant with region profiles.

| Profile | Server-id rule |
|---|---|
| **Auto** (default) | `1001..=1999`, `2001..=2999` |
| **Taiwan** | `1001..=1021`, `2001..=2021` (the bundled catalogue) |
| **Korea**, **Global** | same permissive rule as Auto |

The permissive rule is structural rather than a shrug: server ids are
`raceId * 1000 + index` (race 1 Elyos, race 2 Asmodian), confirmed by the bundled
Taiwan server list. An arbitrary `u16` still fails the check, so the parser keeps
the disambiguation it depends on — it simply no longer assumes how many servers a
region runs.

### Detection only claims a region on evidence

Capture itself was already region-agnostic upstream: rather than a hardcoded
address, it scans every network interface for the heartbeat magic
`[0x0E, 0x00, 0x36]` and infers the device and port from whichever one answers.
That should carry to the global servers unchanged.

Region *identification* is a separate problem, and Aether does not guess at it.
Korea is identifiable by its server block (`206.127.156.0/24`, taken from the MIT
[TK-open-public](https://github.com/TK-open-public/Aion2-Dps-Meter) meter). Taiwan
and global have no known block, so detection reports "no fingerprint matched"
instead of inferring a region from an id range they may well share.

Instead, **Settings → Backend shows the server IPs and server ids actually
observed**. That readout is how an uncatalogued service gets characterised from a
real session — and it is how the global fingerprint will be established after
Early Access.

## Features

Inherited from upstream:

- Floating DPS overlay in two styles, with click-through and opacity control
- Live ping, CPU, and memory footer
- Battle history with per-skill and per-player breakdowns
- Damage-type split, buff timelines, and cast ordering
- Character scoring, damage rankings, and class statistics
- Multi-window workflow, global shortcuts, tray integration
- English, Korean, Traditional Chinese, and Simplified Chinese

Added by this fork:

- Region profiles with an observation readout (above)
- Runs fully offline — cloud features are optional and off by default
- Server names fall back to `Server <id>` rather than a hardcoded "unknown server",
  so players on uncatalogued services stay distinguishable
- **English throughout.** Upstream defaulted to Simplified Chinese and carried a
  few hundred hardcoded Chinese strings; those are translated, and the Chinese
  locales are gone. English and Korean remain.
- Character search and the damage leaderboard are **hidden**, because both need a
  community backend this build cannot reach — a Taiwan-only character API and the
  Supabase project behind the leaderboard. Better absent than broken.

## Requirements

- Windows 10 or 11
- [Npcap](https://npcap.com/#download) — **tick "Install Npcap in WinPcap
  API-compatible Mode"** during installation
- **Administrator rights.** Packet capture needs them, and the Windows manifest
  demands elevation; the app cannot start from an unelevated shell (it fails with
  OS error 740).

## Build from source

```
pnpm install
pnpm build
```

Then, from an **elevated** terminal:

```
pnpm tauri:dev
```

To produce an installer:

```
pnpm tauri:build
```

Toolchain: Rust (MSVC toolchain), Node 18+, pnpm, and the MSVC build tools.

## Development notes

`pnpm check` fails on a clean checkout — Prettier flags 119 files and ESLint
reports 65 errors, all inherited from upstream. Do not run `pnpm format`: it would
rewrite those files and make every future upstream merge expensive.

The gates that are actually meaningful:

```
pnpm build                        # tsc + vite
cd src-tauri && cargo test --lib  # 17 tests
```

`cargo test` without `--lib` fails on the binary target only, because the manifest
demands elevation and the test runner cannot launch it.

Changes against upstream are kept small and anchored so that
`git fetch upstream && git merge upstream/main` stays cheap. See
[FORK.md](./FORK.md) for the full record of what diverges and why.

Note that `CLAUDE.md` in this repository is upstream's unedited Tauri-template
boilerplate and describes a different application. Trust `FORK.md` instead.

The application icons under `src-tauri/icons/` are still upstream's NOIA2 artwork.
They need replacing before any public release.

## Screenshots

_From the upstream build, so they still show NOIA2 branding and a Chinese UI. The
layout is shared; the text in this build is English._

| Home | DPS overlay |
|:--:|:--:|
| ![Home](./docs/images/home.png) | ![Overlay](./docs/images/dps.png) |

| Combat detail | Rankings |
|:--:|:--:|
| ![Detail](./docs/images/dps_detail.png) | ![Rankings](./docs/images/dps_rank.png) |

## Disclaimer

This tool reads network traffic on your own machine. It does not inject code,
modify memory, or alter game traffic, and it uploads nothing by default.

That said, it is third-party software. Use it at your own discretion and in
accordance with the game's terms of service. Nobody here can promise you how
NCSoft will treat any particular tool.

## License

[GPL-3.0-only](./LICENSE), inherited from NOIA2. Any distributed build must ship
its source under the same terms.
