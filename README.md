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

## What it is

Aether reads AION 2 combat data by **passively sniffing network packets**. It
does not read or write game memory, inject code, modify packets, or automate any
part of the game. It is a monitor.

A floating overlay shows live DPS while you fight and steps aside when you
are not. Fights are saved to a searchable history and broken down by skill,
buff uptime, and damage type.

## Features

- **DPS meter** — a rounded glass overlay with class-coloured bars. It appears on
  your first hit, stays for the whole fight, and after five quiet minutes saves
  the fight to History, starts clean, and hides again (configurable)
- **Always on top** — keep your own signed-in Chrome or Edge above the game, with
  opacity and click-through. Works over any borderless game, and tells you when a
  game's exclusive fullscreen blocks every overlay
- **Live chat** — YouTube and Twitch chat over the game, transparent and
  outlined, one pop-up per chat or merged into one
- **Boss fights** — your pace against your personal best while you fight, and a
  summary when the boss dies: DPS, place, crits, top skills, one-click copy
- **Capsule mode** — the meter as one line that opens on hover
- English names for about 8,000 monsters and bosses
- Battle history with per-skill and per-player breakdowns, damage-type split,
  buff timelines, and cast ordering
- Finds the game, your character, and the server on its own — nothing to set up
- Global shortcuts, tray integration, light and dark themes, English and Korean
- Runs fully offline — nothing is uploaded

## What Aether never does

Anti-cheat (BattlEye in PUBG, AION 2's own) watches what other programs do to
the game. Aether is built so there is nothing to find:

- It never injects code into a game, loads anything into it, or hooks its
  graphics. That is also why nothing can appear over exclusive fullscreen:
  switch the game to borderless.
- It never opens a game's process, not even to read its name. Which program is
  in front comes from the system's process list, the way Task Manager sees it.
- It never reads or writes game memory, sends input, or automates anything.
- Packets are copied, never touched: Npcap, or WinDivert in sniff and
  receive-only mode. The WinDivert driver is loaded only when Npcap cannot
  capture, and unloaded when Aether is done with it.
- Always on top moves only Aether's windows and the browser windows you pin. A
  game's window is only looked at: its size and its style.

None of this is a promise about terms of service. Whether a publisher allows a
third-party tool is its call.

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

Aether accepts any structurally valid server id (`1001–1999`, `2001–2999`:
race × 1000 + index), so it parses on every service without being told which
one it is on. There is no region to pick.

Detection only claims a region on evidence. Korea is identifiable by its server
block; Taiwan and global are not yet, so they show as a new service rather than
a guess. Settings → Aion 2 → Connection shows the server, its address, and your
character as they are detected.

[FORK.md](./FORK.md) has the full reasoning.

## Protocol tooling

On a server no fingerprint matches, Aether records the first two minutes of
game traffic by itself, so the material for fixing a parser exists without
anyone having pressed Record in time. The newest five are kept.

Settings → Aion 2 → Connection → **Advanced** carries the rest:

| Tool | What it does |
|---|---|
| **Packet recording** | Writes raw packets to disk and replays them back through the live pipeline, so a session captured once can be worked on offline |
| **Opcode census** | Counts every packet by opcode, with payload sizes and whether a parser recognises it |
| **Diagnostics report** | Turns all of the above into one pasteable summary |

Recordings stay on your machine.

## Credit

The animated background is **Dune** by [R](https://vimeo.com/theraa), a motion
design piece published on Vimeo.

English monster and boss names, the Fighter's skill names, and the server codes
come from **[Kuroukihime/AIon2-Dps-Meter](https://github.com/Kuroukihime/AIon2-Dps-Meter)**
(GPL-3.0), merged by `scripts/build-npc-names.mjs`.

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
