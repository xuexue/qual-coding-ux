"use strict";
// Quant analysis page (spec.txt, QUANT ANALYSIS MODE): a code-by-code co-occurrence matrix.
// Two codes co-occur when the same participant was given both (by at least one coder each,
// in either question) in the same transition. Exploratory only: no statistical tests.
// (Not named quant.js: ad/tracker blockers block any script by that name.)

const Q = {
  data: null,
  participants: new Map(),
  index: null,  // buildCodeIndex() result: {rows, rowByFc, hits, themeColors, recoded}
  trans: localStorage.getItem("prf-q-trans") || "pp",       // "pp" | "pd"
  group: localStorage.getItem("prf-q-group") || "both",     // "A" | "B" | "both"
  measure: localStorage.getItem("prf-q-measure") || "count", // "count" | "phi" | "jaccard"
  mods: localStorage.getItem("prf-q-mods") || "all",         // "all" | "plus"
};

const MEASURES = { count: "count", phi: "φ", jaccard: "Jaccard" };
// "+ only" drops −/= codes; codes without a modifier (pattern codes, proposals) always stay.
const MODS = { all: "+/−/=", plus: "+ only" };

// Colour ramps (see the dataviz reference palette): sequential = one hue light->dark;
// diverging = blue (positive) <-> red (negative) with a neutral grey midpoint.
const BLUE = ["#cde2fb", "#9ec5f4", "#6da7ec", "#3987e5", "#256abf", "#184f95", "#0d366b"];
const RED = ["#f9dcdb", "#f3b8b7", "#ec9291", "#e36b6a", "#d14645", "#ad3332", "#862524"];
const NEUTRAL = "#f0efec";
const DARK_FROM = 3;  // ramp index from which cell text switches to white

// ------------------------------------------------------------ loading

async function init() {
  bindEvents();
  // Same files and defaults as the analysis page (they share what the server has loaded).
  const opened = await openingSnapshot();
  if (!opened) {
    $("#matrix-wrap").replaceChildren(el("p", { class: "empty" }, "Could not load the files: check the paths above and click Load."));
    return;
  }
  applySnapshot(opened.snap);
  if (opened.fresh) setStatus(...loadedMessage(opened.snap, Q.index.recoded));
}

function applySnapshot(snap) {
  Q.data = snap;
  Q.participants = new Map(snap.participants.map((p) => [p.id, p]));
  Q.index = buildCodeIndex(snap, Q.participants);
  fillSiteFilter(snap.participants);
  render();
}

/** Load button: reload the files in the form. */
async function loadFromForm() {
  try {
    applySnapshot(await loadFilesFromForm());
    setStatus(...loadedMessage(Q.data, Q.index.recoded));
  } catch (e) {
    setStatus(e.message, true);
  }
}

// ------------------------------------------------------------ computing

/** Participants the matrix is computed over: filters, group choice, and (for ->delay-post)
 *  only those with a delay-post answer, so N matches the n row of the analysis page. */
function matrixParticipants() {
  return filterParticipants(Q.data.participants)
    .filter((p) => (Q.group === "both" ? GROUPS.includes(p.group) : p.group === Q.group))
    .filter((p) => Q.trans === "pp" || hasDelayPost(p, Q.data.questions));
}

/** For each code given to anyone in ps (in the chosen transition): the set of those pids. */
function codeSets(ps) {
  const out = [];
  for (const r of Q.index.rows) {
    if (Q.mods === "plus" && (r.modifier === "-" || r.modifier === "=")) continue;
    const byPid = Q.index.hits.get(r.fc);
    if (!byPid) continue;
    const set = new Set(ps.filter((p) => { const h = byPid.get(p.id); return h && h[Q.trans].size; }).map((p) => p.id));
    if (set.size) out.push({ r, set });
  }
  return out;
}

function intersectSize(a, b) {
  let n = 0;
  const [small, big] = a.size <= b.size ? [a, b] : [b, a];
  for (const x of small) if (big.has(x)) n++;
  return n;
}

/** φ (phi) for two yes/no codes over N participants; null if either code is given to all or none. */
function phi(both, ni, nj, N) {
  const a = both, b = ni - both, c = nj - both, d = N - ni - nj + both;
  const den = Math.sqrt(ni * (N - ni) * nj * (N - nj));
  return den ? (a * d - b * c) / den : null;
}

const jaccard = (both, ni, nj) => (ni + nj - both ? both / (ni + nj - both) : null);

/** ".42", "−.10", "1.00" */
function fmt2(x) {
  if (x === null) return "";
  const s = Math.abs(x).toFixed(2).replace(/^0/, "");
  return (x < 0 ? "−" : "") + s;
}

// ------------------------------------------------------------ colour

function rampColor(ramp, t) {
  const i = Math.min(ramp.length - 1, Math.max(0, Math.ceil(t * ramp.length) - 1));
  return { bg: ramp[i], dark: i >= DARK_FROM };
}

/** Background for an off-diagonal cell, or null for no fill. */
function cellColor(value, maxCount) {
  if (value === null) return null;
  if (Q.measure === "phi") {
    if (Math.abs(value) < 0.05) return { bg: NEUTRAL, dark: false };
    return rampColor(value > 0 ? BLUE : RED, Math.abs(value));
  }
  if (!value) return null;
  return rampColor(BLUE, Q.measure === "count" ? value / maxCount : value);
}

// ------------------------------------------------------------ rendering

function renderControls() {
  const seg = (box, options, current, onPick) => $(box).replaceChildren(...Object.entries(options).map(([v, label]) =>
    el("button", { type: "button", class: v === current ? "active" : "", onclick: () => onPick(v) }, label)));
  seg("#ctl-trans", TRANS, Q.trans, (v) => setOpt("trans", v));
  seg("#ctl-group", { A: "A", B: "B", both: "A + B" }, Q.group, (v) => setOpt("group", v));
  seg("#ctl-mods", MODS, Q.mods, (v) => setOpt("mods", v));
  seg("#ctl-measure", MEASURES, Q.measure, (v) => setOpt("measure", v));
}

function setOpt(key, value) {
  Q[key] = value;
  localStorage.setItem(`prf-q-${key}`, value);
  render();
}

function renderLegend(maxCount) {
  const swatches = (ramp) => ramp.map((c) => el("span", { class: "sw", style: `background:${c}` }));
  let body;
  if (Q.measure === "phi") {
    body = [el("span", {}, "−1"), ...swatches([...RED].reverse()), el("span", { class: "sw", style: `background:${NEUTRAL}` }),
      ...swatches(BLUE), el("span", {}, "+1")];
  } else {
    body = [el("span", {}, Q.measure === "count" ? "1" : "0"), ...swatches(BLUE),
      el("span", {}, Q.measure === "count" ? String(maxCount) : "1")];
  }
  $("#legend").replaceChildren(el("span", { class: "legend-scale" }, ...body),
    el("span", { class: "legend-diag" }, el("span", { class: "sw diag-sw" }), "diagonal: n given the code"));
}

function render() {
  renderControls();
  if (!Q.data) return;
  const ps = matrixParticipants();
  const N = ps.length;
  const sets = codeSets(ps);
  const groupLabel = Q.group === "both" ? "groups A + B" : `group ${Q.group}`;
  const all = filterParticipants(Q.data.participants);
  $("#selection-n").textContent = `${all.length} selected (A ${all.filter((p) => p.group === "A").length}, ` +
    `B ${all.filter((p) => p.group === "B").length})`;
  $("#q-explain").textContent = {
    count: "Each cell: participants given both codes",
    phi: "Each cell: φ (phi) correlation between the two codes, from −1 (never together) to +1 (always together)",
    jaccard: "Each cell: Jaccard overlap, participants given both ÷ participants given either",
  }[Q.measure] + ` — ${groupLabel}, ${TRANS[Q.trans]}, N = ${N}.`;

  if (!sets.length) {
    renderLegend(1);
    $("#matrix-wrap").replaceChildren(el("p", { class: "empty" }, "No codes given to anyone in this selection."));
    return;
  }
  const sizes = sets.map((s) => s.set.size);
  const both = sets.map((si) => sets.map((sj) => intersectSize(si.set, sj.set)));
  let maxCount = 1;
  both.forEach((row, i) => row.forEach((v, j) => { if (i !== j) maxCount = Math.max(maxCount, v); }));
  renderLegend(maxCount);

  const value = (i, j) => (Q.measure === "phi" ? phi(both[i][j], sizes[i], sizes[j], N)
    : Q.measure === "jaccard" ? jaccard(both[i][j], sizes[i], sizes[j]) : both[i][j]);
  const themeStart = sets.map((s, i) => i === 0 || s.r.group !== sets[i - 1].r.group);
  const color = (r) => rowColor(r, Q.index.themeColors);

  // Theme bands over the columns, then one vertical label per code.
  const bands = [];
  sets.forEach((s, i) => {
    if (themeStart[i]) bands.push({ group: s.r.group, r: s.r, span: 0 });
    bands[bands.length - 1].span++;
  });
  const thead = el("thead", {},
    el("tr", { class: "band-row" }, el("th", { class: "corner" }),
      ...bands.map((b) => el("th", { colspan: b.span, class: "band theme-start", title: b.group, style: `--strong:${color(b.r)[0]}` },
        el("span", {}, b.group)))),
    el("tr", {}, el("th", { class: "corner" }),
      ...sets.map((s, j) => el("th", {
        class: "col-label" + (themeStart[j] ? " theme-start" : ""), dataset: { j }, title: s.r.description || s.r.fc,
      }, el("span", { class: "vlabel" }, themeDot(color(s.r)), modLabel(s.r.fc))))));

  const tbody = el("tbody", {}, ...sets.map((si, i) => el("tr", { class: themeStart[i] ? "theme-start-row" : "" },
    el("th", { class: "row-label", dataset: { i }, title: si.r.description || si.r.fc },
      themeDot(color(si.r)), modLabel(si.r.fc)),
    ...sets.map((_, j) => {
      const cls = "cell" + (themeStart[j] ? " theme-start" : "");
      if (i === j) return el("td", { class: cls + " diag", dataset: { i, j } }, String(sizes[i]));
      const v = value(i, j);
      const c = cellColor(v, maxCount);
      return el("td", {
        class: cls + (c && c.dark ? " on-dark" : ""), dataset: { i, j },
        style: c ? `background:${c.bg}` : "",
      }, Q.measure === "count" ? (v ? String(v) : "") : fmt2(v));
    }))));

  const table = el("table", { class: "matrix" }, thead, tbody);
  Q.view = { sets, sizes, both, N, groupLabel };
  $("#matrix-wrap").replaceChildren(table);
}

// ------------------------------------------------------------ hover

function onHover(ev) {
  const td = ev.target.closest("td.cell");
  const tip = $("#q-tip");
  document.querySelectorAll(".matrix .hot").forEach((n) => n.classList.remove("hot"));
  if (!td || !Q.view) { tip.hidden = true; return; }
  const i = +td.dataset.i, j = +td.dataset.j;
  const { sets, sizes, both, N, groupLabel } = Q.view;
  document.querySelector(`.row-label[data-i="${i}"]`).classList.add("hot");
  document.querySelector(`.col-label[data-j="${j}"]`).classList.add("hot");
  const a = modLabel(sets[i].r.fc), b = modLabel(sets[j].r.fc);
  const pct = (x) => (N ? ` (${Math.round((100 * x) / N)}%)` : "");
  const lines = i === j
    ? [el("strong", {}, a), `${sizes[i]} of ${N}${pct(sizes[i])} given this code`]
    : [el("strong", {}, `${a}  ×  ${b}`),
      `both: ${both[i][j]}`,
      `${a}: ${sizes[i]}`,
      `${b}: ${sizes[j]}`,
      `φ ${fmt2(phi(both[i][j], sizes[i], sizes[j], N)) || "–"}   ·   Jaccard ${fmt2(jaccard(both[i][j], sizes[i], sizes[j])) || "–"}`];
  tip.replaceChildren(...lines.map((l) => el("div", {}, l)), el("div", { class: "where" }, `${groupLabel}, ${TRANS[Q.trans]}: N = ${N}`));
  tip.hidden = false;
  const pad = 14, w = tip.offsetWidth, h = tip.offsetHeight;
  let x = ev.clientX + pad, y = ev.clientY + pad;
  if (x + w > window.innerWidth - 8) x = ev.clientX - w - pad;
  if (y + h > window.innerHeight - 8) y = ev.clientY - h - pad;
  tip.style.left = `${x}px`;
  tip.style.top = `${y}px`;
}

function bindEvents() {
  setupFilesForm(loadFromForm);
  $("#filter-site").addEventListener("change", render);
  $("#filter-search").addEventListener("input", render);
  document.querySelectorAll(".group-filter input").forEach((i) => i.addEventListener("change", render));
  $("#matrix-wrap").addEventListener("mousemove", onHover);
  $("#matrix-wrap").addEventListener("mouseleave", () => { $("#q-tip").hidden = true; });
}

init().catch((e) => setStatus(e.message, true));
