<div align="center">

# Aether

**A real-time DPS meter for AION 2, built for the global servers.**

[![Tauri](https://img.shields.io/badge/Tauri-2.x-24C8DB?logo=tauri&logoColor=white)](https://tauri.app/)
[![React](https://img.shields.io/badge/React-19-61DAFB?logo=react&logoColor=111)](https://react.dev/)
[![Rust](https://img.shields.io/badge/Rust-backend-000000?logo=rust&logoColor=white)](https://www.rust-lang.org/)
[![License](https://img.shields.io/badge/License-GPL--3.0--only-22C55E)](./LICENSE)

</div>

> [!IMPORTANT]
> **Pre-release.** AION 2 launches globally on **5 October 2026**, Early Access
> from **30 September**. Nothing here has been confirmed against a real global
> session yet — the exact opcodes, the server-id range, and the server-name
> catalogue all get filled in from the first capture.

![DPS overlay](./docs/images/dps.png)

## What it is

Aether reads AION 2 combat data by **passively sniffing network packets**. It
does not read or write game memory, inject code, modify packets, or automate any
part of the game. It is a monitor.

A floating overlay shows live DPS while you play. Fights are saved to a
searchable history and broken down by skill, buff uptime, and damage type.

## Features

- Floating overlay in two styles, with click-through and opacity control
- Interactive map with an always-on-top minimap overlay
- Live ping, CPU, and memory footer
- Battle history with per-skill and per-player breakdowns
- Damage-type split, buff timelines, and cast ordering
- Multi-window workflow, global shortcuts, tray integration
- English and Korean
- Runs fully offline — nothing is uploaded

## Install

1. Download the installer from [Releases](../../releases) and run it.
2. Launch Aether **as Administrator** — packet capture requires it.

Windows 10 or 11. No separate driver install: Aether bundles WinDivert and
checks the capture environment on startup, holding the app closed until it can
actually capture. If nothing is available it offers to install
[Npcap](https://npcap.com/#download) for you.

## Built for the global servers

Every other AION 2 meter targets Korea or Taiwan. This fork exists to work on the
global service from day one.

Upstream validated server ids against Taiwan's exact catalogue. That value is not
cosmetic — it is used *structurally*, to find where the server field sits inside a
player-info packet. On any other service every candidate is rejected and **no
player is ever named**: an empty meter, with no error to explain it.

Aether replaces that with region profiles:

| Profile | Server-id rule |
|---|---|
| **Auto** (default) | `1001–1999`, `2001–2999` |
| **Taiwan** | `1001–1021`, `2001–2021` |
| **Korea**, **Global** | same as Auto |

Detection only claims a region on evidence. Korea is identifiable by its server
block; Taiwan and global are not yet, so it reports "no fingerprint matched"
rather than guessing. Settings → Runtime shows the server IPs and ids actually
observed, which is how an uncatalogued service gets identified.

[FORK.md](./FORK.md) has the full reasoning.

## Protocol tooling

Settings → Runtime carries three tools built for launch day:

| Tool | What it does |
|---|---|
| **Packet recording** | Writes raw packets to disk and replays them back through the live pipeline, so a session captured once can be worked on offline |
| **Opcode census** | Counts every packet by opcode, with payload sizes and whether a parser recognises it |
| **Diagnostics report** | Turns all of the above into one pasteable summary |

All off by default. Recordings stay on your machine.

## Screenshots

<table>
<tr>
<td width="50%"><img src="./docs/images/home.png" alt="Home" /></td>
<td width="50%"><img src="./docs/images/dps_detail.png" alt="Combat detail" /></td>
</tr>
<tr>
<td align="center"><sub>Home</sub></td>
<td align="center"><sub>Combat detail</sub></td>
</tr>
</table>

<sub>From the upstream build, so they still show NOIA2 branding and a Chinese UI.
The layout is shared; this build is in English.</sub>

## Credit

Aether is a fork of **[NOIA2](https://github.com/ZDYoung0519/NOIA2)** by
[zdyoung](https://github.com/ZDYoung0519), which does the heavy lifting: the Rust
capture pipeline, the packet parsers, the overlay, and the game-data catalogues.
That project is the reason this one could start from a working meter instead of a
blank page.

If Aether is useful to you, consider
[supporting upstream](https://ifdian.net/a/zdyoung).

## Build from source

```
pnpm install
pnpm build
```

Then, from an **elevated** terminal:

```
pnpm tauri:dev      # run
pnpm tauri:build    # produce an installer
```

Needs Rust (MSVC toolchain), Node 18+, pnpm, and the MSVC build tools.

See [CLAUDE.md](./CLAUDE.md) for conventions and the gotchas worth knowing before
changing anything.

## Disclaimer

This tool reads network traffic on your own machine. It does not inject code,
modify memory, or alter game traffic, and it uploads nothing.

It is still third-party software. Use it at your own discretion and in accordance
with the game's terms of service. Nobody here can promise how NCSoft will treat
any particular tool.

## License

[GPL-3.0-only](./LICENSE), inherited from NOIA2. Any distributed build must ship
its source under the same terms.
