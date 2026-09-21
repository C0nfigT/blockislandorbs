const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const ISLAND = L.latLngBounds([41.141, -71.622], [41.234, -71.536]);
const HEAT_STOPS = [
  [0.12, [14, 77, 108, 0]],
  [0.28, [14, 77, 108, 150]],
  [0.46, [31, 138, 122, 185]],
  [0.66, [226, 177, 90, 205]],
  [0.84, [224, 106, 50, 220]],
  [1, [255, 244, 214, 230]],
];

const state = {
  years: new Set(),
  allYears: [],
  months: new Set([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]),
  q: "",
  base: "imagery",
  heat: true,
  pins: true,
  trails: true,
  suggest: false,
  totalPlaced: 1,
  places: new Map(),
};

const view = {
  finds: [],
  counts: new Map(),
  hits: [],
};

const map = L.map("map", {
  zoomControl: false,
  minZoom: 12,
  maxZoom: 18,
  zoomSnap: 1,
  zoomDelta: 1,
  zoomAnimation: false,
  fadeAnimation: false,
  markerZoomAnimation: false,
  maxBounds: ISLAND.pad(0.35),
  maxBoundsViscosity: 0.85,
});
L.control.zoom({ position: "bottomright" }).addTo(map);

const imagery = L.tileLayer(
  "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}",
  {
    maxZoom: 18,
    attribution: "Imagery © Esri, Maxar, Earthstar Geographics",
  }
);
const topo = L.tileLayer(
  "https://server.arcgisonline.com/ArcGIS/rest/services/World_Topo_Map/MapServer/tile/{z}/{y}/{x}",
  {
    maxZoom: 17,
    attribution: "Terrain © Esri, USGS, NOAA",
  }
);
imagery.addTo(map);

map.createPane("trails");
map.getPane("trails").style.zIndex = "450";
map.createPane("finds");
map.getPane("finds").style.zIndex = "620";
map.getPane("markerPane").style.zIndex = "660";
map.getPane("popupPane").style.zIndex = "700";

const labelLayer = L.layerGroup().addTo(map);
let dotRenderer = null;
const dotLayer = L.layerGroup().addTo(map);
let labelsShown = false;
let data = null;
let searchTimer = 0;
let trailLayer = null;

const atlas = L.Layer.extend({
  onAdd(map) {
    this._map = map;
    this._canvas = L.DomUtil.create("canvas", "atlas-canvas");
    this._canvas.style.pointerEvents = "none";
    this._ctx = this._canvas.getContext("2d", { alpha: true });
    this._scratch = document.createElement("canvas");
    this._scratchCtx = this._scratch.getContext("2d", { alpha: true });
    map.getPanes().overlayPane.appendChild(this._canvas);
    map.on("zoom zoomend moveend resize viewreset", this._schedule, this);
    this._reset();
  },

  onRemove(map) {
    map.off("zoom zoomend moveend resize viewreset", this._schedule, this);
    L.DomUtil.remove(this._canvas);
  },

  _schedule() {
    if (this._frame) return;
    this._frame = requestAnimationFrame(() => {
      this._frame = 0;
      this._reset();
    });
  },

  _reset() {
    if (!this._map) return;
    const size = this._map.getSize();
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const width = Math.max(1, Math.round(size.x * dpr));
    const height = Math.max(1, Math.round(size.y * dpr));
    const previous = this._canvas;
    // A new element every time. Chrome keeps the previous bitmap when a canvas
    // inside the translated map pane is only cleared and redrawn.
    this._canvas = L.DomUtil.create("canvas", "atlas-canvas");
    this._canvas.style.pointerEvents = "none";
    this._canvas.width = width;
    this._canvas.height = height;
    this._canvas.style.width = `${size.x}px`;
    this._canvas.style.height = `${size.y}px`;
    this._ctx = this._canvas.getContext("2d", { alpha: true });
    L.DomUtil.setPosition(this._canvas, this._map.containerPointToLayerPoint([0, 0]));
    paintAtlas(this, size, dpr);
    const pane = this._map.getPanes().overlayPane;
    if (previous && previous.parentNode === pane) pane.replaceChild(this._canvas, previous);
    else pane.appendChild(this._canvas);
  },
});
const atlasLayer = new atlas();
atlasLayer.addTo(map);

map.fitBounds(ISLAND, pad());
map.on("zoomend", syncLabels);
map.on("click", onMapClick);
map.on("mousemove", onMapMove);

const $ = (id) => document.getElementById(id);

function pad() {
  const narrow = window.innerWidth <= 820;
  if (narrow) return { paddingTopLeft: [16, 64], paddingBottomRight: [16, 180] };
  return { paddingTopLeft: [440, 30], paddingBottomRight: [30, 30] };
}

function placeName(id) {
  return state.places.get(id)?.name || "";
}

function fold(value) {
  return String(value || "").toLowerCase().replace(/[’']/g, "");
}

function kernelPixels(zoom) {
  // Shrink the screen blob as you zoom in so a preserve breaks into local hot spots
  // instead of one circle that stays the same size on screen.
  const shrunk = 26 * Math.pow(0.74, zoom - 13);
  return Math.max(7, Math.min(72, shrunk));
}

function paintAtlas(layer, size, dpr) {
  const ctx = layer._ctx;
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, layer._canvas.width, layer._canvas.height);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  if (!view.finds.length) return;

  const zoom = map.getZoom();
  const bounds = map.getBounds();
  const north = bounds.getNorth();
  const south = bounds.getSouth();
  const east = bounds.getEast();
  const west = bounds.getWest();
  const latPad = (north - south) * 0.25;
  const lngPad = (east - west) * 0.25;
  if (state.heat) {
    const cell = 4;
    const cols = Math.max(1, Math.ceil(size.x / cell));
    const rows = Math.max(1, Math.ceil(size.y / cell));
    const cells = cols * rows;
    const grid = takeBuffer(layer, "grid", cells);
    grid.fill(0, 0, cells);
    const radius = kernelPixels(zoom);
    for (let i = 0; i < view.finds.length; i++) {
      const find = view.finds[i];
      if (find.lat < south - latPad || find.lat > north + latPad || find.lng < west - lngPad || find.lng > east + lngPad) {
        continue;
      }
      const point = map.latLngToContainerPoint([find.lat, find.lng]);
      const x = (point.x / cell) | 0;
      const y = (point.y / cell) | 0;
      if (x < 0 || y < 0 || x >= cols || y >= rows) continue;
      grid[y * cols + x] += 1;
    }
    const blurred = soften(layer, grid, cols, rows, Math.max(1, Math.round(radius / cell)));
    let peak = 1;
    for (let i = 0; i < cells; i++) if (blurred[i] > peak) peak = blurred[i];
    // Keep the scale tied to how many finds are in the filter, so turning a year
    // off cools the map instead of stretching the remaining finds back to full heat.
    const share = view.finds.length / state.totalPlaced;
    const white = Math.max(1.4, peak * 0.62) / Math.min(1, Math.max(share, 0.18));
    if (!layer._image || layer._image.width !== cols || layer._image.height !== rows) {
      layer._image = layer._scratchCtx.createImageData(cols, rows);
    }
    const image = layer._image;
    image.data.fill(0);
    const pixels = image.data;
    for (let i = 0; i < cells; i++) {
      const sample = colorAt(blurred[i] / white);
      if (!sample) continue;
      const offset = i * 4;
      pixels[offset] = sample[0];
      pixels[offset + 1] = sample[1];
      pixels[offset + 2] = sample[2];
      pixels[offset + 3] = sample[3];
    }
    if (layer._scratch.width !== cols || layer._scratch.height !== rows) {
      layer._scratch.width = cols;
      layer._scratch.height = rows;
    }
    layer._scratchCtx.putImageData(image, 0, 0);
    ctx.imageSmoothingEnabled = true;
    ctx.drawImage(layer._scratch, 0, 0, cols, rows, 0, 0, cols * cell, rows * cell);
  }

}

function takeBuffer(layer, slot, size) {
  const key = `_${slot}`;
  let buffer = layer[key];
  if (!buffer || buffer.length < size) {
    buffer = new Float32Array(size);
    layer[key] = buffer;
  }
  return buffer;
}

function soften(layer, source, width, height, radius) {
  const count = width * height;
  const horizontal = blurAxis(layer, source, takeBuffer(layer, "blurA", count), width, height, radius, true);
  return blurAxis(layer, horizontal, takeBuffer(layer, "blurB", count), width, height, radius, false);
}

function blurAxis(layer, source, dest, width, height, radius, horizontal) {
  const length = horizontal ? width : height;
  const lines = horizontal ? height : width;
  const prefix = takeBuffer(layer, "prefix", length + 1);
  for (let line = 0; line < lines; line++) {
    prefix[0] = 0;
    for (let i = 0; i < length; i++) {
      const index = horizontal ? line * width + i : i * width + line;
      prefix[i + 1] = prefix[i] + source[index];
    }
    for (let i = 0; i < length; i++) {
      const start = Math.max(0, i - radius);
      const end = Math.min(length - 1, i + radius);
      const index = horizontal ? line * width + i : i * width + line;
      dest[index] = (prefix[end + 1] - prefix[start]) / (end - start + 1);
    }
  }
  return dest;
}

function colorAt(amount) {
  if (amount < HEAT_STOPS[0][0]) return null;
  const t = amount > 1 ? 1 : amount;
  let left = HEAT_STOPS[0];
  let right = HEAT_STOPS[HEAT_STOPS.length - 1];
  for (let i = 1; i < HEAT_STOPS.length; i++) {
    if (t <= HEAT_STOPS[i][0]) {
      left = HEAT_STOPS[i - 1];
      right = HEAT_STOPS[i];
      break;
    }
  }
  const span = right[0] - left[0] || 1;
  const mix = (t - left[0]) / span;
  return [
    left[1][0] + (right[1][0] - left[1][0]) * mix,
    left[1][1] + (right[1][1] - left[1][1]) * mix,
    left[1][2] + (right[1][2] - left[1][2]) * mix,
    left[1][3] + (right[1][3] - left[1][3]) * mix,
  ];
}

function hitFind(containerPoint) {
  if (!state.pins || !view.finds.length) return null;
  const reach = 12;
  let best = null;
  let bestDistance = reach * reach;
  for (let i = 0; i < view.finds.length; i++) {
    const find = view.finds[i];
    const point = map.latLngToContainerPoint([find.lat, find.lng]);
    const dx = point.x - containerPoint.x;
    const dy = point.y - containerPoint.y;
    const distance = dx * dx + dy * dy;
    if (distance <= bestDistance) {
      bestDistance = distance;
      best = find;
    }
  }
  return best;
}

function redrawDots() {
  dotLayer.clearLayers();
  // Leaflet's canvas stays at 0×0 after the last marker is removed, so a
  // reused renderer never paints again. Make a new one whenever finds return.
  if (dotRenderer) {
    if (map.hasLayer(dotRenderer)) map.removeLayer(dotRenderer);
    dotRenderer = null;
  }
  if (!state.pins || !view.finds.length) return;
  dotRenderer = L.canvas({ padding: 0.5, pane: "finds" });
  for (let i = 0; i < view.finds.length; i++) {
    const find = view.finds[i];
    L.circleMarker([find.lat, find.lng], {
      renderer: dotRenderer,
      radius: 3.5,
      weight: 1,
      color: "#3c1c0c",
      fillColor: "#fff4e0",
      fillOpacity: 0.92,
      interactive: false,
    }).addTo(dotLayer);
  }
  if (dotRenderer._container) dotRenderer._container.style.pointerEvents = "none";
  requestAnimationFrame(() => {
    if (dotRenderer && dotRenderer._map) dotRenderer._update();
    if (trailRenderer && trailRenderer._map) trailRenderer._update();
    raiseTrails();
  });
}

function onMapClick(event) {
  const find = hitFind(event.containerPoint);
  if (!find) return;
  const when = find.month ? `${MONTHS[find.month - 1]} ${find.year}` : String(find.year);
  const num = find.n != null ? `#${find.n} · ` : "";
  L.popup({ maxWidth: 260 })
    .setLatLng(event.latlng)
    .setContent(
      `<div class="popup"><h3>${escapeHtml(num + find.title)}</h3>
       <p>${escapeHtml(find.where || "No description")} · ${when}</p>
       <p>Near ${escapeHtml(placeName(find.place) || "an unnamed spot")}.</p>
       ${find.url ? `<p><a href="https://www.blockislandinfo.com${find.url}" target="_blank" rel="noopener">Registry entry</a></p>` : ""}
       </div>`
    )
    .openOn(map);
}

function onMapMove(event) {
  const find = hitFind(event.containerPoint);
  map.getContainer().style.cursor = find ? "pointer" : "";
}

function seasonNow() {
  const now = new Date();
  let year = now.getFullYear();
  const month = now.getMonth() + 1;
  if (state.allYears.length && !state.allYears.includes(year)) {
    year = state.allYears[state.allYears.length - 1];
  }
  return { year, month };
}

function focusMonths() {
  if (state.months.size > 0 && state.months.size < 12) return [...state.months];
  return [seasonNow().month];
}

function suggestPlan() {
  const { year, month } = seasonNow();
  const focus = focusMonths();
  const focusSet = new Set(focus);
  const recent = new Set(focus);
  for (const value of focus) recent.add(value === 1 ? 12 : value - 1);
  recent.add(month);
  recent.add(month === 1 ? 12 : month - 1);

  const historic = new Map();
  const recentCounts = new Map();
  for (let i = 0; i < data.finds.length; i++) {
    const find = data.finds[i];
    if (!find.place || !find.month) continue;
    if (find.year < year && state.years.has(find.year) && focusSet.has(find.month)) {
      historic.set(find.place, (historic.get(find.place) || 0) + 1);
    }
    const countsNow = find.year === year || (month === 1 && find.year === year - 1 && find.month === 12);
    if (countsNow && recent.has(find.month)) {
      recentCounts.set(find.place, (recentCounts.get(find.place) || 0) + 1);
    }
  }

  let places = [];
  for (const [id, past] of historic) {
    const nowCount = recentCounts.get(id) || 0;
    if (past < 2 || nowCount > Math.max(1, Math.floor(past / 4))) continue;
    places.push({ id, past, nowCount, score: past - nowCount * 3 });
  }
  places.sort((a, b) => b.score - a.score || a.nowCount - b.nowCount);
  if (!places.length) {
    places = [...historic.entries()]
      .map(([id, past]) => ({ id, past, nowCount: recentCounts.get(id) || 0, score: past }))
      .filter((place) => place.past >= 1 && place.nowCount === 0)
      .sort((a, b) => b.past - a.past);
  }
  return { year, month, focus: focusSet, recent, places: places.slice(0, 8) };
}

function visibleFinds() {
  const q = fold(state.q.trim());
  if (state.suggest) {
    const plan = suggestPlan();
    view.plan = plan;
    const ids = new Set(plan.places.map((place) => place.id));
    return data.finds.filter((find) => {
      if (!ids.has(find.place) || !find.month || !plan.focus.has(find.month)) return false;
      if (find.year >= plan.year || !state.years.has(find.year)) return false;
      if (q && !find._search.includes(q)) return false;
      return true;
    });
  }
  view.plan = null;
  const monthsAll = state.months.size === 12;
  return data.finds.filter((find) => {
    if (!state.years.has(find.year)) return false;
    if (!monthsAll && (!find.month || !state.months.has(find.month))) return false;
    if (q && !find._search.includes(q)) return false;
    return true;
  });
}

function renderYears() {
  for (const button of $("years").querySelectorAll("button")) {
    button.setAttribute("aria-pressed", String(state.years.has(Number(button.dataset.year))));
  }
}

function renderMonths() {
  for (const button of $("months").querySelectorAll("button")) {
    button.setAttribute("aria-pressed", String(state.months.has(Number(button.dataset.month))));
  }
}

function buildFilters() {
  $("years").innerHTML = state.allYears
    .map((year) => `<button type="button" data-year="${year}" aria-pressed="true">${year}</button>`)
    .join("");
  $("months").innerHTML = MONTHS.map((name, index) => {
    return `<button type="button" data-month="${index + 1}" aria-pressed="true">${name}</button>`;
  }).join("");
}

function renderStats(finds) {
  const onMap = view.finds.length;
  const dated = finds.reduce((sum, find) => sum + (find.month ? 1 : 0), 0);
  $("stats").innerHTML = `
    <div class="stat"><b>${onMap.toLocaleString()}</b><span>on the map</span></div>
    <div class="stat"><b>${finds.length.toLocaleString()}</b><span>matching finds</span></div>
    <div class="stat"><b>${(finds.length - onMap).toLocaleString()}</b><span>too vague to place</span></div>
    <div class="stat"><b>${dated.toLocaleString()}</b><span>with a real month</span></div>`;
}

function renderPlaces(finds) {
  const counts = new Map();
  for (let i = 0; i < finds.length; i++) {
    const place = finds[i].place;
    if (!place) continue;
    counts.set(place, (counts.get(place) || 0) + 1);
  }
  const plan = view.plan;
  const ranked = plan
    ? plan.places.map((place) => [place.id, place.past])
    : [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12);
  const max = ranked[0]?.[1] || 1;
  $("places-heading").textContent = plan ? "Suggested areas" : "Where they turn up";
  $("places").innerHTML = ranked
    .map(([id, count], index) => {
      const detail = plan
        ? plan.places.find((place) => place.id === id)
        : null;
      const note = detail ? `${detail.past} past · ${detail.nowCount} recent` : count.toLocaleString();
      return `<li><button type="button" data-place="${id}">
        <span class="rank">${index + 1}</span>
        <span class="name">${placeName(id)}</span>
        <span class="count">${note}</span>
        <span class="bar"><i style="width:${Math.max(8, (100 * count) / max)}%"></i></span>
      </button></li>`;
    })
    .join("");
  if (plan) {
    for (const place of plan.places) counts.set(place.id, Math.max(counts.get(place.id) || 0, 1));
  }
  const hint = $("suggest-hint");
  if (!plan) {
    hint.textContent = "Places with orbs in this month in earlier years, and few reports in the current month or the month before.";
  } else if (!plan.places.length) {
    hint.textContent = "Nothing quiet enough. Turn earlier years back on, or pick another month.";
  } else {
    const names = [...plan.focus].sort((a, b) => a - b).map((value) => MONTHS[value - 1]).join(", ");
    const recentNames = [...plan.recent].sort((a, b) => a - b).map((value) => MONTHS[value - 1]).join("–");
    hint.textContent = `${names} in years before ${plan.year}, with few reports in ${recentNames} ${plan.year}. The map shows those older finds.`;
  }
  return counts;
}

function renderHint(finds) {
  let undated = 0;
  for (let i = 0; i < data.finds.length; i++) {
    if (state.years.has(data.finds[i].year) && !data.finds[i].month) undated++;
  }
  if (state.months.size === 12) {
    $("month-hint").textContent = undated
      ? `${undated.toLocaleString()} finds in the selected years have no month. They stay visible until you turn a month off. The archive through 2023 was imported on January 1.`
      : "Every find in the selected years has a registration month.";
    return;
  }
  if (!state.months.size) {
    $("month-hint").textContent = "No months selected, so no finds are on the map.";
    return;
  }
  const names = [...state.months].sort((a, b) => a - b).map((month) => MONTHS[month - 1]).join(", ");
  $("month-hint").textContent = undated
    ? `${names}. ${undated.toLocaleString()} finds with no month are hidden.`
    : `${names}.`;
}

function drawLabels(counts) {
  labelLayer.clearLayers();
  if (map.getZoom() < 13 && !state.suggest) return;
  const minimum = state.suggest ? 1 : 12;
  for (const [id, count] of counts) {
    if (count < minimum) continue;
    const place = state.places.get(id);
    if (!place) continue;
    const icon = L.divIcon({
      className: "place-label",
      html: `<span>${escapeHtml(place.name)}</span>`,
      iconSize: [140, 16],
      iconAnchor: [0, 8],
    });
    L.marker([place.lat, place.lng], { icon, interactive: false, keyboard: false }).addTo(labelLayer);
  }
}

function syncLabels() {
  const show = map.getZoom() >= 13;
  if (show === labelsShown) return;
  labelsShown = show;
  drawLabels(view.counts);
}

function apply() {
  const finds = visibleFinds();
  view.finds = [];
  for (let i = 0; i < finds.length; i++) {
    if (finds[i].lat != null) view.finds.push(finds[i]);
  }
  $("lede").textContent = lede();
  renderYears();
  renderMonths();
  renderStats(finds);
  view.counts = renderPlaces(finds);
  renderHint(finds);
  labelsShown = map.getZoom() >= 13;
  drawLabels(view.counts);
  document.body.classList.toggle("heat-off", !state.heat);
  atlasLayer._reset();
  redrawDots();
}

function lede() {
  if (state.suggest && view.plan) {
    const names = view.plan.places.map((place) => placeName(place.id)).slice(0, 3).join(", ");
    return names
      ? `Suggested search: ${names}${view.plan.places.length > 3 ? "…" : ""}. Historic ${[...view.plan.focus].map((month) => MONTHS[month - 1]).join(", ")} finds, quiet lately.`
      : "Suggested search found no quiet historic spots for this month.";
  }
  const years = [...state.years].sort((a, b) => a - b);
  const span = !years.length
    ? "no years selected"
    : years.length === state.allYears.length
      ? `${state.allYears[0]}–${state.allYears[state.allYears.length - 1]}`
      : years.join(", ");
  const monthSpan = state.months.size === 12
    ? ""
    : state.months.size === 0
      ? ", no months selected"
      : `, ${[...state.months].sort((a, b) => a - b).map((month) => MONTHS[month - 1]).join(", ")}`;
  return `${view.finds.length.toLocaleString()} finds on the map, ${span}${monthSpan}.`;
}

function openPlace(id) {
  const place = state.places.get(id);
  if (!place) return;
  const matches = [];
  for (let i = 0; i < data.finds.length; i++) {
    const find = data.finds[i];
    if (find.place !== id || !state.years.has(find.year)) continue;
    if (state.months.size !== 12 && (!find.month || !state.months.has(find.month))) continue;
    matches.push(find);
  }
  const list = matches
    .slice(0, 4)
    .map((find) => `<li>${escapeHtml(find.where)} <span style="color:#5e6a62">· ${find.year}</span></li>`)
    .join("");
  map.flyTo([place.lat, place.lng], Math.max(map.getZoom(), 15), { duration: 0.45 });
  L.popup({ maxWidth: 280 })
    .setLatLng([place.lat, place.lng])
    .setContent(
      `<div class="popup"><h3>${escapeHtml(place.name)}</h3>
       <p>${matches.length.toLocaleString()} finds in this view, gathered around the named place rather than a single GPS point.</p>
       <ul>${list}</ul></div>`
    )
    .openOn(map);
}

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function bind() {
  $("years").addEventListener("click", (event) => {
    const button = event.target.closest("button[data-year]");
    if (!button) return;
    const year = Number(button.dataset.year);
    if (state.years.has(year)) state.years.delete(year);
    else state.years.add(year);
    apply();
  });

  $("all-years").addEventListener("click", () => {
    state.years = new Set(state.allYears);
    apply();
  });

  $("none-years").addEventListener("click", () => {
    state.years = new Set();
    apply();
  });

  $("months").addEventListener("click", (event) => {
    const button = event.target.closest("button[data-month]");
    if (!button) return;
    const month = Number(button.dataset.month);
    if (state.months.has(month)) state.months.delete(month);
    else state.months.add(month);
    apply();
  });

  $("all-months").addEventListener("click", () => {
    state.months = new Set([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
    apply();
  });

  $("none-months").addEventListener("click", () => {
    state.months = new Set();
    apply();
  });

  $("q").addEventListener("input", (event) => {
    state.q = event.target.value;
    clearTimeout(searchTimer);
    searchTimer = setTimeout(apply, 90);
  });

  $("places").addEventListener("click", (event) => {
    const button = event.target.closest("button[data-place]");
    if (!button) return;
    openPlace(button.dataset.place);
  });

  $("basemap").addEventListener("click", (event) => {
    const button = event.target.closest("button[data-base]");
    if (!button) return;
    state.base = button.dataset.base;
    for (const item of $("basemap").querySelectorAll("button")) {
      item.setAttribute("aria-pressed", String(item === button));
    }
    if (state.base === "imagery") {
      if (map.hasLayer(topo)) map.removeLayer(topo);
      if (!map.hasLayer(imagery)) imagery.addTo(map);
    } else {
      if (map.hasLayer(imagery)) map.removeLayer(imagery);
      if (!map.hasLayer(topo)) topo.addTo(map);
    }
    labelLayer.bringToFront();
  });

  $("toggle-heat").addEventListener("click", (event) => {
    state.heat = !state.heat;
    event.currentTarget.setAttribute("aria-pressed", String(state.heat));
    document.body.classList.toggle("heat-off", !state.heat);
    atlasLayer._schedule();
  });

  $("toggle-trails").addEventListener("click", (event) => {
    state.trails = !state.trails;
    event.currentTarget.setAttribute("aria-pressed", String(state.trails));
    if (!trailLayer) return;
    if (state.trails) trailLayer.addTo(map);
    else map.removeLayer(trailLayer);
    raiseTrails();
  });

  $("toggle-pins").addEventListener("click", (event) => {
    state.pins = !state.pins;
    event.currentTarget.setAttribute("aria-pressed", String(state.pins));
    redrawDots();
    raiseTrails();
  });

  $("toggle-suggest").addEventListener("click", (event) => {
    state.suggest = !state.suggest;
    event.currentTarget.setAttribute("aria-pressed", String(state.suggest));
    event.currentTarget.textContent = state.suggest ? "Hide" : "Show";
    apply();
  });

  $("panel-toggle").addEventListener("click", () => {
    const hidden = $("panel").classList.toggle("is-hidden");
    $("panel-toggle").setAttribute("aria-expanded", String(!hidden));
    $("panel-toggle").textContent = hidden ? "List" : "Map";
    setTimeout(() => map.invalidateSize(), 50);
  });
}

async function start() {
  const response = await fetch("data/finds.json");
  if (!response.ok) throw new Error("Could not load find data");
  data = await response.json();
  state.places = new Map(data.places.map((place) => [place.id, place]));
  for (let i = 0; i < data.finds.length; i++) {
    const find = data.finds[i];
    find.year = Number(find.year);
    find.month = find.month == null ? null : Number(find.month);
    find._search = fold(`${find.where} ${find.title} ${placeName(find.place)}`);
  }
  state.allYears = [...new Set(data.finds.map((find) => find.year))].sort((a, b) => a - b);
  state.years = new Set(state.allYears);
  state.totalPlaced = data.finds.reduce((sum, find) => sum + (find.lat != null ? 1 : 0), 0) || 1;
  buildFilters();
  bind();
  apply();
  map.fitBounds(ISLAND, pad());
  try {
    await loadTrails();
  } catch (error) {
    console.error(error);
  }
}

function raiseTrails() {
  if (!trailLayer || !map.hasLayer(trailLayer)) return;
  trailLayer.eachLayer((layer) => {
    if (layer.bringToFront) layer.bringToFront();
  });
  if (trailRenderer && trailRenderer._container) {
    trailRenderer._container.style.pointerEvents = "none";
    const pane = map.getPane("finds");
    if (pane && trailRenderer._container.parentNode === pane) pane.appendChild(trailRenderer._container);
  }
}

let trailRenderer = null;

async function loadTrails() {
  const response = await fetch("data/trails.geojson");
  if (!response.ok) return;
  const geo = await response.json();
  // Same pane as the find dots, which is the one that actually paints above the
  // heat canvas. A lower custom pane was ending up hidden under that canvas.
  trailRenderer = L.canvas({ padding: 0.5, pane: "finds" });
  const lines = [];
  for (const feature of geo.features) {
    const coords = feature.geometry.coordinates.map(([lng, lat]) => [lat, lng]);
    if (coords.length < 2) continue;
    lines.push(L.polyline(coords, {
      renderer: trailRenderer,
      pane: "finds",
      color: "#ffe7a3",
      weight: 3,
      opacity: 1,
      interactive: false,
    }));
  }
  trailLayer = L.layerGroup(lines);
  if (state.trails) {
    trailLayer.addTo(map);
    requestAnimationFrame(raiseTrails);
  }
}

start().catch((error) => {
  console.error(error);
  $("lede").textContent = "The map data did not load. Refresh the page. If it keeps failing, start the site with python3 -m http.server 8080 and open http://127.0.0.1:8080/.";
});
