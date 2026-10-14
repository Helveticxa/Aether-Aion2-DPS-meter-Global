<div align="center">

# Aether

**A real-time DPS meter for AION 2's global servers.**

[![Tauri](https://img.shields.io/badge/Tauri-2.x-24C8DB?logo=tauri&logoColor=white)](https://tauri.app/)
[![React](https://img.shields.io/badge/React-19-61DAFB?logo=react&logoColor=111)](https://react.dev/)
[![Rust](https://img.shields.io/badge/Rust-backend-000000?logo=rust&logoColor=white)](https://www.rust-lang.org/)
[![License](https://img.shields.io/badge/License-GPL--3.0--only-22C55E)](./LICENSE)

</div>

> [!NOTE]
> **Built and tested on the live global service** (Early Access 30 September,
> launch 5 October 2026). Every release since 3.0.0 is checked against recorded
> global sessions: the damage it reads on a boss matches the health the boss
> lost.

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
- **Accurate to the boss's health** — every hit the game sends is read, checked
  against the health the boss actually lost. The fight summary shows it:
  *Captured 100%* means nothing was missed
- **Follows you through dungeons** — each map and dungeon run starts clean, and
  the run you just left is saved to History
- **Always on top** — keep your own signed-in Chrome or Edge above the game, with
  opacity and click-through. Works over any borderless game, and tells you when a
  game's exclusive fullscreen blocks every overlay
- **Live chat** — YouTube and Twitch chat over the game, transparent and
  outlined, one pop-up per chat or merged into one
- **On stream** — Stream mode keeps the meter on screen, between fights too, so
  OBS captures the meter itself as a Window Capture
- **Kina calculator** — the Kina your characters make from the Expedition a
  week and a month, with the per-server play count, Special Quai, the Wind
  Breeze shop and Substance Morph, and whether buying or crafting Odyle Energy
  still pays
- **Boss fights** — your pace against your personal best while you fight, and a
  summary when the boss dies: DPS, place, crits, top skills, how much of the
  fight was captured, one-click copy
- **Capsule mode** — the meter as one line that opens on hover
- English names for about 9,000 monsters and bosses, and 1,384 bosses known by
  name for the Boss only filter
- Battle history with per-skill and per-player breakdowns, damage-type split,
  buff timelines, and cast ordering
- Finds the game, your character, and the server on its own — nothing to set up,
  including when the game's traffic passes through a local accelerator or proxy
  on 127.0.0.1
- Ping, read the way the global client reports it
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

## Streaming with OBS

The meter can go on stream on its own, as a window OBS captures: the meter
itself, not the Aether app.

1. Settings → Aion 2 → Overlay → **On stream (OBS)** → turn on **Stream mode**.
   The meter opens and stays on screen, between fights too. OBS lists only
   windows that are on screen.
2. In OBS: Sources → + → **Window Capture**, and pick
   `[Aether.exe]: Aether | DPS Overlay` — not `[Aether.exe]: Aether`, which is
   the app.
3. Set **Capture Method** to **Windows 10 (1903 and up)**. *Automatic* picks
   BitBlt for Aether, which cannot see its see-through window.

The show/hide shortcut still hides the meter. OBS does not need to run as
administrator.

## Kina calculator

The third icon in the sidebar. Add your characters with their item level,
server and Special Quai, and it works out what they make from the Expedition, a
week and a month, in Kina:

- energy from regeneration (15 every 3 hours), the Wind Breeze shop (20 Odyle
  Energy a character a week, 100,000 Kina each, with Special Quai) and
  Substance Morph (4 a character and 16 a server a week);
- the cubes that buys, in the best dungeon each character's item level allows,
  with Special Quai claiming a run's cube twice;
- the Cumulative Play Reward Adjustment, per server across all your characters:
  past play 83 cubes pay 80%, then 60, 40 and 20%;
- what a crafted Odyle Energy costs at the prices you give its materials, and
  whether one more bought or crafted still pays.

**Best plan** works out how much to buy and craft on each character for the
most Kina. Every number is editable for the next patch, and stays on your PC.

## Install

1. Download the installer from [Releases](../../releases) and run it.
2. Launch Aether **as Administrator** — packet capture requires it.

Windows 10 or 11. No separate driver install: Aether bundles WinDivert and
checks the capture environment on startup, holding the app closed until it can
actually capture. If nothing is available it offers to install
[Npcap](https://npcap.com/#download) for you.

## Built for the global servers

Aether started as the only AION 2 meter aimed at the global service, and was
ready for it on day one. Global turned out to speak the same protocol as Taiwan
-- what it needed was a meter that reads every packet of it.

Upstream validated server ids against Taiwan's exact catalogue. That value is not
cosmetic — it is used *structurally*, to find where the server field sits inside a
player-info packet. On any other service every candidate is rejected and **no
player is ever named**: an empty meter, with no error to explain it.

Aether accepts any structurally valid server id (`1001–1999`, `2001–2999`:
race × 1000 + index), so it parses on every service without being told which
one it is on. There is no region to pick.

Detection only claims a region on evidence: Korea by its server block, global by
your character's server, which Taiwan does not have. Settings → Aion 2 →
Connection shows the server, the game connection, and your character as they
are detected, and Connection → Advanced shows how cleanly each connection is
being read.

### Accuracy

What the meter reads is checked against the game itself: the damage dealt to a
boss should add up to the health it lost. On recorded global sessions it does,
to within the killing blow's overkill (100.1-100.4%). Version 3.0.0 fixed a
packet-framing bug inherited from upstream that dropped about a quarter of all
damage in busy fights, and the player's identity on entering a dungeon --
which is why the meter sometimes did not appear there. [FORK.md](./FORK.md)
has the details.

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

English monster and boss names, the boss and training-dummy lists, the
Fighter's skill names, and the server codes come from
**[Kuroukihime/AIon2-Dps-Meter](https://github.com/Kuroukihime/AIon2-Dps-Meter)**
(GPL-3.0), merged by `scripts/build-npc-names.mjs`. Its work on the global
client's ping format pointed the way for ours.

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

See [FORK.md](./FORK.md) for how the code is organised and the gotchas worth knowing before
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
