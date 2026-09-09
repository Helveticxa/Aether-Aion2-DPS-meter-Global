import { installDevBrowserShim } from "@/lib/dev-browser-shim";

// Before the Tauri imports below: getCurrentWindow() reads the bridge at module
// scope, so outside Tauri this file would throw before anything renders.
installDevBrowserShim();

import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";

import {
  loadCollected,
  loadHidden,
  loadMapDataset,
  saveHidden,
} from "@/games/aion2/lib/map-dataset";
import { shapeIconSvg } from "@/games/aion2/lib/map-icons";
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
let hidden = loadHidden(["npc"]);
let collected = new Set();
let view = null;
let dots = [];
let drag = null;
let alwaysOnTop = true;

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
  const dotSize = Math.min(15, Math.max(7, (7 * view.scale) / fitted));
  const glyph = Math.round(dotSize * 0.62);

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

function renderZones() {
  $zoneRow.replaceChildren();
  for (const z of dataset.zones) {
    const button = document.createElement("button");
    button.className = z.id === zone.id ? "map-zone is-active" : "map-zone";
    button.textContent = z.name;
    button.addEventListener("click", () => {
      zone = z;
      $zoneName.textContent = z.name;
      renderZones();
      renderLegend();
      resetView();
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
  // Same ceiling as the main viewer: past this the 4096px map is upscaled mush.
  const fitted = fitView(width, height, 4).scale;
  const limits = { min: fitted * 0.9, max: fitted * 12 };
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
}

void start();
