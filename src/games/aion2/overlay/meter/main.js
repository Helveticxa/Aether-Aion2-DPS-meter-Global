import { installDevBrowserShim } from "@/lib/dev-browser-shim";

// Before the Tauri imports are used: lets the overlay render in a browser
// during development. A no-op in builds and inside the app.
installDevBrowserShim("dps-overlay");

import { getCurrentWindow } from "@tauri-apps/api/window";
import { LogicalSize } from "@tauri-apps/api/dpi";
import { listen, emit } from "@tauri-apps/api/event";
import { invoke } from "@tauri-apps/api/core";
import { t, setLanguage } from "../../i18n.js";
import serversData from "../../data/servers.json";

// Server name lookup
const _serverMap = new Map(serversData.map((s) => [s.serverId, s.serverShortName]));
function getServerName(serverId) {
  return _serverMap.get(Number(serverId)) || serverId || "";
}

// =============================================================================
// DOM cache
// =============================================================================
const $card = document.getElementById("card");
const $playerList = document.getElementById("player-list");
const $diag = document.getElementById("diag-message");
const $headTitle = document.getElementById("head-title");
const $headHp = document.getElementById("head-hp");
const $statusFightTime = document.getElementById("status-fight-time");
const $statusPing = document.getElementById("status-ping");
const $statusCpu = document.getElementById("status-cpu");
const $statusMem = document.getElementById("status-mem");
const $partyDps = document.getElementById("party-dps");
const $pinBtn = document.getElementById("pin-btn");
const $bossRow = document.getElementById("boss-row");
const $bossRowBar = document.getElementById("boss-row-bar");

const DEFAULT_TITLE = "Aether";

// =============================================================================
// Overlay config (applied via CSS variables)
// =============================================================================
const STORAGE_KEY = "app-config";
const DEFAULT_OVERLAY_CONFIG = {
  locked: false,
  alwaysOnTop: false,
  background: [10, 12, 18, 150],
  showPlayerName: true,
  showServer: false,
  showDamage: false,
  showDps: true,
  showCombatPower: true,
  showBossHp: true,
  pctMode: "contribution",
  contentScale: 1,
  detailWindowMode: "follow",
  autoResizeHeight: true,
  damageFormat: "K/M/B",
  fontFamily: "Segoe UI Variable",
};

let mainActorName = null;
let overlayConfig = { ...DEFAULT_OVERLAY_CONFIG };
let lastSnapshot = null;

function rgbaStr([r, g, b, a]) {
  return `rgba(${r},${g},${b},${(a / 255).toFixed(2)})`;
}

function clampContentScale(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 1;
  return Math.min(1.5, Math.max(0.7, n));
}

function updatePinButton() {
  const active = overlayConfig?.alwaysOnTop === true;
  $pinBtn.classList.toggle("is-active", active);
  $pinBtn.setAttribute("aria-pressed", active ? "true" : "false");
}

function persistOverlayConfigToLocalStorage(cfg) {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    const appConfig = raw ? JSON.parse(raw) : {};
    appConfig.aion2 = appConfig.aion2 || {};
    appConfig.aion2.overlay = { ...(appConfig.aion2.overlay || {}), ...cfg };
    localStorage.setItem(STORAGE_KEY, JSON.stringify(appConfig));
  } catch (err) {
    console.error("[dps-overlay] persist overlay config failed:", err);
  }
}

function syncAlwaysOnTopToBackend(enabled) {
  invoke("set_dps_always_on_top", { enabled }).catch((err) => {
    console.error("[dps-overlay] sync always-on-top failed:", err);
  });
}

function syncLockedToBackend(locked) {
  invoke("set_dps_overlay_locked", { locked }).catch((err) => {
    console.error("[dps-overlay] sync locked failed:", err);
  });
}

// Locked means click-through: the card still shows everything, it just never
// takes a click, so its controls stay hidden.
function applyLockedState(locked, { persist = false } = {}) {
  overlayConfig = { ...DEFAULT_OVERLAY_CONFIG, ...(overlayConfig || {}), locked };
  if (persist) {
    persistOverlayConfigToLocalStorage({ locked });
  }
  document.body.classList.toggle("is-locked", locked);
}

async function enablePvpMode() {
  let backendConfig = null;

  try {
    backendConfig = await invoke("get_dps_meter_config");
  } catch (err) {
    console.error("[dps-overlay] get backend config failed:", err);
  }

  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const appConfig = JSON.parse(raw);
      appConfig.aion2 = appConfig.aion2 || {};
      appConfig.aion2.backend = {
        ...(backendConfig || {}),
        ...(appConfig.aion2.backend || {}),
        pvpModeOn: true,
      };
      localStorage.setItem(STORAGE_KEY, JSON.stringify(appConfig));
      window.dispatchEvent(new CustomEvent("app-config-changed", { detail: appConfig }));
      backendConfig = appConfig.aion2.backend;
    } else if (backendConfig) {
      backendConfig = { ...backendConfig, pvpModeOn: true };
    }
  } catch (err) {
    console.error("[dps-overlay] persist pvp mode failed:", err);
    if (backendConfig) {
      backendConfig = { ...backendConfig, pvpModeOn: true };
    }
  }

  if (!backendConfig) return;

  try {
    await invoke("apply_dps_meter_config", { config: backendConfig });
  } catch (err) {
    console.error("[dps-overlay] enable pvp mode failed:", err);
  }
}

async function setAlwaysOnTop(enabled) {
  const nextConfig = {
    ...DEFAULT_OVERLAY_CONFIG,
    ...(overlayConfig || {}),
    alwaysOnTop: enabled,
  };
  applyOverlayConfig(nextConfig);
  persistOverlayConfigToLocalStorage(nextConfig);
  try {
    await invoke("set_overlay_config", { value: nextConfig });
  } catch (err) {
    console.error("[dps-overlay] set always-on-top failed:", err);
  }
}

function applyOverlayConfig(cfg) {
  overlayConfig = { ...DEFAULT_OVERLAY_CONFIG, ...(cfg || {}) };
  const root = document.documentElement;
  root.style.setProperty("--overlay-scale", String(clampContentScale(overlayConfig.contentScale)));
  root.style.setProperty("--overlay-bg", rgbaStr(overlayConfig.background));
  root.style.setProperty(
    "--font-family",
    `"${overlayConfig.fontFamily || "Segoe UI Variable"}", "Segoe UI", system-ui, sans-serif`
  );
  const autoResize = overlayConfig.autoResizeHeight !== false;
  document.body.classList.toggle("fixed-height", !autoResize);
  updatePinButton();
  applyLockedState(overlayConfig.locked === true);
  syncLockedToBackend(overlayConfig.locked === true);
  syncAlwaysOnTopToBackend(overlayConfig.alwaysOnTop === true);
  // Re-render existing rows immediately with new config
  if (lastSnapshot) {
    updateOverview(lastSnapshot);
    updatePlayerList(lastSnapshot);
  }
  scheduleAutoHeightReconcile();
}

// =============================================================================
// Keep the window exactly as tall as the card
// =============================================================================
const MIN_WINDOW_HEIGHT = 30;
const AUTO_RESIZE_FALLBACK_POLL_MS = 5000;
let autoHeightReconcileScheduled = false;

async function reconcileAutoHeight() {
  if (overlayConfig?.autoResizeHeight === false) return;

  // The card carries CSS zoom, and its rectangle is reported in the page's
  // own pixels -- already scaled -- which is what the window has to match.
  const targetHeight = Math.max(
    MIN_WINDOW_HEIGHT,
    Math.ceil($card.getBoundingClientRect().height)
  );

  try {
    const win = getCurrentWindow();
    const currentSize = await win.innerSize();
    const scaleFactor = await win.scaleFactor();
    const currentHeight = currentSize.height / scaleFactor;

    if (Math.abs(targetHeight - currentHeight) <= 1) return;

    const width = currentSize.width / scaleFactor;
    await win.setSize(new LogicalSize(width, targetHeight));
  } catch (err) {
    console.error("[dps-overlay] autoResize failed:", err);
  }
}

// Two frames: the first lets the new rows take their height, the second
// measures. requestAnimationFrame does not run while the window is hidden, so
// a timer stands in for it then -- the overlay comes back already the right
// size for the fight it is showing.
function scheduleAutoHeightReconcile() {
  if (overlayConfig?.autoResizeHeight === false) return;
  if (autoHeightReconcileScheduled) return;

  autoHeightReconcileScheduled = true;
  const run = async () => {
    autoHeightReconcileScheduled = false;
    await reconcileAutoHeight();
  };
  if (document.visibilityState === "hidden") {
    setTimeout(run, 0);
    return;
  }
  requestAnimationFrame(() => requestAnimationFrame(run));
}

function startAutoHeightFallbackPolling() {
  const poll = async () => {
    await reconcileAutoHeight();
    window.setTimeout(poll, AUTO_RESIZE_FALLBACK_POLL_MS);
  };

  window.setTimeout(poll, AUTO_RESIZE_FALLBACK_POLL_MS);
}

// =============================================================================
// Actions
// =============================================================================
// Every action used to swallow its own failure in an empty catch, so a button
// whose command failed was indistinguishable from a button that did nothing
// at all -- which is the single hardest kind of bug to report.
//
// Failures now say so on the overlay itself, and clear on their own.
let actionErrorTimer = 0;

function reportActionError(label, error) {
  console.error("[dps-overlay] " + label + " failed:", error);

  $diag.textContent = label + " failed — see the DPS Log";
  clearTimeout(actionErrorTimer);
  actionErrorTimer = setTimeout(() => {
    if ($diag.textContent.endsWith("— see the DPS Log")) {
      $diag.textContent = "";
      scheduleAutoHeightReconcile();
    }
  }, 6000);
  scheduleAutoHeightReconcile();
}

async function runAction(label, action) {
  try {
    await action();
  } catch (error) {
    reportActionError(label, error);
  }
}

// Dragging starts anywhere on the header except its buttons.
document.getElementById("drag-handle").addEventListener("mousedown", (event) => {
  if (event.button !== 0 || event.target.closest("button")) return;
  getCurrentWindow().startDragging();
});

document.getElementById("close-btn").addEventListener("click", () => {
  void runAction("Close overlay", () => getCurrentWindow().close());
});

$pinBtn.addEventListener("click", () => {
  setAlwaysOnTop(overlayConfig?.alwaysOnTop !== true);
});

document.getElementById("settings-btn").addEventListener("click", () => {
  void runAction("Settings", () => invoke("create_dps_settings"));
});

document.getElementById("reset-btn").addEventListener("click", () => {
  void runAction("Reset", () => invoke("reset_dps_meter"));
});

document.getElementById("history-btn").addEventListener("click", () => {
  void runAction("History", () => invoke("create_dps_history"));
});

document.getElementById("pvp-btn").addEventListener("click", () => {
  void runAction("PVP meter", async () => {
    await enablePvpMode();
    await invoke("create_pvp_overlay");
  });
});

function buildBattleReport(snap) {
  const players = snap.lastTargetAllPlayersOverviewStats || [];
  const targetInfo = getLastTargetInfo(snap);
  const allDmg = players.reduce((s, p) => s + p.totalDamage, 0);
  const dur = getTeamBattleDuration(targetInfo);
  const teamDps = dur > 0 ? allDmg / dur : 0;

  const fmtDmg = (n) =>
    n >= 1e9
      ? (n / 1e9).toFixed(2) + "B"
      : n >= 1e6
        ? (n / 1e6).toFixed(2) + "M"
        : n >= 1e3
          ? (n / 1e3).toFixed(1) + "K"
          : String(n);
  const fmtTime = (s) => {
    const m = Math.floor(s / 60),
      sec = Math.floor(s % 60);
    return m + "m" + String(sec).padStart(2, "0") + "s";
  };

  const target = targetInfo?.targetName ? `${targetInfo.targetName} · ` : "";
  let report = `${target}Duration ${fmtTime(dur)} · Total damage ${fmtDmg(allDmg)} · Party DPS ${Math.round(teamDps).toLocaleString("en-US")}\n`;
  for (const p of players) {
    report += `${p.actorName || "ID:" + p.actorId} · ${fmtDmg(p.totalDamage)} · ${Math.round(p.dps).toLocaleString("en-US")}/s\n`;
  }
  report += `\nRecorded with Aether — github.com/Helveticxa/Aether-Aion2-DPS-meter-Global`;
  return report;
}

// The overlay never takes focus, and the async clipboard API refuses an
// unfocused document. The older copy command only needs the click itself.
async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return;
  } catch (_) {
    /* fall through */
  }
  const area = document.createElement("textarea");
  area.value = text;
  area.setAttribute("readonly", "");
  area.style.position = "fixed";
  area.style.opacity = "0";
  document.body.appendChild(area);
  area.select();
  const copied = document.execCommand("copy");
  area.remove();
  if (!copied) throw new Error("clipboard unavailable");
}

document.getElementById("copy-report-btn").addEventListener("click", () => {
  if (!lastSnapshot) return;
  const report = buildBattleReport(lastSnapshot);
  void runAction("Copy report", async () => {
    await copyText(report);
    invoke("show_system_notification", {
      title: "Aether",
      body: "Battle report copied to clipboard",
    }).catch(() => {});
  });
});

// =============================================================================
// Diagnostic messages (checked in priority order)
// =============================================================================
const DIAG_MESSAGES = [
  { key: "npcapAvailable", i18n: "dps-overlay.diagNpcap" },
  { key: "meterRunning", i18n: "dps-overlay.diagMeter" },
  { key: "hasGameData", i18n: "dps-overlay.diagGameData" },
  { key: "playerIdentified", i18n: "dps-overlay.diagPlayerId" },
];

function setDiag(text) {
  if ($diag.textContent === text) return;
  $diag.textContent = text;
  scheduleAutoHeightReconcile();
}

async function runDiagnostic() {
  try {
    const state = await invoke("check_dps_meter_state");

    // Say when a setting is the reason there is nothing here. An empty meter
    // that explains itself is a setting to change; an empty meter that says
    // nothing reads as a broken app, and cost a whole play session to diagnose.
    if (!state.hasGameData && state.bossOnlyFiltered > 0) {
      setDiag(
        t("dps-overlay.diagBossOnly").replace("{count}", state.bossOnlyFiltered.toLocaleString())
      );
      return false;
    }

    for (const diag of DIAG_MESSAGES) {
      if (!state[diag.key]) {
        setDiag(t(diag.i18n));
        return false;
      }
    }
    setDiag("");
    return true;
  } catch (err) {
    console.error("[dps-overlay] diagnostic failed:", err);
    setDiag("Diagnostic error — check console");
    return false;
  }
}

// =============================================================================
// Formatters
// =============================================================================
function fmtDamage(n) {
  if (n == null || n === 0) return "--";
  if (overlayConfig?.damageFormat === "万/亿") return fmtDamageZh(n);
  // K/M/B
  if (n < 10_000) return String(n);
  if (n < 1_000_000) return (n / 1_000).toFixed(1) + "K";
  if (n < 1_000_000_000) return (n / 1_000_000).toFixed(2) + "M";
  return (n / 1_000_000_000).toFixed(2) + "B";
}

function fmtDamageZh(n) {
  if (n < 10_000) return String(n);
  if (n < 100_000_000) return (n / 10_000).toFixed(1) + "w";
  return (n / 100_000_000).toFixed(2) + "e";
}

function fmtDps(n) {
  if (n == null || n === 0) return "--";
  return Math.round(n).toLocaleString("en-US");
}

// Party DPS reads at a glance: 18.6K rather than 18,642.
function fmtCompact(n) {
  if (!Number.isFinite(n) || n <= 0) return "";
  if (n < 10_000) return Math.round(n).toLocaleString("en-US");
  if (n < 1_000_000) return (n / 1_000).toFixed(1) + "K";
  return (n / 1_000_000).toFixed(2) + "M";
}

// Combat power reads as an identity number, not a running total, so it is
// grouped rather than abbreviated -- 24,180 rather than 24.2K.
function fmtCombatPower(n) {
  if (!Number.isFinite(n) || n <= 0) return "";
  return Math.round(n).toLocaleString("en-US");
}

function fmtShare(n) {
  if (n == null) return "--";
  const pct = n * 100;
  if (pct >= 99.95) return "100%";
  return pct.toFixed(1) + "%";
}

function fmtHpPct(currentHp, maxHp) {
  if (!Number.isFinite(currentHp) || !Number.isFinite(maxHp) || maxHp <= 0) return "";
  const pct = Math.max(0, Math.min(100, (currentHp / maxHp) * 100));
  if (pct >= 99.95) return "100%";
  return pct.toFixed(1) + "%";
}

function fmtDuration(seconds) {
  if (!Number.isFinite(seconds) || seconds <= 0) return "";
  const total = Math.floor(seconds);
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const secs = total % 60;
  if (hours > 0) {
    return `${hours}:${String(minutes).padStart(2, "0")}:${String(secs).padStart(2, "0")}`;
  }
  return `${minutes}:${String(secs).padStart(2, "0")}`;
}

function maskName(name) {
  if (!overlayConfig?.maskNicknames) return name;
  const t = (name || "").trim();
  if (t.length <= 1) return t ? "*" : "";
  if (t.length === 2) return t[0] + "*";
  return t[0] + "*".repeat(t.length - 2) + t[t.length - 1];
}

// DPS counts toward its new value instead of snapping to it.
//
// One rAF loop drives every row, and it stops as soon as every row has settled
// -- a permanently running frame loop on an overlay is exactly the kind of cost
// that adds up over a long session. Each step writes one text node into a cell
// with a fixed width, so nothing outside the cell can reflow.
const DPS_TWEEN_RATE = 0.22;
const DPS_TWEEN_EPSILON = 1;
const tweeningCells = new Set();
let dpsTweenFrame = 0;

function stepDpsTweens() {
  dpsTweenFrame = 0;

  for (const cell of tweeningCells) {
    const target = cell._dpsTarget;
    let shown = cell._dpsShown;

    if (Math.abs(target - shown) <= DPS_TWEEN_EPSILON) {
      shown = target;
      tweeningCells.delete(cell);
    } else {
      shown += (target - shown) * DPS_TWEEN_RATE;
    }

    cell._dpsShown = shown;
    const text = fmtDps(shown);
    if (text !== cell._dpsRaw) {
      cell.dpsVal.textContent = text;
      cell._dpsRaw = text;
    }
  }

  if (tweeningCells.size > 0) {
    dpsTweenFrame = requestAnimationFrame(stepDpsTweens);
  }
}

function setDpsTarget(cell, value) {
  const target = Number.isFinite(value) ? value : 0;
  if (cell._dpsTarget === target) {
    return;
  }

  cell._dpsTarget = target;

  // A first value, a reset to zero, or a hidden window lands immediately --
  // counting up from nothing at the start of every fight would look like lag,
  // and a hidden window has no frames to count with.
  if (cell._dpsShown == null || target === 0 || document.visibilityState === "hidden") {
    cell._dpsShown = target;
    tweeningCells.delete(cell);
    const text = fmtDps(target);
    if (text !== cell._dpsRaw) {
      cell.dpsVal.textContent = text;
      cell._dpsRaw = text;
    }
    return;
  }

  tweeningCells.add(cell);
  if (!dpsTweenFrame) {
    dpsTweenFrame = requestAnimationFrame(stepDpsTweens);
  }
}

// =============================================================================
// Snapshot helpers
// =============================================================================
function getObjectValues(obj) {
  return Object.values(obj || {})
    .map(Number)
    .filter(Number.isFinite);
}

function getLastTargetInfo(snap) {
  if (snap.lastTargetInfo) return snap.lastTargetInfo;
  const targetId = snap.combatInfos?.lastTarget;
  if (targetId == null) return null;
  return (
    snap.combatInfos?.targetInfos?.[targetId] ??
    snap.combatInfos?.targetInfos?.[String(targetId)] ??
    null
  );
}

function getTeamBattleDuration(targetInfo) {
  const startTimes = getObjectValues(targetInfo?.targetStartTime);
  const lastTimes = getObjectValues(targetInfo?.targetLastTime);
  if (startTimes.length === 0 || lastTimes.length === 0) return 0;
  const start = Math.min(...startTimes);
  const end = Math.max(...lastTimes);
  return Math.max(0, end - start);
}

// =============================================================================
// Class icon and colour
// =============================================================================
const CLASS_ICON_PATH = "/aion2/class/";

// A colour per class, so a glance at the bars tells you the composition of the
// group without reading a single name. Grey is for a class the parser has not
// identified yet -- it should look unknown, not like some tenth class.
const CLASS_COLORS = {
  assassin: "168, 85, 247",
  chanter: "52, 211, 153",
  cleric: "251, 191, 36",
  elementalist: "34, 211, 238",
  fighter: "248, 113, 113",
  gladiator: "251, 146, 60",
  ranger: "163, 230, 53",
  sorcerer: "232, 121, 249",
  templar: "56, 189, 248",
};

function getClassColor(actorClass) {
  if (!actorClass) return "";
  return CLASS_COLORS[String(actorClass).toLowerCase()] || "";
}

function getClassIcon(actorClass) {
  if (!actorClass) return "";
  return CLASS_ICON_PATH + actorClass.toLowerCase() + ".png";
}

// =============================================================================
// Render: header (target, health, fight time)
// =============================================================================
function updateOverview(snap) {
  const targetInfo = getLastTargetInfo(snap);
  $statusFightTime.textContent = fmtDuration(getTeamBattleDuration(targetInfo));

  if (!targetInfo) {
    $headTitle.textContent = DEFAULT_TITLE;
    $headTitle.title = "";
    $headHp.textContent = "";
    $bossRow.hidden = true;
    return;
  }

  // What you are fighting, in the header where the app's name sits between
  // fights. Its health is the context every number below is relative to.
  const name = targetInfo.targetName || `Target ${targetInfo.id ?? ""}`.trim();
  $headTitle.textContent = maskName(name);
  $headTitle.title = name;

  const currentHp = Number(targetInfo.currentHp ?? 0);
  const maxHp = Number(targetInfo.maxHp ?? 0);
  const showHp = overlayConfig?.showBossHp !== false && maxHp > 0;

  if (!showHp) {
    $headHp.textContent = "";
    $bossRow.hidden = true;
    return;
  }

  const hpScale = Math.max(0, Math.min(1, currentHp / maxHp));
  $headHp.textContent = fmtHpPct(currentHp, maxHp);
  $headHp.title = `${fmtDamage(currentHp)} / ${fmtDamage(maxHp)}`;
  $bossRowBar.style.setProperty("--bar-scale", hpScale);
  if ($bossRow.hidden) {
    $bossRow.hidden = false;
    scheduleAutoHeightReconcile();
  }
}

// =============================================================================
// Player list — pre-allocated rows with diff/minimal DOM writes
// =============================================================================
const MAX_ROWS = 10;
const BAR_SCALE_FLOOR = 0.06;
const playerRows = new Map(); // actorId → { row, cells }
const rowPool = []; // pre-built hidden rows for reuse
let rowTemplate = null;
let lastRenderedCount = -1;

function buildRowTemplate() {
  const bar = document.createElement("div");
  bar.className = "player-row__bar";

  const content = document.createElement("div");
  content.className = "player-row__content";

  const left = document.createElement("div");
  left.className = "player-row__left";

  const iconWrap = document.createElement("div");
  iconWrap.className = "player-row__icon-wrap";
  const icon = document.createElement("img");
  icon.className = "player-row__icon";
  icon.alt = "";
  iconWrap.appendChild(icon);

  const nameWrap = document.createElement("div");
  nameWrap.className = "player-row__name-wrap";
  const nameEl = document.createElement("span");
  nameEl.className = "player-row__name";
  const serverEl = document.createElement("span");
  serverEl.className = "player-row__server";
  // Combat power sits with the name rather than the numbers: it says who this
  // is, not how they are doing.
  const powerEl = document.createElement("span");
  powerEl.className = "player-row__power";
  nameWrap.appendChild(nameEl);
  nameWrap.appendChild(serverEl);
  nameWrap.appendChild(powerEl);

  left.appendChild(iconWrap);
  left.appendChild(nameWrap);

  const right = document.createElement("div");
  right.className = "player-row__right";

  const damage = document.createElement("span");
  damage.className = "player-row__damage";

  const dpsWrap = document.createElement("span");
  dpsWrap.className = "player-row__dps";
  // dps value + /s unit are separate text nodes so we only update the value
  dpsWrap.appendChild(document.createTextNode(""));
  const dpsUnit = document.createElement("span");
  dpsUnit.className = "player-row__dps-unit";
  dpsUnit.textContent = "/s";
  dpsWrap.appendChild(dpsUnit);

  const share = document.createElement("span");
  share.className = "player-row__share";

  right.appendChild(damage);
  right.appendChild(dpsWrap);
  right.appendChild(share);

  content.appendChild(left);
  content.appendChild(right);

  const row = document.createElement("div");
  row.className = "player-row";
  row.style.display = "none";
  row.appendChild(bar);
  row.appendChild(content);

  rowTemplate = row;
}

// Wipe the "what is currently rendered" caches on a recycled row. Without this
// a row reused for a different player keeps the previous player's strings and
// skips writing the new ones, because the cache says they are already there.
function resetRow(entry) {
  const c = entry.cells;
  c._barScale = -1;
  c._iconSrc = null;
  c._nameRaw = "";
  c._serverRaw = "";
  c._powerRaw = "";
  c._damageRaw = "";
  c._dpsRaw = "";
  c._shareRaw = "";
  c._dpsShown = null;
  c._dpsTarget = null;
  return entry;
}

function newRow() {
  if (!rowTemplate) buildRowTemplate();
  const row = rowTemplate.cloneNode(true);

  // Direct child access (more reliable than querySelector on detached clones)
  const bar = row.children[0];
  const content = row.children[1];
  const left = content.children[0];
  const right = content.children[1];
  const icon = left.children[0].children[0];
  const nameWrap = left.children[1];

  // Listeners do not survive cloneNode.
  icon.addEventListener("error", () => {
    icon.style.display = "none";
  });
  icon.addEventListener("contextmenu", (e) => e.preventDefault());

  return resetRow({
    row,
    cells: {
      bar,
      icon,
      nameEl: nameWrap.children[0],
      serverEl: nameWrap.children[1],
      powerEl: nameWrap.children[2],
      damage: right.children[0],
      dpsVal: right.children[1].firstChild,
      share: right.children[2],
    },
  });
}

function createPlayerRow() {
  const entry = rowPool.length > 0 ? resetRow(rowPool.pop()) : newRow();

  // Rows are positioned rather than stacked, so a new one has to be attached
  // here -- there is no insertBefore doing it as a side effect.
  entry.row.style.display = "";
  entry.row.classList.add("is-entering");
  if (entry.row.parentNode !== $playerList) {
    $playerList.appendChild(entry.row);
  }

  // Two frames: one for the browser to accept the entering state as the start
  // of the transition, one to transition away from it. Hidden windows get no
  // frames, so the row simply arrives.
  if (document.visibilityState === "hidden") {
    entry.row.classList.remove("is-entering");
  } else {
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        entry.row.classList.remove("is-entering");
      });
    });
  }

  return entry;
}

function setText(cells, key, el, text) {
  if (cells[key] !== text) {
    el.textContent = text;
    cells[key] = text;
  }
}

function setShown(el, shown) {
  const display = shown ? "" : "none";
  if (el.style.display !== display) el.style.display = display;
}

function updatePlayerRow(entry, p, maxDamage) {
  const c = entry.cells;
  const cfg = overlayConfig || {};

  // A floor keeps the tail of the list visible: someone contributing 1% still
  // gets a readable sliver of their class colour.
  const rawScale = maxDamage > 0 ? p.totalDamage / maxDamage : 0;
  const barScale = rawScale > 0 ? Math.max(rawScale, BAR_SCALE_FLOOR) : 0;
  if (barScale !== c._barScale) {
    c.bar.style.setProperty("--bar-scale", barScale);
    c._barScale = barScale;
  }

  // Icon, and the class colour the bar is drawn in
  const iconSrc = getClassIcon(p.actorClass);
  if (iconSrc !== c._iconSrc) {
    if (iconSrc) {
      c.icon.src = iconSrc;
      c.icon.style.display = "";
    } else {
      c.icon.removeAttribute("src");
      c.icon.style.display = "none";
    }
    c._iconSrc = iconSrc;

    const rowColor = getClassColor(p.actorClass);
    if (rowColor) {
      entry.row.style.setProperty("--row-rgb", rowColor);
    } else {
      entry.row.style.removeProperty("--row-rgb");
    }
  }

  setShown(c.nameEl, cfg.showPlayerName !== false);
  if (cfg.showPlayerName !== false) {
    setText(c, "_nameRaw", c.nameEl, maskName(p.actorName || `ID:${p.actorId}`));
  }

  const showServer = cfg.showServer === true && p.actorServerId != null;
  setShown(c.serverEl, showServer);
  if (showServer) {
    setText(c, "_serverRaw", c.serverEl, String(getServerName(p.actorServerId)));
  }

  const showPower = cfg.showCombatPower !== false && p.combatPower > 0;
  setShown(c.powerEl, showPower);
  if (showPower) {
    setText(c, "_powerRaw", c.powerEl, fmtCombatPower(p.combatPower));
  }

  setShown(c.damage, cfg.showDamage === true);
  if (cfg.showDamage === true) {
    setText(c, "_damageRaw", c.damage, fmtDamage(p.totalDamage));
  }

  // DPS, counted toward rather than snapped to
  setShown(c.dpsVal.parentElement, cfg.showDps !== false);
  if (cfg.showDps !== false) {
    setDpsTarget(c, p.dps);
  }

  const pctValue = cfg.pctMode === "share" ? p.damageShare : p.damageContribution;
  setText(c, "_shareRaw", c.share, fmtShare(pctValue));
}

let rowHeightPx = 0;

function getRowHeight() {
  if (rowHeightPx > 0) {
    return rowHeightPx;
  }
  const raw = getComputedStyle(document.documentElement).getPropertyValue("--row-height");
  rowHeightPx = parseFloat(raw) || 26;
  return rowHeightPx;
}

function placeRow(entry, index) {
  const y = index * getRowHeight();
  if (entry._y === y) {
    return;
  }
  entry._y = y;
  entry.row.style.setProperty("--row-y", y + "px");
  entry.row.style.transform = "translateY(" + y + "px)";
}

// Recycled rows must forget everything, or a row reused for a different player
// counts from the previous player's DPS.
function releaseRow(entry) {
  tweeningCells.delete(entry.cells);
  entry.cells._dpsShown = null;
  entry.cells._dpsTarget = null;
  entry._y = undefined;
  entry.row.style.display = "none";
  entry.row.classList.remove("is-main");
  entry.row.classList.remove("is-entering");
  rowPool.push(entry);
}

// Your own row is never the one dropped: an overlay that hides you when you
// are eleventh is answering the wrong question.
function limitPlayers(players, mainName) {
  if (!players || players.length <= MAX_ROWS) {
    return players;
  }

  const shown = players.slice(0, MAX_ROWS);
  if (!mainName || shown.some((player) => player.actorName === mainName)) {
    return shown;
  }

  const main = players.find((player) => player.actorName === mainName);
  if (main) {
    shown[shown.length - 1] = main;
  }
  return shown;
}

function updatePlayerList(snap) {
  const mainName = snap.combatInfos?.mainActorName ?? null;
  const players = limitPlayers(snap.lastTargetAllPlayersOverviewStats, mainName) || [];
  mainActorName = mainName;

  document.body.classList.toggle("has-players", players.length > 0);

  // Party DPS: everyone on the target, together.
  const partyDps = players.reduce((sum, p) => sum + (Number(p.dps) || 0), 0);
  const partyText = players.length > 1 && partyDps > 0 ? `Party ${fmtCompact(partyDps)}/s` : "";
  if ($partyDps.textContent !== partyText) $partyDps.textContent = partyText;

  if (players.length === 0) {
    for (const [, entry] of playerRows) {
      releaseRow(entry);
    }
    playerRows.clear();
  } else {
    let maxDamage = 0;
    for (const p of players) {
      if (p.totalDamage > maxDamage) maxDamage = p.totalDamage;
    }

    const seen = new Set();
    players.forEach((p, index) => {
      seen.add(p.actorId);

      let entry = playerRows.get(p.actorId);
      if (!entry) {
        entry = createPlayerRow();
        playerRows.set(p.actorId, entry);
      }
      updatePlayerRow(entry, p, maxDamage);

      entry.row.classList.toggle("is-main", mainActorName != null && p.actorName === mainActorName);
      entry.row.dataset.actorId = p.actorId;

      // Rows live in one fixed order in the DOM and are moved with a
      // transform, so a rank change animates on the compositor instead of
      // being an insertBefore that redraws the list.
      placeRow(entry, index);
    });

    for (const [id, entry] of playerRows) {
      if (!seen.has(id)) {
        releaseRow(entry);
        playerRows.delete(id);
      }
    }
  }

  // The list is absolutely positioned, so it needs an explicit height for the
  // window to have anything to measure.
  if (players.length !== lastRenderedCount) {
    lastRenderedCount = players.length;
    $playerList.style.height = players.length * getRowHeight() + "px";
    scheduleAutoHeightReconcile();
  }
}

// =============================================================================
// Init
// =============================================================================
// GB once the number stops being readable in MB -- a PC sitting at 14 GB
// should not be rendered as 14336.
function formatMemory(mb) {
  if (!Number.isFinite(mb) || mb <= 0) {
    return "";
  }
  return mb >= 1024 ? `${(mb / 1024).toFixed(1)} GB` : `${mb.toFixed(0)} MB`;
}

(async function init() {
  // Lock state affects local UI too; register this before any async startup work
  // so the card cannot miss the initial backend event.
  listen("overlay-lock-toggled", (event) => {
    applyLockedState(event.payload?.locked === true, { persist: true });
  });

  // Pull initial overlay config from Rust store (avoids race with event timing)
  try {
    const cfg = await invoke("get_overlay_config");
    applyOverlayConfig(cfg && Object.keys(cfg).length > 0 ? cfg : DEFAULT_OVERLAY_CONFIG);
  } catch (e) {
    console.error("[dps-overlay] get_overlay_config failed:", e);
    applyOverlayConfig(DEFAULT_OVERLAY_CONFIG);
  }

  listen("overlay-config-changed", (event) => {
    applyOverlayConfig(event.payload);
  });

  // Backend state is the source of truth if an event was emitted before this
  // webview finished loading.
  try {
    const locked = await invoke("get_dps_overlay_locked");
    applyLockedState(locked === true);
  } catch (e) {
    console.error("[dps-overlay] get_dps_overlay_locked failed:", e);
  }

  try {
    const lang = await invoke("get_language");
    setLanguage(lang);
  } catch (_) {
    /* ignore */
  }

  listen("language-changed", (event) => {
    setLanguage(event.payload.language);
    runDiagnostic();
  });

  // Diagnostic polling, until the meter has everything it needs.
  let allOk = await runDiagnostic();
  if (!allOk) {
    const poll = setInterval(async () => {
      allOk = await runDiagnostic();
      if (allOk) {
        clearInterval(poll);
      }
    }, 2000);
  }

  try {
    listen("dps-memory", (event) => {
      const d = event.payload;

      // The whole machine, not Aether's slice of it. Someone glancing at this
      // mid-fight wants to know whether the PC is struggling.
      const cpu = d.systemCpuPercent ?? d.cpuPercent;
      if (cpu != null) {
        $statusCpu.textContent = `CPU ${cpu.toFixed(0)}%`;
      }

      const usedMb = d.systemMemoryUsedMb ?? d.rssMb;
      if (usedMb != null) {
        $statusMem.textContent = formatMemory(usedMb);
        const totalMb = d.systemMemoryTotalMb;
        $statusMem.title =
          totalMb > 0
            ? `${formatMemory(usedMb)} / ${formatMemory(totalMb)} used on this PC`
            : "Memory in use on this PC";
      }

      if (d.pingMs != null) {
        const ping = Math.round(d.pingMs);
        $statusPing.textContent = `${ping} ms`;
        $statusPing.className =
          "foot__ping " + (ping < 60 ? "good" : ping <= 120 ? "warn" : "bad");
      }
    });

    await listen("dps-snapshot", (event) => {
      const snap = event.payload;
      const targetInfo = getLastTargetInfo(snap);
      if (targetInfo != null && targetInfo.targetMobCode == null) {
        return;
      }
      lastSnapshot = snap;
      updateOverview(snap);
      updatePlayerList(snap);
    });
  } catch (err) {
    console.error("[dps-overlay] listen failed:", err);
    setDiag("Event listener error — check console");
  }

  // The window may have been created at any height; fit it once now.
  scheduleAutoHeightReconcile();
  startAutoHeightFallbackPolling();

  // Player row click → open detail window
  $playerList.addEventListener("click", (e) => {
    const row = e.target.closest(".player-row");
    if (!row) return;
    const actorId = Number(row.dataset.actorId);
    if (!actorId) return;

    void runAction("Player detail", async () => {
      const selection = { actorId, mode: "live" };
      await invoke("set_detail_selection", { value: selection });
      await invoke("create_dps_detail");
      await emit("select-player-detail", selection);
    });
  });
})();
