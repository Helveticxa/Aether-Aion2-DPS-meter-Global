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

### The startup gate, and the driver upstream forgot to ship

`src-tauri/resources/windivert/` holds both `WinDivert.dll` and
`WinDivert64.sys`, and `scripts/copy-windivert-runtime.ps1` copies both into
`src-tauri/target/<profile>/` before a dev run — so WinDivert works for whoever
is building it. But `tauri.conf.json` listed only the DLL under `bundle.resources`,
and that list is what the NSIS installer ships. Every *installed* copy therefore
had no driver file at all, and reported `WinDivert64.sys was not found` forever.

The service registration proves it: on a machine that had run 0.1.4, the
`WinDivert` kernel service existed and pointed at
`\??\C:\Program Files\Aether\WinDivert64.sys`, a path with no file behind it.
Upstream papered over this at runtime instead — `repair_windivert_runtime`
downloaded the `.sys` from a Supabase bucket and wrote it into the install
directory, with no integrity check. That command is gone; the driver is bundled.

For the record, the vendored binaries are **byte-identical** to the official
`WinDivert-2.2.2-A.zip` from `basil00/WinDivert` (sha256
`8da085…ddc2` for the driver). The Chinese company on the driver's Authenticode
signature is upstream WinDivert's own signer, not something this fork's ancestor
introduced.

`src-tauri/src/dps_meter/preflight.rs` replaces `check_capture_runtime_status`
with a weighed report:

- **Required vs optional is computed, not fixed.** Capture needs one backend, so
  Npcap is only required while WinDivert cannot stand in for it. An unavailable
  WinDivert beside a working Npcap is shown in grey and never blocks — the old
  screen dressed it in amber next to the word "starting", which is what made a
  perfectly healthy machine look broken.
- **The Npcap probe enumerates adapters** rather than loading `wpcap.dll`, which
  keeps succeeding after the driver service stops.
- **The gate is authoritative.** `enter_app` re-runs the checks in Rust and
  refuses if anything required fails, and `preflight::passed()` gates
  `show_main_window`, so the tray icon and a second launch cannot open the app
  behind a gate that is still holding.
- **`install_npcap`** fetches the pinned installer, verifies its SHA-256 before
  executing anything, and re-checks when it exits. Npcap reserves silent
  installation for its OEM licence, so its own window still appears.

### Cloud features made optional

*Superseded in 2.2.0: the cloud code is removed entirely. See "Removed in
2.2.0" below. Kept for the history of why it never worked here.*

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
well share. Settings → Aion 2 → Connection shows the observed server IPs and ids
so an uncatalogued service can be characterised from a real session -- which is
exactly how the global fingerprint gets filled in after Early Access.

**Since 2.2.0 there is no region to pick.** `Auto` parses on every service, so
the other profiles could only ever make things worse; `DpsMeterConfig::normalized`
brings a stored region back to `Auto`, and the picker is gone from Settings.
The profiles stay in `region.rs` because detection still names Korea.

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

`CLAUDE.md` carries the short version of these notes for day-to-day work.

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

The home-screen background is a looping 1080p video
(`public/aion2/bg-dune.mp4`) drawn over a still
(`public/aion2/background-dune.webp`) that the other pages use on their own.

Since 2.0.0 it is **Dune** by [R](https://vimeo.com/theraa), credited in the README
and on the in-app Credits page. It replaced the flower video. The file names
changed with it, so a webview cache can never serve the old clip after an
update.

- The video is re-encoded from the 60 fps original to 30 fps H.264 at CRF 27
  (`-tune animation`, faststart, no audio track): 3.8 MB to 1.7 MB. At full
  resolution, thin line work on black is indistinguishable from the source, and
  decoding costs half as much per second.
- The still is the frame at 2.45 s, taken from the source, not the re-encode,
  and stored as lossless WebP: 32 KB against the 143 KB of the one it replaced.
  It is also the video's `poster`, so there is no black flash before playback.
- In the light theme both are inverted with `filter: invert(1)` (the
  `bg-artwork` class): white line work on black becomes ink on paper, drawn by
  the compositor at no extra cost.

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

### Automatic recording (2.2.0)

On a server no fingerprint matches, the meter records the first two minutes of
game traffic by itself, once per meter session (`auto_record_tick` in
`engine/meter.rs`, on the memory-snapshot thread). Files are named `auto-*` and
only the newest five are kept (`recorder::prune_recordings`); a recording
started by hand is never pruned and never interrupted. Today that is every
Taiwan and global session, because neither has a fingerprint yet. Once the
global server block is catalogued, it stops by itself for global.

It exists because launch day is exactly when nobody thinks to press Record in
time. Off switch: Settings → Aion 2 → Connection → Advanced.

### On Early Access day

1. Start the meter and play. The first two minutes are recorded automatically.
2. Settings → Aion 2 → Connection → Advanced: switch on **Opcode census**.
   Start a manual recording as well if a longer session is wanted.
3. Read the census. Familiar opcodes (`04,38` damage, `05,38` DoT, `2A/2B,38`
   buffs, `33,36` player info, `41,36` summon) at familiar sizes means the
   parsers should hold. Amber `?` rows are the work list.
4. Connection shows the server IPs and ids. Those fill in the global region
   fingerprint.
5. From then on, replay the recording instead of playing.

### Diagnostics report

Settings → Aion 2 → Connection → Advanced → **Copy report** turns a session into a plain-text summary:
version, region profile, the server IPs and ids observed, and the full opcode
tally. A copy is always written to `recordings/diagnostics-*.txt` as well, since
the clipboard can fail quietly and launch day happens once.

It exists so a session can be handed over by pasting rather than described screen
by screen.

## The meter between fights (2.2.0)

Upstream never ended a fight. Totals piled up target after target until
someone pressed Reset, and the whole pile was cloned and sent to the overlay on
every snapshot. The overlay also sat on screen whether or not anything was
happening.

**Activity, not damage, decides.** `DataStorageInner::activity_at` records the
last hit that belongs to your fight (`is_own_fight`): one you dealt, one you
took, or one your party landed on your current target -- a healer can go minutes
without a hit of their own on a boss. Before the game has said who you are,
every hit counts. Other people fighting nearby move nothing.

The snapshot loop then does two things each tick:

- **Idle reset.** `idle_reset_secs` (default 300, 0 = never) after the last
  activity, the fight is saved to History and the meter starts clean
  (`end_idle_fight`). A meter holding only strangers' fights is cleared
  without a record, measured from its start time, so it cannot grow unseen.
- **Visibility.** With `hide_when_idle` on, the overlay is hidden while there
  is no activity since the last reset, unless a *peek* is running: 8 s after
  Start, 4 s after Reset, and 15 s from the show shortcut when the overlay is
  only idle-hidden.

Hiding goes through `aion2_focus`, which already owned the overlay's
visibility, as one more reason next to the manual hotkey and the game's focus
(`Aion2FocusState::wanted_visibility`, tested). The poller skips its work while
no overlay is open.

**Never do window calls on the snapshot thread.** Getters such as
`is_visible` wait on the event loop, and the event loop joins the snapshot
thread in `stop_dps_meter` -- a sync command, so on the main thread. That is a
deadlock waiting for the wrong moment. `set_dps_idle_hidden_for_app` posts the
window work with `run_on_main_thread` instead.

The overlay is built `focusable(false)`: the show shortcut can create it while
you are in the game, and a new window takes the keyboard by default.

## Boss fights (2.3.0)

**English names.** `src-tauri/data/npc_names_en.json` (mob code -> name, about
8,000) replaces upstream's Traditional Chinese catalogue, in the backend and in
History alike. It is built by `scripts/build-npc-names.mjs` from
Kuroukihime/AIon2-Dps-Meter's `mobs.json` (GPL-3.0), with NOIA2's partial
English names as a fallback; placeholder names ("None") are dropped. A target
the catalogue does not name is labelled `Boss <code>` or `Mob <code>`. The
Fighter's skill names, the server codes, and the healing-skill labels come from
the same project. The snapshot builder used to clone the whole name map five
times a second; it now looks names up one at a time
(`DataStorage::mob_name`).

**Personal bests** (`dps_meter/personal_best.rs`, tested) keep your best DPS
per character and boss in `history/personal_bests.json`, apart from the
history so deleting it keeps them. They learn from every record the history
saves, and are seeded from the history on disk on first run. A fight counts
when the target is a boss and it lasted at least 15 seconds; shorter kills
produce DPS figures no real fight reaches. The meter now saves the fight on
`stop_dps_meter` too, which used to throw it away.

**The overlay** asks for the best once per boss and character
(`get_personal_best`), shows the pace in the footer after 10 seconds of a boss
fight, and drops its cache on `personal-bests-updated`.

**Fight summary**, in the overlay. A boss whose health reaches zero gets a final
summary. A boss that goes quiet for 15 seconds gets a provisional one, which
gives way if the fight resumes and is replaced if the boss then dies, so a
phase transition cannot swallow the real summary. Skill names load on first
use (`lib/skill-names.js`, a split chunk), not with the overlay.

**Capsule mode** is `overlay.layout = "compact"`: one line with your DPS,
place, and time, expanded while the pointer is on the card or a summary is
up. The collapse waits 350 ms so crossing the card's edge does not make the
window jump.

## Staying clear of anti-cheat (2.4.0)

Anti-cheat judges a program by what it does to the game's process, not by
what it shows. An audit in 2.4.0 found no injection, memory access, input, or
hooks anywhere, but three things a strict anti-cheat could still count against
the player. All three are gone.

- **`System::new_all()` in the memory snapshot loop.** It was only after
  Aether's own CPU and memory, but on Windows `sysinfo` loads every process:
  `OpenProcess(PROCESS_QUERY_INFORMATION | PROCESS_VM_READ)` on each one, the
  game included, handles held for the life of the `System`, and
  `ReadProcessMemory` on each PEB for command lines. The loop now builds a
  `System` with machine totals only and refreshes Aether's own pid with
  memory and CPU only. **Never use `System::new_all()` or refresh all
  processes with `sysinfo`.**
- **`OpenProcess` on the foreground window's process**, to learn its name, in
  `aion2_focus`, `game_display`, and `on_top`. The foreground window is
  usually the game. `plugins/process_names.rs` answers from a Toolhelp
  process snapshot instead (the kernel's process list, no handle), cached
  for five seconds. The one remaining `OpenProcess` is on Explorer, to launch
  browsers unelevated.
- **Loading the WinDivert driver just to ask.** The startup gate, the Connection
  status, and `check_state` each opened WinDivert, which installs and starts
  its kernel service and leaves it loaded until reboot. Some anti-cheats treat
  a loaded WinDivert as a warning sign, because lag switches use it. Npcap is
  asked first everywhere now; WinDivert is opened only when Npcap fails, or
  when Settings puts it first. `windivert_capturer` counts its handles and,
  when the last closes, stops the `WinDivert` service if Aether was the one
  that started it. WinDivert marks its service for deletion on start, so
  stopping it also removes it.

Capture itself was already passive: Npcap copies packets, and WinDivert is
opened with `SNIFF | RECV_ONLY`, so it can neither drop, delay, alter, nor
inject anything.

## Always on top

A page of its own (`/aion2/on-top`) that keeps the player's **own** Chrome or
Edge above the game: a guide, a stream, a video. Backend in
`src-tauri/src/plugins/on_top/`, page in
`src/games/aion2/pages/always-on-top.tsx`.

### Why it drives the real browser instead of embedding one

A webview would have its own cookie jar, so every site means signing in again.
Google refuses sign-in inside embedded webviews outright, and Chrome's cookies
are bound to Chrome itself, so they cannot be carried over either. The only way
to keep someone's accounts, extensions, and YouTube Premium is to use the browser
they already run, so this feature never opens a browser of its own. It does two
things:

- **Pins windows that are already open.** `SetWindowPos(HWND_TOPMOST)` from
  outside the process, the same mechanism PowerToys' Always On Top uses.
- **Opens compact app windows**: `chrome.exe --app=<url> --profile-directory=<dir>`.
  The browser that is already running takes the request and opens the window in
  that profile, signed in. It gets no tab strip and no address bar.

Detection is automatic for any install. It checks the registry's App Paths
(per user, per machine, and the 32-bit view) and then the standard install
locations. Profiles, names, and account pictures come from the browser's
`Local State`, which is only ever read. An unknown profile directory is never
passed on, because the browser would quietly create a new empty profile.

### Rules that keep other people's windows safe

- **The browser is launched as the desktop user, never elevated.** Aether runs
  as Administrator, and a child process inherits that token. An elevated browser
  is a security problem, and it also breaks every later normal launch, because
  those try to hand their URL to the elevated instance and UIPI refuses. When
  elevated, the process is created with Explorer as its parent through
  `PROC_THREAD_ATTRIBUTE_PARENT_PROCESS`, which makes it inherit Explorer's
  ordinary token. If that fails, the launch is refused rather than falling back
  to an elevated start.
- **Nothing blocks on the browser.** Placement uses `SWP_ASYNCWINDOWPOS` and
  `ShowWindowAsync`, and a window that `IsHungAppWindow` reports as hung is not
  restyled. Nothing activates either: pinning never takes focus from the game.
- **Everything is undone.** The window's own z-order and layering are recorded
  at pin time and restored on unpin, on exit (`RunEvent::Exit`), and before an
  update installs. A crash or a kill from Task Manager skips all of those, so
  the pinned set is also written to `on-top-session.json` in app data, and the
  next start restores whatever is still open. The pid check guards against a
  reused window handle.
- **A watcher runs only while something is pinned.** Every 750 ms it drops
  windows that closed, notices a hidden window the player restored by hand, and
  puts back a topmost flag or layering the browser dropped. It stops as soon as
  nothing is pinned.

Opacity and ghost mode rely on `WS_EX_LAYERED` (plus `WS_EX_TRANSPARENT` for
click-through). Before building on it, this was checked against Chrome 153 and
Edge 153 playing hardware-decoded H.264. The video kept playing and composited
correctly at 55%.

The browser's own window border is left alone. 0.1.14 coloured it amber
(pinned) or cyan (ghost) through `DWMWA_BORDER_COLOR`, and players found it
distracting on top of the browser. From 0.1.15 the state shows only inside
Aether. The one remaining call resets the border to the system default during
crash recovery, for windows 0.1.14 coloured before an abrupt exit.

### Game integration

`aion2_focus` hides the DPS overlays when the foreground window is not
`Aion2.exe`, so clicking a pinned video to pause it used to hide the meter. It
now asks `on_top::is_managed()` and treats a pinned window as part of the game
session.

Three global shortcuts, all configurable in Settings: `Ctrl+Alt+T` pins the
browser window the player is in (browsers only, never a game or system window),
`Ctrl+Alt+G` toggles ghost mode, and `Ctrl+Alt+H` hides or shows every pinned
window. A ghost window cannot be clicked, so its shortcut is the way back.

Shortcut registration used to stop at the first failure, which left every
shortcut after it dead. One combination held by another program no longer costs
the others. The failures are reported, and the page marks them.

### Over fullscreen games (2.4.0)

`plugins/game_display.rs` looks at the window in front on every foreground
change and on a 1.5 s tick while anything of ours is on screen, for any game,
not only AION 2. A window covering its monitor is **Borderless** without a
frame, or **Fullscreen** when `SHQueryUserNotificationState` reports
`QUNS_RUNNING_D3D_FULL_SCREEN`.

- Borderless and fullscreen-with-optimizations are composed by DWM, so topmost
  windows show. A game can sit in the topmost band itself and rise over ours
  when activated, so `on_top::raise_all_over` re-asserts `HWND_TOPMOST`
  with `SWP_NOACTIVATE` on each of our windows that is below it. Only our
  windows and pinned browsers are moved; the game's is never touched.
- True exclusive fullscreen bypasses DWM. Nothing another process draws can
  appear, Discord's, Steam's, and NVIDIA's overlays included, short of
  injecting into the game, which is exactly what anti-cheat bans. Windows
  cannot tell exclusive from optimized fullscreen, so Aether keeps raising and
  explains once, per game per run, in a Windows notification.
- The page reads, never writes, two settings: the exe's Compatibility flag
  `DISABLEDXMAXIMIZEDWINDOWEDMODE` (matched by exe name, since the full path
  would mean opening the game's process) and Windows 11's
  `SwapEffectUpgradeEnable` ("Optimizations for windowed games"), with a
  button to `ms-settings:display-advancedgraphics`.

### Live chat pop-ups (YouTube and Twitch)

The page's second mode shows live chats on their own, over the game, with no
background: the look stream overlays use. A pinned browser cannot do this. A
browser page's background cannot be made see-through while its text stays
solid, and lowering a window's opacity fades the words with everything else.

Up to four chats, from YouTube and Twitch, each in its own pop-up or all merged
into one. 2.0.0 restyled YouTube's popout chat page inside the pop-up. That
could not merge two platforms into one list, and ran a whole web application
per pop-up. So since 2.1.0 Aether reads the chats itself (`on_top/chat/`) and
draws them in its own page (`overlay/chat/`):

- **Connectors**, one per chat, run as tasks in the backend and are shared by
  every pop-up showing that chat. The hub starts one when a pop-up needs it and
  stops it when none does, and keeps each chat's last 60 messages so a new or
  changed pop-up does not start empty.
  - **YouTube** (`youtube.rs`) uses the same requests as youtube.com's own chat
    frame, with no sign-in: the `live_chat` page gives the API key, client
    version, and the "Live chat" or "Top chat" continuation, and
    `youtubei/v1/live_chat/get_live_chat` returns messages and the next
    continuation, polled every 1.5 to 2.5 seconds. Paid messages and stickers,
    memberships, and removals are handled.
  - **Twitch** (`twitch.rs`) uses anonymous chat: IRC over TLS to
    `irc.chat.twitch.tv:6697` as `justinfan<n>`, read-only by construction. It
    uses rustls with its own root store, not the system's. Emotes come from the
    message tags, and subs and raids become highlighted lines. Lines are
    handed on in batches of up to 150 ms, so a busy channel redraws a pop-up a
    few times a second rather than per message. Commands are read from the
    command field: "RECONNECT" typed into chat is a PRIVMSG.
  - Bans and timeouts (Twitch `CLEARCHAT`, YouTube
    `removeChatItemByAuthorAction`) take the author's messages off the
    pop-ups and out of the backlog; a cleared Twitch chat clears them.
  - Both reconnect with a backoff (3, 8, 20, 45 s) and report a state
    (connecting, live, ended, error) that the page and the pop-up show.
- **Pop-ups** are transparent, undecorated windows labelled `aion2-chat-<n>`.
  Ids are never reused, so a new pop-up cannot collide with one still being torn
  down. Messages reach a pop-up as `chat-events` addressed to its label; style
  and chat changes as `chat-config`. **The page must listen on its own
  window** (`getCurrentWebviewWindow().listen`). A global `listen` is
  registered for target `Any`, and Tauri hands an `Any` listener every event
  whatever it was addressed to: in 2.1.0 each separate pop-up drew the other
  pop-ups' chats. The page also drops batches for chats it does not show.
- **Pop-ups never take the keyboard.** They are built unfocusable
  (`WS_EX_NOACTIVATE`); moving mode makes them focusable for as long as it
  lasts. Ghost and hide go through Win32 (`win32::set_click_through`,
  `set_shown` with `SW_SHOWNOACTIVATE`), not tao: tao re-shows a visible
  window with `SW_SHOW` on every style change it makes. tao's flags are
  brought back in line when moving mode starts and ends. A style change waits
  on the window's thread, so none of these is made with the hub locked.
- **`chat_apply`** takes the whole layout at once. A pop-up already showing
  exactly the requested chats keeps them. The others are reused in order and
  keep their place on screen, and extra pop-ups close. So closing one pop-up
  and applying again does not shuffle chats between windows
  (`match_overlays`, tested).
- **Input** is parsed in Rust (`source.rs`): watch, live, Studio, youtu.be, and
  embed links, a bare video id, a channel (`@handle`, `/channel/`, `/c/`), and
  twitch.tv links including popout and embed paths. A YouTube channel resolves
  to its current stream through the canonical link of `/<channel>/live`.
- **TikTok is recognised and refused.** It has no public chat API, its web
  requests are signed, and live comments are hidden from viewers who are not
  signed in: checked on streams with 900 and 1,700 viewers. The page explains
  this and offers the TikTok live as a pinned mini window instead, in the
  player's own signed-in browser.

Placement: pop-ups go side by side before they stack (`cornerSequence`),
because two large chats in one column overlap on a 1080p screen. Moving one
into another's corner swaps them. A pop-up moved by hand remembers its
rectangle, and a saved rectangle that is no longer on any monitor falls back to
the corner.

Safety of what is drawn: every piece of chat text goes in through
`textContent`. Every image (avatars, badges, emotes) must be https on the
platforms' own hosts (`message::safe_image`) and loads with `no-referrer`. Ghost
is `set_ignore_cursor_events`, and the ghost and hide shortcuts cover the
pop-ups along with pinned windows. The pop-ups are excluded from the
window-state plugin, which would otherwise restore a title bar left on mid-move.

2.1.1 was checked with two real pop-ups (a non-elevated example build): a
YouTube and a Twitch pop-up held 81 and 100 messages, each from its own chat
only; ghost, hide, and show left both windows inactive; merging reused the first
pop-up and closed the second.

Checked against real streams through the hub, with no window: one YouTube and
one Twitch chat gave 79 and 32 messages in 14 seconds, merged by time, and every
connector stopped once the pop-ups were gone. The page and the pop-up renderer
were checked in a browser with the backend mocked: separate and merged layouts,
swapping corners, an unknown Twitch channel, a TikTok link, and both themes.

## Light theme

Upstream's pages and most of Aether's are written white-on-dark glass:
`text-white/60`, `bg-white/6`, `bg-black/45`, some three hundred of them. In
the light theme that put white text on a white wash. Rewriting three hundred
class names across upstream files would make every merge painful, so
`src/index.css` instead redefines `--color-white` and `--color-black` under
`.light`. Tailwind compiles every one of those utilities through the variables,
so each becomes its dark-on-light twin in one place. The pastel accents
(cyan-300, amber-200, ...) were picked for dark glass; under `.light` they map
to deep shades of the same hue.

The exceptions are literal: text that must stay white on a coloured fill (a red
button, a profile colour) uses `text-[#fff]`, and white primary buttons take
`text-black`, which the swap turns white on an ink button.

Also fixed: `dark:` variants followed the operating system rather than the
theme the app chose, because Tailwind v4 defaults to the media query. A
`@custom-variant` ties them to the `.dark` class.

## Repository cleanup

The fork inherited a fair amount of scaffolding and dead weight. Removed:

- **~1.7 MB of unreferenced JSON at the repository root** (`mobs.json`,
  `npc_names.json`, `npc_data.json`, `abnormal_ids_full.json`). The copies the
  build actually uses live under `src/games/aion2/data/` and `src-tauri/data/`.
- **`.agents/skills/`** and `skills-lock.json` — vendored third-party agent
  documentation for shadcn and Tauri, unrelated to this project.
- **Path of Exile 2 scaffolding.** `POE2_GAME` was never in `ALL_GAMES`, its
  routes were unreachable, and the background assets it referenced did not exist.
- **The Tauri starter's demo page** (`src/pages/home.tsx`, reachable only through
  the dead POE2 route), its logo assets, and the `greet` command that served it.
- **Template tutorials** `docs/I18N.md`, `docs/AUTO_UPDATE.md`, and
  `docs/GLOBAL_SHORTCUT.md`, along with their Chinese translations. They describe
  the scaffold, not this app; auto-update is documented above instead.
- **Nested `CLAUDE.md` files and `AGENTS.md`**, which repeated the same
  inaccurate template description in three more places.

`docs/AION2_PACKET_PROTOCOL_ANALYSIS.zh-CN.md` is kept. It is upstream's protocol
analysis and real domain knowledge, in Chinese and not yet translated.

### Removed in 2.2.0

Aether was narrowed to three features: the DPS meter, Always on top, and live
chat. Git keeps everything below; none of it shipped anything the user wanted.

- **Interactive map** (page, minimap overlay, `aion2_map*` plugins, the 8 zone
  images, the import script, the asset protocol it needed). Tiles downloaded
  into `%APPDATA%/<app>/maps` are deleted on the next start
  (`remove_retired_app_data` in `lib.rs`), because an update never runs the
  old uninstaller.
- **Main Character card** and what only it used: the Fengwo lookup, the generic
  `http_request` proxy command (any webview could make arbitrary requests
  through it), the gear-slot component, and `get_main_character`.
- **Buff monitor** overlay and settings, its two per-buff events, and
  `buff_templates.json`. Buff *intervals* are still recorded: the detail
  window's coverage timeline reads them.
- **Event and field boss timers**, including the `01,91` parser. The opcode
  stays in `KNOWN_PACKET_HEADERS`, so the stall resync and the census treat it
  as before.
- **Upstream cloud**: Supabase, the account modal, the deep-link sign-in, and
  History's upload buttons (which could never succeed without upstream's
  private backend, and ran on every open). The `aether://` scheme earlier
  installers registered is removed by `NSIS_HOOK_POSTINSTALL`.
- The dialog and fs plugins (nothing called them), `plugin-process` (the
  updater never returns on Windows), the game picker over the logo (one game,
  and its menu could stick open), the outdated usage guide, upstream
  screenshots, and 200+ translation keys nothing referenced.

Fixed along the way: `index.html` pointed its favicon at `/vite.svg`, a file that
is not in `public/`.

The application icons under `src-tauri/icons/` remain upstream's NOIA2 artwork.
That is a deliberate choice, not an oversight.
