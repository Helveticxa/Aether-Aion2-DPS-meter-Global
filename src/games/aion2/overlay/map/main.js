import { installDevBrowserShim } from "@/lib/dev-browser-shim";

// Before the Tauri imports below: getCurrentWindow() reads the bridge at module
// scope, so outside Tauri this file would throw before anything renders.
installDevBrowserShim();

import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";

import {
  defaultHidden,
  loadCollected,
  loadHidden,
  loadMapDataset,
  saveHidden,
} from "@/games/aion2/lib/map-dataset";
import { shapeIconSvg } from "@/games/aion2/lib/map-icons";
import {
  BASE_SHARP_UNTIL,
  TILED_SHARP_UNTIL,
  TILE_FADE_IN_AT,
  fetchTiles,
  tileUrlBuilder,
  tilesComplete,
} from "@/games/aion2/lib/map-tiles";
import {
  constrainView,
  fitView,
  normalise,
  toScreen,
  zoomAt,
} from "@/games/aion2/lib/map-projection";

// The overlay shares the projection and the dataset loader with the full map
// page, so a zone renders identically in both and "found" state -- which lives
// in localStorage, shared across the app's windows -- stays in sync.

const $zoneName = document.getElementById("zone-name");
const $count = document.getElementById("marker-count");
const $zoneRow = document.getElementById("zone-row");
const $stage = document.getElementById("stage");
const $plane = document.getElementById("plane");
const $image = document.getElementById("map-image");
const $grid = document.getElementById("map-grid");
const $empty = document.getElementById("empty");
const $legend = document.getElementById("legend");
const $reset = document.getElementById("reset-btn");
const $pin = document.getElementById("pin-btn");
const $close = document.getElementById("close-btn");

const appWindow = getCurrentWindow();

let dataset = null;
let zone = null;
let categories = new Map();
let hidden = new Set();
let collected = new Set();
let view = null;
let dots = [];
let drag = null;
let alwaysOnTop = true;
let tileUrl = null;
let tileEls = new Map();

function stageSize() {
  return { width: $stage.clientWidth, height: $stage.clientHeight };
}

function resetView() {
  const { width, height } = stageSize();
  if (width > 0 && height > 0) {
    view = fitView(width, height, 4);
    render();
  }
}

function zoneMarkers() {
  if (!dataset || !zone) return [];
  return dataset.markers.filter((m) => m.zone === zone.id && !hidden.has(m.category));
}

function render() {
  if (!view || !zone) return;

  $plane.style.width = `${view.scale}px`;
  $plane.style.height = `${view.scale}px`;
  $plane.style.transform = `translate(${view.x}px, ${view.y}px)`;

  if (zone.image) {
    $image.src = zone.image;
    $image.hidden = false;
    $grid.hidden = true;
  } else {
    $image.hidden = true;
    $grid.hidden = false;
  }

  const markers = zoneMarkers();
  const { width, height } = stageSize();
  const pad = 20;
  const fitted = fitView(width, height, 4).scale;
  const dotSize = Math.min(19, Math.max(11, (11 * view.scale) / fitted));
  const glyph = Math.round(dotSize * 0.95);

  renderTiles(view.scale / fitted);

  // Reuse the dot elements rather than rebuilding the list every frame: this
  // runs on every pointermove, and churning hundreds of nodes there is what
  // makes a pan feel heavy.
  let index = 0;
  for (const marker of markers) {
    const point = toScreen(view, normalise(zone.bounds, marker.x, marker.y));
    if (point.x < -pad || point.y < -pad || point.x > width + pad || point.y > height + pad) {
      continue;
    }

    let el = dots[index];
    if (!el) {
      el = document.createElement("div");
      el.className = "map-dot";
      $stage.appendChild(el);
      dots.push(el);
    }

    const found = collected.has(marker.id);
    // Neutral rather than merely faded, so the map reads as what is left.
    const color = found ? "#7c8798" : (categories.get(marker.category)?.color ?? "#9aa4b2");

    // Only rebuild the glyph when it would actually differ: elements are
    // recycled across frames and this runs on every pointermove.
    if (el.dataset.category !== marker.category || el.dataset.glyph !== String(glyph)) {
      el.innerHTML = shapeIconSvg(categories.get(marker.category)?.shape, glyph);
      el.dataset.category = marker.category;
      el.dataset.glyph = String(glyph);
    }

    el.style.left = `${point.x}px`;
    el.style.top = `${point.y}px`;
    el.style.width = `${dotSize}px`;
    el.style.height = `${dotSize}px`;
    el.style.color = color;
    el.style.borderColor = color;
    el.className = found ? "map-dot is-found" : "map-dot";
    el.title = marker.name;
    el.hidden = false;
    index += 1;
  }

  for (let i = index; i < dots.length; i += 1) dots[i].hidden = true;

  $count.textContent = `${markers.length}`;
  $empty.hidden = markers.length > 0;
}

/**
 * The high-resolution layer, drawn inside the plane over the base image.
 *
 * Only tiles that intersect the viewport are kept in the DOM: a zone is up to
 * 64 of them and this runs on every pan. Elements are cached by key so a pan
 * reuses what is already decoded instead of reloading it.
 */
function renderTiles(zoomRatio) {
  if (!tileUrl || !zone?.tileGrid || zoomRatio < TILE_FADE_IN_AT) {
    if (tileEls.size > 0) {
      for (const el of tileEls.values()) el.remove();
      tileEls.clear();
    }
    return;
  }

  const grid = zone.tileGrid;
  const { width, height } = stageSize();
  const pad = 1 / grid;
  const u0 = (0 - view.x) / view.scale - pad;
  const v0 = (0 - view.y) / view.scale - pad;
  const u1 = (width - view.x) / view.scale + pad;
  const v1 = (height - view.y) / view.scale + pad;

  const wanted = new Set();
  for (let row = 0; row < grid; row += 1) {
    for (let col = 0; col < grid; col += 1) {
      const left = col / grid;
      const top = row / grid;
      if (left + pad < u0 || left > u1 || top + pad < v0 || top > v1) continue;

      const key = `${col}-${row}`;
      wanted.add(key);
      if (tileEls.has(key)) continue;

      const img = document.createElement("img");
      img.className = "map-tile";
      img.src = tileUrl(col, row);
      img.draggable = false;
      img.style.left = `${left * 100}%`;
      img.style.top = `${top * 100}%`;
      img.style.width = `${100 / grid}%`;
      img.style.height = `${100 / grid}%`;
      $plane.appendChild(img);
      tileEls.set(key, img);
    }
  }

  for (const [key, el] of tileEls) {
    if (!wanted.has(key)) {
      el.remove();
      tileEls.delete(key);
    }
  }
}

function renderZones() {
  $zoneRow.replaceChildren();
  for (const z of dataset.zones) {
    const button = document.createElement("button");
    button.className = z.id === zone.id ? "map-zone is-active" : "map-zone";
    button.textContent = z.name;
    button.addEventListener("click", () => {
      zone = z;
      $zoneName.textContent = z.name;
      for (const el of tileEls.values()) el.remove();
      tileEls.clear();
      tileUrl = null;
      renderZones();
      renderLegend();
      resetView();
      void loadTilesForZone();
    });
    $zoneRow.appendChild(button);
  }
}

function renderLegend() {
  $legend.replaceChildren();
  const present = new Set(
    dataset.markers.filter((m) => m.zone === zone.id).map((m) => m.category)
  );

  for (const category of dataset.categories) {
    if (!present.has(category.id)) continue;

    const button = document.createElement("button");
    button.className = hidden.has(category.id)
      ? "map-legend__item is-hidden"
      : "map-legend__item";

    const swatch = document.createElement("span");
    swatch.className = "map-legend__swatch";
    swatch.innerHTML = shapeIconSvg(category.shape, 9);
    swatch.style.color = category.color;
    swatch.style.borderColor = category.color;

    const label = document.createElement("span");
    label.textContent = category.label;

    button.append(swatch, label);
    button.addEventListener("click", () => {
      if (hidden.has(category.id)) hidden.delete(category.id);
      else hidden.add(category.id);
      saveHidden(hidden);
      renderLegend();
      render();
    });

    $legend.appendChild(button);
  }
}

$stage.addEventListener("wheel", (event) => {
  if (!view) return;
  event.preventDefault();
  const rect = $stage.getBoundingClientRect();
  const factor = event.deltaY < 0 ? 1.18 : 1 / 1.18;
  const { width, height } = stageSize();
  const fitted = fitView(width, height, 4).scale;
  // Follows the sharpness actually installed, same rule as the main viewer.
  const maxZoom = tileUrl ? TILED_SHARP_UNTIL * 2 : BASE_SHARP_UNTIL * 1.5;
  const limits = { min: fitted * 0.9, max: fitted * maxZoom };
  view = constrainView(
    zoomAt(view, event.clientX - rect.left, event.clientY - rect.top, factor, limits),
    width,
    height
  );
  render();
});

$stage.addEventListener("pointerdown", (event) => {
  if (!view) return;
  $stage.setPointerCapture(event.pointerId);
  drag = { x: event.clientX, y: event.clientY, view: { ...view } };
});

$stage.addEventListener("pointermove", (event) => {
  if (!drag) return;
  const { width, height } = stageSize();
  view = constrainView(
    {
      scale: drag.view.scale,
      x: drag.view.x + (event.clientX - drag.x),
      y: drag.view.y + (event.clientY - drag.y),
    },
    width,
    height
  );
  render();
});

function endDrag(event) {
  if (!drag) return;
  $stage.releasePointerCapture?.(event.pointerId);
  drag = null;
}

$stage.addEventListener("pointerup", endDrag);
$stage.addEventListener("pointercancel", endDrag);

$reset.addEventListener("click", resetView);

$pin.addEventListener("click", async () => {
  alwaysOnTop = !alwaysOnTop;
  $pin.setAttribute("aria-pressed", String(alwaysOnTop));
  try {
    await appWindow.setAlwaysOnTop(alwaysOnTop);
  } catch {
    /* window API unavailable */
  }
});

$close.addEventListener("click", () => {
  invoke("destroy_map_overlay").catch(() => appWindow.close());
});

window.addEventListener("resize", () => {
  if (!view) resetView();
  else {
    const { width, height } = stageSize();
    view = constrainView(view, width, height);
    render();
  }
});

// Re-read "found" state whenever the window regains focus: the full map page is
// the usual place to click markers, and this keeps the overlay honest without
// polling.
window.addEventListener("focus", () => {
  collected = loadCollected();
  render();
});

async function start() {
  dataset = await loadMapDataset();
  collected = loadCollected();
  hidden = loadHidden(defaultHidden(dataset.categories));
  categories = new Map(dataset.categories.map((c) => [c.id, c]));

  let requested = null;
  try {
    requested = await invoke("get_map_overlay_zone");
  } catch {
    /* fall through to the first zone */
  }

  zone = dataset.zones.find((z) => z.id === requested) ?? dataset.zones[0];
  if (!zone) return;

  $zoneName.textContent = zone.name;
  renderZones();
  renderLegend();
  resetView();
  void loadTilesForZone();
}

/** Picks up tiles the map page downloaded; the overlay never fetches them. */
async function loadTilesForZone() {
  if (!zone?.code || !zone.tileGrid) return;
  const result = await fetchTiles(zone.code, zone.tileGrid);
  tileUrl =
    result && tilesComplete(result.status) ? tileUrlBuilder(result.dir, zone.code) : null;
  render();
}

void start();
