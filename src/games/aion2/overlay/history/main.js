import { getCurrentWindow } from "@tauri-apps/api/window";
import { listen } from "@tauri-apps/api/event";
import { invoke } from "@tauri-apps/api/core";
import { getNpcName } from "@/games/aion2/lib/npc-names";
import { t, setLanguage } from "../../i18n.js";

// ── DOM ──
const $list = document.getElementById("record-list");
const $count = document.getElementById("header-count");
const $empty = document.getElementById("empty");
const $status = document.getElementById("history-status");
const $deleteAll = document.getElementById("delete-all-btn");
const $targetFilter = document.getElementById("target-filter");
const $actorFilter = document.getElementById("actor-filter");
const $targetFilterLabel = document.getElementById("target-filter-label");
const $actorFilterLabel = document.getElementById("actor-filter-label");
let allRecords = [];
let expandedId = null;
const ALL_FILTER_VALUE = "__all__";

document.getElementById("close-btn").addEventListener("click", async () => {
  try {
    await getCurrentWindow().close();
  } catch (_) {
    /* ignore */
  }
});

let statusTimer = 0;

function setStatus(message, type = "") {
  $status.textContent = message;
  $status.className = `history-status${type ? ` is-${type}` : ""}`;
  $status.style.display = message ? "block" : "none";
  clearTimeout(statusTimer);
  if (message) {
    statusTimer = setTimeout(() => setStatus(""), 4000);
  }
}

// Module scope, not init() scope: the handlers below are bound out here, and
// one of them was calling this where it could not be seen.
async function load() {
  try {
    const records = await invoke("get_history");
    allRecords = Array.isArray(records) ? records : [];
    refreshFilterOptions();
    applyFilters();
  } catch (e) {
    console.error("[dps-history] load failed:", e);
  }
}

$deleteAll.addEventListener("click", async () => {
  if (allRecords.length === 0) {
    setStatus(t("dps-history.noRecordsToDelete"), "error");
    return;
  }
  try {
    const count = await invoke("delete_all_history");
    setStatus(t("dps-history.deletedCount", { count }), "success");
    await load();
  } catch (e) {
    setStatus(e?.message || t("dps-history.deleteFailed"), "error");
  }
});

// ── Formatters ──
function getDamageFormat() {
  try {
    const raw = localStorage.getItem("app-config");
    if (raw) return JSON.parse(raw)?.aion2?.overlay?.damageFormat ?? "K/M/B";
  } catch (_) {}
  return "K/M/B";
}

function fmtDamage(n) {
  if (!n) return "0";
  if (getDamageFormat() === "万/亿") {
    if (n < 1e4) return String(n);
    if (n < 1e8) return (n / 1e4).toFixed(1) + "w";
    return (n / 1e8).toFixed(2) + "e";
  }
  if (n < 1e4) return String(n);
  if (n < 1e6) return (n / 1e3).toFixed(1) + "K";
  if (n < 1e9) return (n / 1e6).toFixed(2) + "M";
  return (n / 1e9).toFixed(2) + "B";
}
function fmtTime(ms) {
  const d = new Date(ms);
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getMonth() + 1}/${d.getDate()} ${p(d.getHours())}:${p(d.getMinutes())}`;
}
function fmtDps(n) {
  if (!n) return "--";
  return Math.round(n).toLocaleString("en-US");
}
function fmtPct(n) {
  return (n * 100).toFixed(1) + "%";
}
function esc(s) {
  if (!s) return "";
  const d = document.createElement("div");
  d.textContent = s;
  return d.innerHTML;
}
function getTargetInfo(r) {
  if (r.targetInfo) return r.targetInfo;
  return (
    r.combatInfos?.targetInfos?.[String(r.targetId)] ||
    r.combatInfos?.targetInfos?.[r.targetId] ||
    null
  );
}
function getTargetMobCode(r) {
  return getTargetInfo(r)?.targetMobCode ?? null;
}
function getTargetName(r) {
  // const targetInfo = getTargetInfo(r);
  // const targetName = targetInfo?.targetName?.trim();
  // if (targetName) return targetName;

  const mobCode = getTargetMobCode(r);
  const npcName = mobCode ? getNpcName(mobCode) : null;
  if (npcName) {
    return `${npcName} (${mobCode})`;
  }

  const targetLabel = t("dps-history.unknownTarget", { id: r.targetId });
  return mobCode ? `${targetLabel} (${mobCode})` : targetLabel;
}
function getClassIcon(c) {
  return c ? "/aion2/class/" + c.toLowerCase() + ".png" : "";
}
function hasActorName(p) {
  return typeof p?.actorName === "string" && p.actorName.trim().length > 0;
}
function getRecognizedPlayers(record) {
  return Object.values(record.playerStats || {})
    .filter(hasActorName)
    .sort((a, b) => b.totalDamage - a.totalDamage);
}
function getAllPlayers(record) {
  return Object.values(record.playerStats || {}).sort((a, b) => b.totalDamage - a.totalDamage);
}
function getMainPlayerName(record) {
  const mainActorId = record.combatInfos?.mainActorId;
  const mainActorName = record.combatInfos?.mainActorName;
  if (typeof mainActorName === "string" && mainActorName.trim()) {
    return mainActorName.trim();
  }

  const mainPlayer =
    mainActorId != null
      ? record.playerStats?.[String(mainActorId)] || record.playerStats?.[mainActorId]
      : null;
  if (hasActorName(mainPlayer)) {
    return mainPlayer.actorName.trim();
  }

  return getRecognizedPlayers(record)[0]?.actorName?.trim() || "";
}
function getMainPlayerFilterName(record) {
  return getMainPlayerName(record) || t("dps-history.unknownMainActor");
}
function countOptions(values) {
  const counts = new Map();
  for (const value of values) {
    if (!value) continue;
    counts.set(value, (counts.get(value) || 0) + 1);
  }
  return [...counts.entries()]
    .map(([value, count]) => ({ value, count }))
    .sort((a, b) => {
      if (b.count !== a.count) return b.count - a.count;
      return a.value.localeCompare(b.value, undefined, { numeric: true, sensitivity: "base" });
    });
}
function setSelectOptions(select, options, allLabel) {
  const oldValue = select.value || ALL_FILTER_VALUE;
  select.innerHTML = [
    `<option value="${ALL_FILTER_VALUE}">${esc(allLabel)}</option>`,
    ...options.map(
      (option) =>
        `<option value="${esc(option.value)}">${esc(option.value)} (${option.count})</option>`
    ),
  ].join("");
  select.value = options.some((option) => option.value === oldValue) ? oldValue : ALL_FILTER_VALUE;
}
function refreshFilterOptions() {
  $targetFilterLabel.textContent = t("dps-history.targetFilter");
  $actorFilterLabel.textContent = t("dps-history.actorFilter");
  setSelectOptions(
    $targetFilter,
    countOptions(allRecords.map(getTargetName)),
    t("dps-history.allTargets")
  );
  setSelectOptions(
    $actorFilter,
    countOptions(allRecords.map(getMainPlayerFilterName)),
    t("dps-history.allActors")
  );
  $targetFilter.disabled = allRecords.length === 0;
  $actorFilter.disabled = allRecords.length === 0;
}
function applyFilters() {
  const targetValue = $targetFilter.value || ALL_FILTER_VALUE;
  const actorValue = $actorFilter.value || ALL_FILTER_VALUE;
  const records = allRecords.filter((record) => {
    if (targetValue !== ALL_FILTER_VALUE && getTargetName(record) !== targetValue) return false;
    if (actorValue !== ALL_FILTER_VALUE && getMainPlayerFilterName(record) !== actorValue) {
      return false;
    }
    return true;
  });
  render(records);
}

// ── Render record list ──
function render(records) {
  const lbl = records.length === 1 ? t("dps-history.record") : t("dps-history.records");
  $count.textContent =
    records.length === allRecords.length
      ? `${records.length} ${lbl}`
      : `${records.length} / ${allRecords.length} ${lbl}`;
  $deleteAll.disabled = allRecords.length === 0;

  if (records.length === 0) {
    $empty.style.display = "";
    $list.innerHTML = "";
    return;
  }
  $empty.style.display = "none";
  const sortedRecords = records.slice().sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0));

  let html = "";
  for (const r of sortedRecords) {
    const name = getTargetName(r);
    const playerCount = getRecognizedPlayers(r).length;
    const mainPlayerName = getMainPlayerName(r);
    html += `
      <div class="record-row" data-id="${r.id}">
        <button class="record-row__delete" data-delete="${r.id}" title="Delete">&times;</button>
        <div class="record-row__header">
          <span class="record-row__name">${esc(name)}</span>
          <span class="record-row__time">${fmtTime(r.createdAt)}</span>
        </div>
        <div class="record-row__footer">
          <div class="record-row__players">
            ${mainPlayerName ? `<span class="record-row__main-player">${esc(mainPlayerName)}</span>` : ""}
            <span>${playerCount} ${playerCount === 1 ? t("dps-history.player") : t("dps-history.players")}</span>
            <span class="record-row__damage"><em>${t("dps-overlay.totalDamage")}</em> ${fmtDamage(r.totalDamage)}</span>
          </div>
        </div>
        <div class="record-row__detail" id="detail-${r.id}" style="display:none"></div>
      </div>`;
  }
  $list.innerHTML = html;
  expandedId = null;
}

// ── Expand record → show player list ──
function toggleExpand(id) {
  const record = allRecords.find((r) => r.id === id);
  if (!record) return;
  const detailEl = document.getElementById("detail-" + id);
  if (!detailEl) return;

  if (expandedId === id) {
    detailEl.style.display = "none";
    expandedId = null;
    return;
  }

  // Collapse previous
  if (expandedId) {
    const prev = document.getElementById("detail-" + expandedId);
    if (prev) prev.style.display = "none";
  }

  const players = getAllPlayers(record);
  let html = `<div class="detail-player-list">`;
  for (const p of players) {
    const icon = getClassIcon(p.actorClass);
    const name = p.actorName || `ID:${p.actorId}`;
    html += `
      <div class="detail-player-row" data-actor-id="${p.actorId}">
        ${icon ? `<img class="detail-player-row__icon" src="${icon}" alt="" onerror="this.style.display='none'"/>` : ""}
        <span class="detail-player-row__name">${esc(name)}</span>
        <span class="detail-player-row__damage">${fmtDamage(p.totalDamage)}</span>
        <span class="detail-player-row__dps">${fmtDps(p.dps)}</span>
        <span class="detail-player-row__share">${fmtPct(p.damageShare)}</span>
      </div>`;
  }
  if (players.length === 0) {
    html += `<div class="detail-player-empty">${t("dps-detail.noData")}</div>`;
  }
  html += `</div>`;
  detailEl.innerHTML = html;
  detailEl.style.display = "";
  expandedId = id;
}

// ── Click handler ──
$list.addEventListener("click", async (e) => {
  // Delete
  if (e.target.closest("[data-delete]")) {
    e.stopPropagation();
    e.preventDefault();
    try {
      await invoke("delete_history_record", {
        id: e.target.closest("[data-delete]").dataset.delete,
      });
    } catch (_) {}
    return;
  }

  // Player row click → open detail window
  const playerRow = e.target.closest(".detail-player-row");
  if (playerRow) {
    e.stopPropagation();
    const actorId = Number(playerRow.dataset.actorId);
    const record = allRecords.find((r) => r.id === expandedId);
    if (!record || !actorId) return;
    try {
      await invoke("set_detail_selection", {
        value: { actorId, mode: "history", record },
      });
      await invoke("create_dps_detail");
    } catch (_) {}
    return;
  }

  if (e.target.closest(".record-row__detail")) {
    return;
  }

  // Record row click → expand/collapse
  const row = e.target.closest(".record-row");
  if (!row) return;
  toggleExpand(row.dataset.id);
});

// ── Init ──
(async function init() {
  try {
    const lang = await invoke("get_language");
    setLanguage(lang);
  } catch (_) {}

  function setEmptyText() {
    $empty.textContent = t("dps-history.empty");
  }
  setEmptyText();
  $targetFilter.addEventListener("change", applyFilters);
  $actorFilter.addEventListener("change", applyFilters);

  listen("language-changed", (event) => {
    setLanguage(event.payload.language);
    setEmptyText();
    refreshFilterOptions();
    applyFilters();
  });

  await load();
  listen("history-updated", () => load());
})();
