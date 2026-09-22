const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const ISLAND = L.latLngBounds([41.141, -71.622], [41.234, -71.536]);
const SVG_NS = "http://www.w3.org/2000/svg";
const DOT = "m-4,0a4,4 0 1 0 8,0a4,4 0 1 0 -8,0";

const state = {
  years: new Set(),
  allYears: [],
  months: new Set([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]),
  q: "",
  base: "imagery",
  pins: true,
  trails: true,
  suggest: false,
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
let labelsShown = false;
let data = null;
let searchTimer = 0;
let trailLayer = null;

// One SVG path for every find. A fresh Leaflet canvas on each year toggle
// eventually stops painting on mobile once the browser will not allocate
// another full-screen bitmap.
const FindsLayer = L.Layer.extend({
  onAdd(map) {
    this._map = map;
    const svg = document.createElementNS(SVG_NS, "svg");
    svg.setAttribute("class", "finds-svg");
    const path = document.createElementNS(SVG_NS, "path");
    path.setAttribute("fill", "#fff4e0");
    path.setAttribute("fill-opacity", "0.92");
    path.setAttribute("stroke", "#3c1c0c");
    path.setAttribute("stroke-width", "1");
    svg.appendChild(path);
    map.getPane("finds").appendChild(svg);
    this._svg = svg;
    this._path = path;
    map.on("moveend zoomend viewreset resize", this._reset, this);
    this._reset();
  },

  onRemove(map) {
    map.off("moveend zoomend viewreset resize", this._reset, this);
    L.DomUtil.remove(this._svg);
    this._svg = null;
    this._path = null;
  },

  redraw() {
    this._reset();
  },

  _reset() {
    if (!this._map || !this._svg) return;
    const size = this._map.getSize();
    if (!size.x || !size.y) return;
    L.DomUtil.setPosition(this._svg, this._map.containerPointToLayerPoint([0, 0]));
    this._svg.setAttribute("width", size.x);
    this._svg.setAttribute("height", size.y);
    this._svg.style.width = `${size.x}px`;
    this._svg.style.height = `${size.y}px`;
    this._draw(size);
  },

  _draw(size) {
    const path = this._path;
    if (!path) return;
    if (!state.pins || !view.finds.length) {
      path.setAttribute("d", "");
      return;
    }
    const finds = view.finds;
    let d = "";
    for (let i = 0; i < finds.length; i++) {
      const find = finds[i];
      const pt = this._map.latLngToContainerPoint([find.lat, find.lng]);
      if (pt.x < -12 || pt.y < -12 || pt.x > size.x + 12 || pt.y > size.y + 12) continue;
      d += `M${pt.x | 0},${pt.y | 0}${DOT}`;
    }
    path.setAttribute("d", d);
  },
});
const findsLayer = new FindsLayer();
findsLayer.addTo(map);

map.fitBounds(ISLAND, pad());
map.on("zoomend", syncLabels);
map.on("click", onMapClick);
map.on("mousemove", onMapMove);

const $ = (id) => document.getElementById(id);

function pad() {
  const narrow = window.innerWidth <= 820;
  if (narrow) return { paddingTopLeft: [16, 56], paddingBottomRight: [16, 96] };
  return { paddingTopLeft: [440, 30], paddingBottomRight: [30, 30] };
}

function placeName(id) {
  return state.places.get(id)?.name || "";
}

function fold(value) {
  return String(value || "").toLowerCase().replace(/[’']/g, "");
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
  findsLayer.redraw();
}

function foundOn(find) {
  const day = find.date || "";
  // The archive import stamped every older find as January 1. That is not a found-on day.
  if (day.length < 10 || day.slice(5) === "01-01") {
    return `${find.year} · no day recorded`;
  }
  const year = Number(day.slice(0, 4));
  const month = Number(day.slice(5, 7));
  const date = Number(day.slice(8, 10));
  const pretty = `${MONTHS[month - 1]} ${date}, ${year}`;
  const when = `Found ${pretty}`;
  return year !== find.year ? `${when} · ${find.year} float` : when;
}

function onMapClick(event) {
  const find = hitFind(event.containerPoint);
  if (!find) return;
  const num = find.n != null ? `#${find.n} · ` : "";
  L.popup({ maxWidth: 260 })
    .setLatLng(event.latlng)
    .setContent(
      `<div class="popup"><h3>${escapeHtml(num + find.title)}</h3>
       <p>${escapeHtml(foundOn(find))}</p>
       <p>${escapeHtml(find.where || "No description")}</p>
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

const FRESH_DAYS = 14;

function listingAge(iso, today) {
  const year = Number(iso.slice(0, 4));
  const month = Number(iso.slice(5, 7));
  const day = Number(iso.slice(8, 10));
  const then = Date.UTC(year, month - 1, day);
  const now = Date.UTC(today.getFullYear(), today.getMonth(), today.getDate());
  return Math.round((now - then) / 86400000);
}

function suggestPlan() {
  const { year, month } = seasonNow();
  const focus = focusMonths();
  const focusSet = new Set(focus);
  const recent = new Set(focus);
  for (const value of focus) recent.add(value === 1 ? 12 : value - 1);
  recent.add(month);
  recent.add(month === 1 ? 12 : month - 1);

  const today = new Date();
  const historic = new Map();
  const recentCounts = new Map();
  const fresh = new Map();
  for (let i = 0; i < data.finds.length; i++) {
    const find = data.finds[i];
    if (!find.place) continue;
    if (find.date && find.date.slice(5) !== "01-01") {
      const age = listingAge(find.date, today);
      if (age >= 0 && age <= FRESH_DAYS) {
        const prev = fresh.get(find.place);
        if (!prev || find.date > prev) fresh.set(find.place, find.date);
      }
    }
    if (!find.month) continue;
    if (find.year < year && state.years.has(find.year) && focusSet.has(find.month)) {
      historic.set(find.place, (historic.get(find.place) || 0) + 1);
    }
    const countsNow = find.year === year || (month === 1 && find.year === year - 1 && find.month === 12);
    if (countsNow && recent.has(find.month)) {
      recentCounts.set(find.place, (recentCounts.get(find.place) || 0) + 1);
    }
  }

  let places = [];
  let setAside = 0;
  for (const [id, past] of historic) {
    const nowCount = recentCounts.get(id) || 0;
    if (past < 2 || nowCount > Math.max(1, Math.floor(past / 4))) continue;
    if (fresh.has(id)) {
      setAside += 1;
      continue;
    }
    places.push({ id, past, nowCount, score: past - nowCount * 3 });
  }
  places.sort((a, b) => b.score - a.score || a.nowCount - b.nowCount);
  if (!places.length) {
    places = [...historic.entries()]
      .map(([id, past]) => ({ id, past, nowCount: recentCounts.get(id) || 0, score: past }))
      .filter((place) => place.past >= 1 && place.nowCount === 0 && !fresh.has(place.id))
      .sort((a, b) => b.past - a.past);
  }
  return { year, month, focus: focusSet, recent, fresh, setAside, places: places.slice(0, 8) };
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
    hint.textContent = "Places with orbs in this month in earlier years, few reports lately, and none in the last two weeks.";
  } else if (!plan.places.length) {
    hint.textContent = plan.setAside
      ? "Nothing quiet enough. Places with a find in the last two weeks were set aside."
      : "Nothing quiet enough. Turn earlier years back on, or pick another month.";
  } else {
    const names = [...plan.focus].sort((a, b) => a - b).map((value) => MONTHS[value - 1]).join(", ");
    const recentNames = [...plan.recent].sort((a, b) => a - b).map((value) => MONTHS[value - 1]).join("–");
    const skipped = plan.setAside
      ? ` ${plan.setAside} ${plan.setAside === 1 ? "place had a find" : "places had a find"} in the last two weeks, so ${plan.setAside === 1 ? "it is" : "they are"} left out.`
      : "";
    hint.textContent = `${names} in years before ${plan.year}, with few reports in ${recentNames} ${plan.year}.${skipped} The map shows those older finds.`;
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
  redrawDots();
  const toggle = $("panel-toggle-label");
  if (toggle && !$("panel").classList.contains("is-open")) toggle.textContent = filterButtonLabel();
}

function lede() {
  if (state.suggest && view.plan) {
    const names = view.plan.places.map((place) => placeName(place.id)).slice(0, 3).join(", ");
    return names
      ? `Suggested search: ${names}${view.plan.places.length > 3 ? "…" : ""}. Historic ${[...view.plan.focus].map((month) => MONTHS[month - 1]).join(", ")} finds, none reported there in the last two weeks.`
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
    .map((find) => `<li>${escapeHtml(find.where)} <span style="color:#5e6a62">· ${escapeHtml(foundOn(find))}</span></li>`)
    .join("");
  if (window.innerWidth <= 820) setPanelOpen(false);
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

function filterButtonLabel() {
  const parts = [];
  if (state.years.size !== state.allYears.length) {
    parts.push(state.years.size ? `${state.years.size} years` : "no years");
  }
  if (state.months.size !== 12) {
    parts.push(state.months.size ? `${state.months.size} months` : "no months");
  }
  if (state.suggest) parts.push("suggested");
  if (state.q.trim()) parts.push("search");
  return parts.length ? `Filters · ${parts.join(" · ")}` : "Filters & list";
}

function setPanelOpen(open) {
  $("panel").classList.toggle("is-open", open);
  $("panel-toggle").setAttribute("aria-expanded", String(open));
  $("panel-toggle-label").textContent = open ? "Show map" : filterButtonLabel();
  if (!open) {
    setTimeout(() => {
      map.invalidateSize();
      findsLayer.redraw();
    }, 50);
  }
}

function resetFilters() {
  state.years = new Set(state.allYears);
  state.months = new Set([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
  state.q = "";
  state.suggest = false;
  $("q").value = "";
  $("toggle-suggest").setAttribute("aria-pressed", "false");
  $("toggle-suggest").textContent = "Show";
  apply();
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
  });

  $("toggle-suggest").addEventListener("click", (event) => {
    state.suggest = !state.suggest;
    event.currentTarget.setAttribute("aria-pressed", String(state.suggest));
    event.currentTarget.textContent = state.suggest ? "Hide" : "Show";
    apply();
  });

  $("panel-toggle").addEventListener("click", () => setPanelOpen(true));
  $("show-map").addEventListener("click", () => setPanelOpen(false));
  $("reset-filters").addEventListener("click", resetFilters);
}

async function start() {
  const response = await fetch("data/finds.json?v=19");
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
  if (trailRenderer && trailRenderer._container) {
    trailRenderer._container.style.pointerEvents = "none";
  }
}

let trailRenderer = null;

async function loadTrails() {
  const response = await fetch("data/trails.geojson?v=18");
  if (!response.ok) return;
  const geo = await response.json();
  trailRenderer = L.canvas({ padding: 0.5, pane: "trails" });
  const lines = [];
  for (const feature of geo.features) {
    const coords = feature.geometry.coordinates.map(([lng, lat]) => [lat, lng]);
    if (coords.length < 2) continue;
    lines.push(L.polyline(coords, {
      renderer: trailRenderer,
      pane: "trails",
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
