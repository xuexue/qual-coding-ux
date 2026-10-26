"use strict";

const S = {
  data: null,          // snapshot from the server
  pid: null,           // selected participant id
  mode: "notes",       // "notes" | "coding"
  selection: null,     // {source, field, start, end, text}
  transition: "",      // note transition the pending selection will be coded under
  analysis: { key: null, mod: "" },  // analysis mode: selected code key and modifier filter
  closedThemes: new Set(),           // codebook themes the user collapsed
};

const NOTE_ORDER = ["goodatml_pp", "goodatml_pd", "discipline_pp", "discipline_pd"];
const TIME_LABELS = { "1-Pre": "Pre", "2-Post": "Post", "3-DelayPost": "Delay-post" };

const $ = (sel) => document.querySelector(sel);

// Theme colours: [strong (text/borders), tint (highlight background)], assigned in
// codebook order. "Patterns across time" is always grey; proposals have their own style.
const THEME_PALETTE = [
  ["#1f6fb2", "#cfe2f3"], // blue
  ["#c45f00", "#fde0c2"], // orange
  ["#2e8b57", "#cdeccf"], // green
  ["#b83227", "#f7cdc8"], // red
  ["#7b4fb3", "#e2d5f3"], // purple
  ["#8c5a3c", "#ead8cb"], // brown
  ["#b8396f", "#f8d3e3"], // pink
  ["#6f7a12", "#e7ecc0"], // olive
  ["#11807f", "#c6ecec"], // teal
];
const PATTERN_COLOR = ["#5f5f5f", "#e0e0e0"];
// Proposals: no fill + dashed dark box, so they can't be confused with any theme colour.
const PROPOSAL_COLOR = ["#222222", "transparent"];

function buildThemeColors(codebook) {
  const colors = new Map();
  let i = 0;
  for (const c of codebook) {
    if (colors.has(c.theme)) continue;
    colors.set(c.theme, c.kind === "pattern" ? PATTERN_COLOR : THEME_PALETTE[i++ % THEME_PALETTE.length]);
  }
  return colors;
}

/** [strong, tint] for an applied code or codebook entry. */
function colorFor(theme, code) {
  if (code === S.data.proposeCode) return PROPOSAL_COLOR;
  return (S.themeColors && S.themeColors.get(theme)) || PATTERN_COLOR;
}

function themeDot(color) {
  return el("span", { class: "theme-dot", style: `background:${color[0]}` });
}

function el(tag, attrs = {}, ...children) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === "class") e.className = v;
    else if (k.startsWith("on")) e.addEventListener(k.slice(2), v);
    else if (k === "dataset") Object.assign(e.dataset, v);
    else e.setAttribute(k, v);
  }
  for (const c of children) if (c != null) e.append(c);
  return e;
}

function setStatus(msg, isError = false) {
  const s = $("#status");
  s.textContent = msg;
  s.className = isError ? "error" : "";
  if (!isError) setTimeout(() => { if (s.textContent === msg) s.textContent = ""; }, 3000);
}

async function api(method, url, body) {
  const res = await fetch(url, {
    method,
    headers: body ? { "Content-Type": "application/json" } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await res.json();
  if (!res.ok) throw new Error(json.error || res.statusText);
  return json;
}

// ------------------------------------------------------------ loading

async function init() {
  const snap = await api("GET", "/api/state");
  if (snap.participants.length) {
    fillForm(snap.paths);
    applySnapshot(snap);
  } else {
    fillForm(await api("GET", "/api/last-session"));
  }
  bindEvents();
}

function fillForm(paths) {
  const form = $("#load-form");
  for (const k of ["data", "notes", "codebook", "highlights", "codes"]) {
    if (paths && paths[k]) {
      form.elements[k].value = paths[k];
      showPathEnd(form.elements[k]);
    }
  }
}

/** Scroll a narrow path input so the file name (the end) is visible; full path on hover. */
function showPathEnd(input) {
  input.title = input.value;
  requestAnimationFrame(() => { input.scrollLeft = input.scrollWidth; });
}

function applySnapshot(snap) {
  S.data = snap;
  S.themeColors = buildThemeColors(snap.codebook);
  if (!snap.participants.find((p) => p.id === S.pid)) S.pid = null;
  const sites = [...new Set(snap.participants.map((p) => p.site))].sort();
  const sel = $("#filter-site");
  const cur = sel.value;
  sel.replaceChildren(el("option", { value: "" }, "All sites"),
    ...sites.map((s) => el("option", { value: s }, s)));
  sel.value = sites.includes(cur) ? cur : "";
  fillForm(snap.paths);
  renderAll();
}

async function onLoad(ev) {
  ev.preventDefault();
  const f = ev.target.elements;
  try {
    const snap = await api("POST", "/api/load", {
      data: f.data.value, notes: f.notes.value, codebook: f.codebook.value,
      highlights: f.highlights.value, codes: f.codes.value,
    });
    applySnapshot(snap);
    setStatus(`Loaded ${snap.participants.length} participants, ${snap.codebook.length} codes, ` +
      `${snap.annotations.length} existing code applications.`);
  } catch (e) {
    setStatus(e.message, true);
  }
}

// ------------------------------------------------------------ rendering

function renderAll() {
  renderParticipants();
  renderResponses();
  renderNotes();
  renderCodebook();
  renderProposals();
  renderAnalysisPanel();
}

function annotationsFor(pid) {
  return S.data ? S.data.annotations.filter((a) => a.participant_id === pid) : [];
}

/** Participants passing the site / group / id filters (the "selection" for analysis counts). */
function filteredParticipants() {
  if (!S.data) return [];
  const site = $("#filter-site").value;
  const groups = [...document.querySelectorAll(".group-filter input:checked")].map((i) => i.value);
  const q = $("#filter-search").value.trim().toLowerCase();
  return S.data.participants
    .filter((p) => !site || p.site === site)
    .filter((p) => groups.includes(p.group) || (p.group !== "A" && p.group !== "B"))
    .filter((p) => !q || p.id.toLowerCase().includes(q));
}

function renderParticipants() {
  const list = $("#participant-list");
  if (!S.data) return;
  let ps = filteredParticipants();
  const ak = S.mode === "analysis" ? S.analysis.key : null;
  if (ak) ps = ps.filter((p) => analysisMatches(p.id).length);
  const items = ps.map((p) => {
    let badges;
    if (ak) {
      // Modifier breakdown of the selected code for this participant, e.g. "+2 =1".
      const counts = countBy(analysisMatches(p.id), (a) => a.modifier || "·");
      badges = Object.entries(counts).map(([m, n]) =>
        el("span", { class: "badge mod-badge", title: `${n}× ${m === "·" ? "(no modifier)" : m}` },
          `${m === "-" ? "−" : m === "·" ? "✓" : m}${n > 1 ? n : ""}`));
    } else {
      const notes = S.data.notes[p.id] || {};
      const expected = expectedNoteKeys(p);
      const nNotes = expected.filter((k) => (notes[k] || "").trim()).length;
      const nCodes = annotationsFor(p.id).length;
      badges = [
        el("span", { class: "badge" + (nNotes === expected.length ? " done" : ""), title: "notes written" },
          `${nNotes}/${expected.length}`),
        el("span", { class: "badge" + (nCodes ? " done" : ""), title: "codes applied" }, `${nCodes}c`),
      ];
    }
    return el("li", {
      class: p.id === S.pid ? "selected" : "",
      onclick: () => selectParticipant(p.id),
    },
      el("span", { class: "pid" }, p.id),
      el("span", { class: "badges" }, ...badges));
  });
  list.replaceChildren(...items);
  if (!items.length) list.append(el("li", { class: "empty" }, ak ? "No participants with this code." : "No participants match."));
}

// ------------------------------------------------------------ analysis

/** Identity of a code across annotations and the codebook. */
function codeKey(theme, code) {
  return code === S.data.proposeCode ? code : `${theme}|${code}`;
}

function countBy(items, fn) {
  const out = {};
  for (const x of items) {
    const k = fn(x);
    out[k] = (out[k] || 0) + 1;
  }
  return out;
}

/** The selected code's applications for one participant (respecting the modifier filter). */
function analysisMatches(pid) {
  const { key, mod } = S.analysis;
  return annotationsFor(pid).filter((a) =>
    codeKey(a.theme, a.code) === key && (!mod || a.modifier === mod));
}

/** Annotations of participants in the current filter selection. */
function selectionAnnotations() {
  const ids = new Set(filteredParticipants().map((p) => p.id));
  return S.data.annotations.filter((a) => ids.has(a.participant_id));
}

function selectAnalysisCode(key) {
  S.analysis.key = S.analysis.key === key ? null : key;
  S.analysis.mod = "";
  renderAll();
}

function renderAnalysisPanel() {
  const box = $("#analysis-panel");
  if (!S.data || S.mode !== "analysis") return;
  const { key, mod } = S.analysis;
  const nSel = filteredParticipants().length;
  if (!key) {
    box.replaceChildren(el("div", { class: "empty" },
      `Click a code to see where it appears. Counts are within the current selection (${nSel} participants).`));
    return;
  }
  const isProp = key === S.data.proposeCode;
  const entry = isProp ? null : S.data.codebook.find((c) => codeKey(c.theme, c.code) === key);
  const [theme, name] = isProp ? ["", S.data.proposeLabel]
    : entry ? [entry.theme, entry.code] : [key.slice(0, key.indexOf("|")), key.slice(key.indexOf("|") + 1)];
  const color = colorFor(theme, isProp ? key : name);
  const all = selectionAnnotations().filter((a) => codeKey(a.theme, a.code) === key);
  const anns = all.filter((a) => !mod || a.modifier === mod);
  const pids = new Set(anns.map((a) => a.participant_id));
  const group = (pid) => (S.data.participants.find((p) => p.id === pid) || {}).group || "?";
  const byGroupTimes = countBy(anns, (a) => group(a.participant_id));
  const byGroupPeople = countBy([...pids], group);
  const byMod = countBy(all, (a) => a.modifier);
  const byTransition = countBy(anns, (a) => a.transition);

  const modButtons = (entry && entry.kind === "pattern") || isProp ? null :
    el("div", { class: "mod-filter" },
      ...["", "+", "-", "="].map((m) => el("button", {
        class: m === mod ? "active" : "",
        onclick: () => { S.analysis.mod = m; renderAll(); },
      }, m === "" ? `all ${all.length}` : `${m === "-" ? "−" : m} ${byMod[m] || 0}`)));

  const table = el("table", { class: "stats" },
    el("tr", {}, el("th", {}, ""), el("th", {}, "times"), el("th", {}, "participants")),
    ...["A", "B", ...Object.keys(byGroupTimes).filter((g) => g !== "A" && g !== "B")].map((g) =>
      el("tr", {}, el("td", {}, `Group ${g}`), el("td", {}, String(byGroupTimes[g] || 0)),
        el("td", {}, String(byGroupPeople[g] || 0)))),
    el("tr", { class: "total" }, el("td", {}, "Total"), el("td", {}, String(anns.length)),
      el("td", {}, String(pids.size))));

  const transitions = el("ul", { class: "transition-counts" },
    ...NOTE_ORDER.filter((k) => byTransition[k]).map((k) =>
      el("li", {}, el("span", {}, S.data.noteColumns[k]), el("strong", {}, String(byTransition[k])))));

  box.replaceChildren(
    el("div", { class: "analysis-head" },
      el("span", { class: "ann-code" + (isProp ? " proposal-code" : ""), style: `--strong:${color[0]};--tint:${color[1]}` }, name),
      el("button", { class: "del", title: "Clear", onclick: () => selectAnalysisCode(key) }, "×")),
    entry && entry.description ? el("div", { class: "desc" }, entry.description) : null,
    modButtons,
    table,
    transitions,
    el("div", { class: "where" }, `Within current selection of ${nSel} participants.`));
}

/** Note transitions that apply: the delay-post ones only if there is a delay-post answer. */
function hasDelayPost(p, q) {
  return ((p.responses[q] || {})["3-DelayPost"] || "").trim() !== "";
}

function expectedNoteKeys(p) {
  return NOTE_ORDER.filter((k) => {
    const [q, kind] = k.split("_");
    return kind === "pp" || hasDelayPost(p, q);
  });
}

function selectParticipant(pid) {
  S.pid = pid;
  S.selection = null;
  closeCodePopup();
  renderAll();
}

function currentParticipant() {
  return S.data && S.data.participants.find((p) => p.id === S.pid);
}

function renderResponses() {
  const box = $("#responses");
  const p = currentParticipant();
  $("#current-pid").textContent = p ? `— ${p.id} (${p.site}, group ${p.group || "?"})` : "";
  if (!p) {
    box.replaceChildren(el("p", { class: "empty" }, "Select a participant."));
    return;
  }
  const anns = annotationsFor(p.id).filter((a) => a.source === "response");
  box.replaceChildren(...S.data.questions.map((q) => {
    const times = S.data.times.filter((t) => t in p.responses[q]);
    return el("div", { class: "question" },
      el("h3", {}, q),
      ...(times.length ? times : [null]).map((t) => {
        if (t === null) return el("p", { class: "empty" }, "No responses.");
        const field = `${q}|${t}`;
        const textEl = el("div", { class: "text codable", dataset: { source: "response", field } });
        renderHighlighted(textEl, p.responses[q][t], anns.filter((a) => a.field === field),
          pendingFor("response", field));
        return el("div", { class: "response" }, el("div", { class: "time" }, TIME_LABELS[t] || t), textEl);
      }));
  }));
}

function renderNotes() {
  const box = $("#notes");
  const p = currentParticipant();
  if (!p) {
    box.replaceChildren();
    return;
  }
  const notes = S.data.notes[p.id] || {};
  const anns = annotationsFor(p.id).filter((a) => a.source === "note");
  const expected = expectedNoteKeys(p);
  box.replaceChildren(...NOTE_ORDER.map((key) => {
    const label = S.data.noteColumns[key];
    const value = notes[key] || "";
    let body;
    if (S.mode === "notes") {
      body = el("textarea", { rows: 6, placeholder: expected.includes(key) ? "" : "(no delay-post response)" });
      body.value = value;
      let timer = null;
      const save = () => { clearTimeout(timer); timer = null; saveNote(p.id, key, body.value); };
      body.addEventListener("input", () => { clearTimeout(timer); timer = setTimeout(save, 700); });
      body.addEventListener("blur", () => { if (timer) save(); });
    } else {
      body = el("div", { class: "text codable note-text", dataset: { source: "note", field: key } });
      if (value) renderHighlighted(body, value, anns.filter((a) => a.field === key), pendingFor("note", key));
      else body.append(el("span", { class: "empty" }, "(no note)"));
    }
    return el("div", { class: "note" }, el("label", {}, label), body, annotationList(p.id, key));
  }));
}

async function saveNote(pid, key, value) {
  const notes = (S.data.notes[pid] ||= {});
  if ((notes[key] || "") === value) return;
  notes[key] = value;
  try {
    await api("POST", "/api/notes", { participant: pid, key, value });
    setStatus("Note saved");
    renderParticipants();
  } catch (e) {
    setStatus("Failed to save note: " + e.message, true);
  }
}

/** Find where an annotation sits in (possibly edited) text. Returns [start, end] or null. */
function resolveAnchor(text, a) {
  if (a.start >= 0 && text.slice(a.start, a.end) === a.text) return [a.start, a.end];
  if (!a.text) return null;
  let best = -1, i = text.indexOf(a.text);
  while (i !== -1) {
    if (best === -1 || Math.abs(i - a.start) < Math.abs(best - a.start)) best = i;
    i = text.indexOf(a.text, i + 1);
  }
  return best === -1 ? null : [best, best + a.text.length];
}

/** The pending (not yet coded) selection, if it lies in this source/field. */
function pendingFor(source, field) {
  const s = S.selection;
  return s && s.source === source && s.field === field ? s : null;
}

function renderHighlighted(container, text, anns, pending = null) {
  const spans = [];
  if (pending) spans.push({ a: null, s: pending.start, e: pending.end });
  for (const a of anns) {
    const r = resolveAnchor(text, a);
    a._stale = !r;
    if (!r) continue;
    if (r[0] !== a.start) {
      // Note text shifted since coding; persist the new offsets.
      a.start = r[0]; a.end = r[1];
      api("PATCH", `/api/annotations/${a.annotation_id}`, { start: r[0], end: r[1] }).catch(() => {});
    }
    spans.push({ a, s: r[0], e: r[1] });
  }
  const cuts = [...new Set([0, text.length, ...spans.flatMap((x) => [x.s, x.e])])].sort((x, y) => x - y);
  container.replaceChildren();
  for (let i = 0; i < cuts.length - 1; i++) {
    const [b0, b1] = [cuts[i], cuts[i + 1]];
    const piece = text.slice(b0, b1);
    const all = spans.filter((x) => x.s <= b0 && x.e >= b1);
    const isPending = all.some((x) => !x.a);
    const cover = all.filter((x) => x.a);
    if (!cover.length) {
      container.append(isPending ? el("span", { class: "pending" }, piece) : document.createTextNode(piece));
      continue;
    }
    // One tint per distinct theme; several themes → diagonal stripes.
    const tints = [...new Set(cover.map((x) => colorFor(x.a.theme, x.a.code)[1]))];
    const bg = tints.length === 1 ? tints[0]
      : `repeating-linear-gradient(135deg, ${tints.map((t, k) => `${t} ${k * 6}px ${(k + 1) * 6}px`).join(", ")})`;
    // Modifier markers (+ − =) after the last piece of each highlight, drawn via CSS ::after
    // so they never become part of the text (keeps selection offsets intact).
    const ending = cover.filter((x) => x.e === b1 && x.a.modifier);
    const mods = ending.map((x) => (x.a.modifier === "-" ? "−" : x.a.modifier)).join("");
    const markColor = ending.length ? colorFor(ending[0].a.theme, ending[0].a.code)[0] : "";
    // Underline style by modifier: + solid, − dotted, = double (innermost/last-applied code wins).
    const withMod = cover.filter((x) => x.a.modifier);
    const top = withMod[withMod.length - 1];
    const line = top ? `;border-bottom:${top.a.modifier === "=" ? "3px double" : `2px ${top.a.modifier === "-" ? "dotted" : "solid"}`} ${colorFor(top.a.theme, top.a.code)[0]}` : "";
    const hasProposal = cover.some((x) => x.a.code === S.data.proposeCode);
    // Analysis mode: fade highlights that aren't the selected code.
    const { key: ak, mod: am } = S.analysis;
    const dim = S.mode === "analysis" && ak &&
      !cover.some((x) => codeKey(x.a.theme, x.a.code) === ak && (!am || x.a.modifier === am));
    container.append(el("span", {
      class: "hl" + (cover.length > 1 ? " multi" : "") + (isPending ? " pending" : "") +
        (mods ? " has-mod" : "") + (hasProposal ? " proposal" : "") + (dim ? " dim" : ""),
      style: `background:${bg}` + line + (mods ? `;--mark:${markColor}` : ""),
      ...(mods ? { "data-mods": mods } : {}),
      title: cover.map((x) => x.a.full_code + (x.a.comment ? ` — ${x.a.comment}` : "")).join("\n"),
      dataset: { ann: cover.map((x) => x.a.annotation_id).join(" ") },
    }, piece));
  }
}

// ------------------------------------------------------------ codebook

function renderCodebook() {
  const box = $("#codebook");
  if (!S.data) return;
  const analysis = S.mode === "analysis";
  // Counts of each code within the current selection (analysis mode only).
  const counts = analysis ? countBy(selectionAnnotations(), (a) => codeKey(a.theme, a.code)) : null;

  const themes = new Map();
  for (const c of S.data.codebook) {
    if (!themes.has(c.theme)) themes.set(c.theme, []);
    themes.get(c.theme).push(c);
  }
  if (!themes.size) {
    box.replaceChildren(el("p", { class: "empty" }, "No codebook loaded."));
    return;
  }
  const sections = [...themes.entries()].map(([theme, codes]) => {
    const d = el("details", { class: "theme" },
      el("summary", {}, themeDot(colorFor(theme)), theme || "(no theme)",
        counts ? el("span", { class: "count" }, ` ${codes.reduce((s, c) => s + (counts[codeKey(c.theme, c.code)] || 0), 0)}`) : null),
      el("div", { class: "code-list" }, ...codes.map((c) => codeChip(c, counts))));
    d.open = !S.closedThemes.has(theme);
    d.addEventListener("toggle", () => {
      if (d.open) S.closedThemes.delete(theme); else S.closedThemes.add(theme);
    });
    return d;
  });
  if (analysis) {
    const n = counts[S.data.proposeCode] || 0;
    sections.push(el("div", { class: "code-list" },
      el("button", {
        class: "code-chip propose-chip" + (S.analysis.key === S.data.proposeCode ? " selected" : ""),
        onclick: () => selectAnalysisCode(S.data.proposeCode),
      }, S.data.proposeLabel, el("span", { class: "chip-count" }, String(n)))));
  }
  box.replaceChildren(...sections);
}

/** All "propose new code" applications, across participants, grouped by description. */
function renderProposals() {
  const box = $("#proposals");
  if (!S.data) return;
  const props = S.data.annotations.filter((a) => a.code === S.data.proposeCode);
  if (!props.length) {
    box.replaceChildren();
    return;
  }
  const groups = new Map();
  for (const a of props) {
    const key = (a.comment || "").trim() || "(no description)";
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(a);
  }
  const sorted = [...groups.entries()].sort((x, y) => y[1].length - x[1].length || x[0].localeCompare(y[0]));
  box.replaceChildren(
    el("details", { class: "theme proposals", open: "" },
      el("summary", {}, "Proposed codes", el("span", { class: "count" }, ` ${props.length}`)),
      ...sorted.map(([desc, anns]) =>
        el("div", { class: "proposal-group" },
          el("div", { class: "proposal-desc" }, desc, el("span", { class: "count" }, ` ×${anns.length}`)),
          el("ul", {}, ...anns.map((a) =>
            el("li", {
              class: a.participant_id === S.pid ? "current" : "",
              title: `“${a.text}”\n${fieldLabel(a)} → ${S.data.noteColumns[a.transition] || ""}`,
              onclick: () => jumpToAnnotation(a),
            },
              el("span", { class: "pid" }, a.participant_id),
              el("span", { class: "snippet" }, a.text))))))));
}

function jumpToAnnotation(a) {
  if (S.pid !== a.participant_id) selectParticipant(a.participant_id);
  const span = [...document.querySelectorAll(".hl")].find((s) => s.dataset.ann.split(" ").includes(a.annotation_id));
  if (span) {
    span.scrollIntoView({ block: "center", behavior: "smooth" });
    flash(a.annotation_id, true);
    setTimeout(() => flash(a.annotation_id, false), 1500);
  }
}

/**
 * A code in the codebook column: description on hover. Coding mode: click opens the popup
 * for it. Analysis mode: shows its count in the selection; click selects it for analysis.
 */
function codeChip(c, counts = null) {
  const [strong, tint] = colorFor(c.theme, c.code);
  const key = codeKey(c.theme, c.code);
  const n = counts ? counts[key] || 0 : null;
  return el("button", {
    class: `code-chip ${c.kind}` + (counts && S.analysis.key === key ? " selected" : "") +
      (counts && !n ? " zero" : ""),
    style: `--strong:${strong};--tint:${tint}`,
    title: c.description || c.code,
    onclick: () => {
      if (S.mode === "analysis") {
        selectAnalysisCode(key);
        return;
      }
      if (!S.selection) {
        setStatus("Highlight some text first.", true);
        return;
      }
      const mark = document.querySelector(".pending");
      openCodePopup(mark ? mark.getBoundingClientRect() : null, c.code);
    },
  }, c.code, counts ? el("span", { class: "chip-count" }, String(n)) : null);
}

async function applyCode(code, modifier = "") {
  const sel = S.selection;
  if (!sel) {
    setStatus("Highlight some text first.", true);
    return;
  }
  let body;
  if (code === null) {
    const comment = prompt("Describe the proposed code (optional):", "");
    if (comment === null) return;
    body = { code: S.data.proposeCode, theme: "", modifier: "", comment };
  } else {
    body = { code: code.code, theme: code.theme, modifier: code.kind === "pattern" ? "" : modifier };
  }
  try {
    const a = await api("POST", "/api/annotations", {
      ...body, ...sel, participant: S.pid, transition: S.transition,
    });
    S.data.annotations.push(a);
    S.selection = null;
    closeCodePopup();
    window.getSelection().removeAllRanges();
    renderAll();
    setStatus(`Applied ${a.full_code}`);
  } catch (e) {
    setStatus("Failed to save code: " + e.message, true);
  }
}

async function deleteAnnotation(id) {
  try {
    await api("DELETE", `/api/annotations/${id}`);
    S.data.annotations = S.data.annotations.filter((a) => a.annotation_id !== id);
    renderAll();
  } catch (e) {
    setStatus("Failed to delete: " + e.message, true);
  }
}

function fieldLabel(a) {
  if (a.source === "note") return "note: " + (S.data.noteColumns[a.field] || a.field);
  const [q, t] = a.field.split("|");
  return `${q} ${TIME_LABELS[t] || t}`;
}

/** Codes applied under one note transition, shown beneath that note box. */
function annotationList(pid, transition) {
  const anns = annotationsFor(pid).filter((a) => a.transition === transition);
  if (!anns.length) return null;
  const { key: ak, mod: am } = S.analysis;
  const dim = (a) => S.mode === "analysis" && ak &&
    !(codeKey(a.theme, a.code) === ak && (!am || a.modifier === am));
  return el("ul", { class: "annotation-list" }, ...anns.map((a) =>
    el("li", {
      class: (a._stale ? "stale" : "") + (dim(a) ? " dim" : ""),
      title: `“${a.text}”\n(${fieldLabel(a)})` + (a._stale ? "\ntext no longer found" : ""),
      onmouseenter: () => flash(a.annotation_id, true),
      onmouseleave: () => flash(a.annotation_id, false),
    },
      el("strong", {
        class: "ann-code" + (a.code === S.data.proposeCode ? " proposal-code" : ""),
        style: `--strong:${colorFor(a.theme, a.code)[0]};--tint:${colorFor(a.theme, a.code)[1]}`,
      }, a.full_code),
      el("span", { class: "snippet" }, a.text),
      a.comment ? el("span", { class: "comment" }, a.comment) : null,
      transitionSelect(a),
      el("button", { class: "del", title: "Remove", onclick: () => deleteAnnotation(a.annotation_id) }, "×"))));
}

function transitionSelect(a) {
  // Compact "move to…" menu: shows ⇄, lists the other transitions.
  const sel = el("select", { class: "ann-transition", title: "Move to another transition" },
    el("option", { value: "" }, "⇄"),
    ...NOTE_ORDER.filter((k) => k !== a.transition)
      .map((k) => el("option", { value: k }, `Move to ${S.data.noteColumns[k]}`)));
  sel.addEventListener("change", async () => {
    if (!sel.value) return;
    try {
      const r = await api("PATCH", `/api/annotations/${a.annotation_id}`, { transition: sel.value });
      a.transition = r.transition;
      renderNotes(); // the code moves under its new note box
      setStatus("Moved code");
    } catch (e) {
      sel.value = "";
      setStatus(e.message, true);
    }
  });
  return sel;
}

async function saveAll() {
  const f = $("#load-form").elements;
  try {
    const r = await api("POST", "/api/save", {
      notes: f.notes.value, highlights: f.highlights.value, codes: f.codes.value,
    });
    S.data.paths = r.paths;
    fillForm(r.paths);
    setStatus(`Saved notes, codes and highlights`);
  } catch (e) {
    setStatus("Save failed: " + e.message, true);
  }
}

function flash(id, on) {
  document.querySelectorAll(".hl").forEach((s) => {
    if (s.dataset.ann.split(" ").includes(id)) s.classList.toggle("flash", on);
  });
}

// ------------------------------------------------------------ selection

/** Mirrors default_transition() in app.py. */
function defaultTransition(source, field) {
  if (source === "note") return field;
  const [q, t] = field.split("|");
  return t === "3-DelayPost" ? `${q}_pd` : `${q}_pp`;
}

function offsetIn(container, node, offset) {
  const r = document.createRange();
  r.selectNodeContents(container);
  r.setEnd(node, offset);
  return r.toString().length;
}

function captureSelection() {
  if (S.mode === "notes" || !S.pid) return;  // coding and analysis modes both allow coding
  const sel = window.getSelection();
  if (!sel.rangeCount || sel.isCollapsed) return;
  const range = sel.getRangeAt(0);
  const host = (n) => (n.nodeType === 1 ? n : n.parentElement).closest(".codable");
  const c = host(range.startContainer);
  if (!c || c !== host(range.endContainer)) {
    if (c || host(range.endContainer)) setStatus("Select text within a single response or note.", true);
    return;
  }
  let start = offsetIn(c, range.startContainer, range.startOffset);
  let end = offsetIn(c, range.endContainer, range.endOffset);
  const full = c.textContent;
  // Trim surrounding whitespace from the selection.
  while (start < end && /\s/.test(full[start])) start++;
  while (end > start && /\s/.test(full[end - 1])) end--;
  if (start === end) return;
  S.selection = { source: c.dataset.source, field: c.dataset.field, start, end, text: full.slice(start, end) };
  S.transition = defaultTransition(S.selection.source, S.selection.field);
  const rect = range.getBoundingClientRect();
  sel.removeAllRanges();
  renderResponses();  // re-render to show the pending selection as a mark
  renderNotes();
  openCodePopup(rect);
}

function clearSelection() {
  S.selection = null;
  closeCodePopup();
  renderResponses();
  renderNotes();
}

// ------------------------------------------------------------ autocomplete popup

const popup = { el: null, input: null, list: null, transition: null, items: [], active: 0 };

/** Parse "+tra", "tra=", "tra" into {mod, q}. */
function parseCodeQuery(text) {
  let q = text.trim(), mod = null;
  const lead = q.match(/^[+=\-]/), trail = q.match(/[+=\-]$/);
  if (lead) { mod = lead[0]; q = q.slice(1); } else if (trail) { mod = trail[0]; q = q.slice(0, -1); }
  return { mod, q: q.trim().toLowerCase() };
}

function codeCandidates(text) {
  const { mod, q } = parseCodeQuery(text);
  const out = [];
  S.data.codebook.forEach((c, i) => {
    const name = c.code.toLowerCase();
    let score;
    if (!q) score = 3;
    else if (name.startsWith(q)) score = 0;
    else if (name.split(/[-_\s]+/).some((w) => w.startsWith(q))) score = 1;
    else if (name.includes(q)) score = 2;
    else if (`${c.theme} ${c.description}`.toLowerCase().includes(q)) score = 4;
    else return;
    if (c.kind === "pattern") {
      if (!mod) out.push({ c, mod: "", score, i });
    } else {
      for (const m of mod ? [mod] : ["+", "-", "="]) out.push({ c, mod: m, score, i });
    }
  });
  out.sort((a, b) => a.score - b.score || a.i - b.i);
  return [...out.slice(0, 40), { propose: true }];
}

function buildCodePopup() {
  popup.input = el("input", { placeholder: "Type a code… (+tra, tra=, ↑↓, Enter, Esc)" });
  popup.list = el("ul");
  popup.transition = el("select", { title: "Transition column in the codes CSV" });
  popup.el = el("div", { id: "code-popup", hidden: "" },
    popup.input, popup.list, el("div", { class: "popup-foot" }, "→ ", popup.transition));
  document.body.append(popup.el);

  popup.input.addEventListener("input", renderCodePopupList);
  popup.input.addEventListener("keydown", (ev) => {
    const n = popup.items.length;
    if (ev.key === "ArrowDown") { popup.active = (popup.active + 1) % n; renderActive(); }
    else if (ev.key === "ArrowUp") { popup.active = (popup.active - 1 + n) % n; renderActive(); }
    else if (ev.key === "Enter" || ev.key === "Tab") applyCandidate(popup.items[popup.active]);
    else if (ev.key === "Escape") clearSelection();
    else return;
    ev.preventDefault();
  });
  popup.transition.addEventListener("change", () => {
    S.transition = popup.transition.value;
    popup.input.focus();
  });
  document.addEventListener("mousedown", (ev) => {
    if (!popup.el.hidden && !popup.el.contains(ev.target) && !ev.target.closest("#col-codes")) {
      closeCodePopup();
    }
  });
}

function openCodePopup(rect, query = "") {
  if (!popup.el) buildCodePopup();
  popup.transition.replaceChildren(...NOTE_ORDER.map((k) => el("option", { value: k }, S.data.noteColumns[k])));
  popup.transition.value = S.transition;
  popup.input.value = query;
  popup.el.hidden = false;
  renderCodePopupList();
  if (!rect) {  // no anchor: centre over the codebook column
    const r = $("#col-codes").getBoundingClientRect();
    rect = { left: r.left + 10, top: r.top + 40, bottom: r.top + 40 };
  }
  const w = popup.el.offsetWidth, h = popup.el.offsetHeight;
  let top = rect.bottom + 4;
  if (top + h > window.innerHeight - 8) top = Math.max(8, rect.top - h - 4);
  const left = Math.min(Math.max(8, rect.left), window.innerWidth - w - 8);
  popup.el.style.top = `${top}px`;
  popup.el.style.left = `${left}px`;
  popup.input.focus({ preventScroll: true });
}

function closeCodePopup() {
  if (popup.el) popup.el.hidden = true;
}

function renderCodePopupList() {
  popup.items = codeCandidates(popup.input.value);
  popup.active = 0;
  popup.list.replaceChildren(...popup.items.map((it, idx) => {
    const li = it.propose
      ? el("li", { class: "propose" }, "＋ Propose new code")
      : el("li", { title: it.c.description },
          el("span", { class: "popup-code" }, themeDot(colorFor(it.c.theme, it.c.code)),
            el("strong", {}, `${it.mod}${it.c.code}`)),
          el("span", { class: "theme-hint" }, it.c.theme));
    li.addEventListener("mousedown", (ev) => { ev.preventDefault(); applyCandidate(it); });
    li.addEventListener("mousemove", () => { if (popup.active !== idx) { popup.active = idx; renderActive(); } });
    return li;
  }));
  renderActive();
}

function renderActive() {
  [...popup.list.children].forEach((li, i) => li.classList.toggle("active", i === popup.active));
  const li = popup.list.children[popup.active];
  if (li) li.scrollIntoView({ block: "nearest" });
}

function applyCandidate(it) {
  if (!it) return;
  if (it.propose) applyCode(null);
  else applyCode(it.c, it.mod);
}

// ------------------------------------------------------------ resizable columns

const COL_IDS = ["col-participants", "col-responses", "col-notes", "col-codes"];
const MIN_COL = 120;
let colWidths = null; // px widths of every column except the last visible one

function visibleCols() {
  return COL_IDS.map((id) => document.getElementById(id)).filter((c) => c.offsetParent !== null);
}

function applyColWidths() {
  const cols = visibleCols();
  if (!colWidths) {
    try { colWidths = JSON.parse(localStorage.getItem("prf-col-widths")); } catch { colWidths = null; }
  }
  if (Array.isArray(colWidths)) {
    const tmpl = cols.map((c, i) => (i < cols.length - 1 && colWidths[i] ? `${colWidths[i]}px` : "minmax(150px, 1fr)"));
    $("#columns").style.gridTemplateColumns = tmpl.join(" ");
  } else {
    $("#columns").style.gridTemplateColumns = ""; // CSS defaults
  }
  positionResizers();
}

function positionResizers() {
  const main = $("#columns");
  const cols = visibleCols();
  main.querySelectorAll(".col-resizer").forEach((r, i) => {
    const c = cols[i];
    if (!c || i >= cols.length - 1) { r.hidden = true; return; }
    r.hidden = false;
    r.style.left = `${c.offsetLeft + c.offsetWidth - 3}px`;
  });
}

function setupResizers() {
  const main = $("#columns");
  for (let i = 0; i < COL_IDS.length - 1; i++) {
    const r = el("div", { class: "col-resizer", title: "Drag to resize (double-click to reset)" });
    r.addEventListener("mousedown", (ev) => startResize(ev, i));
    r.addEventListener("dblclick", () => {
      colWidths = null;
      localStorage.removeItem("prf-col-widths");
      applyColWidths();
    });
    main.append(r);
  }
  window.addEventListener("resize", positionResizers);
  applyColWidths();
}

function startResize(ev, i) {
  ev.preventDefault();
  const cols = visibleCols();
  // Freeze current widths in px so only the dragged column (and the last, flexible one) change.
  // Keep saved widths of hidden columns (e.g. the codebook in notes mode).
  colWidths = Array.isArray(colWidths) ? [...colWidths] : [];
  cols.forEach((c, j) => { colWidths[j] = Math.round(c.getBoundingClientRect().width); });
  const startX = ev.clientX, startW = colWidths[i];
  const total = $("#columns").clientWidth;
  document.body.classList.add("resizing");
  const move = (e) => {
    let others = 0;
    for (let j = 0; j < cols.length - 1; j++) if (j !== i) others += colWidths[j];
    const max = total - others - 150; // keep the flexible last column usable
    colWidths[i] = Math.max(MIN_COL, Math.min(max, startW + e.clientX - startX));
    applyColWidths();
  };
  const up = () => {
    document.removeEventListener("mousemove", move);
    document.removeEventListener("mouseup", up);
    document.body.classList.remove("resizing");
    localStorage.setItem("prf-col-widths", JSON.stringify(colWidths));
  };
  document.addEventListener("mousemove", move);
  document.addEventListener("mouseup", up);
}

// ------------------------------------------------------------ events

function setMode(mode) {
  S.mode = mode;
  document.activeElement && document.activeElement.blur(); // flush pending note saves
  document.body.className = `mode-${mode}`;
  applyColWidths();
  document.querySelectorAll("#mode-toggle button").forEach((b) =>
    b.classList.toggle("active", b.dataset.mode === mode));
  S.selection = null;
  closeCodePopup();
  renderAll();
}

// Fields where Browse should pick a new file name rather than an existing file.
const SAVE_FIELDS = new Set(["codes"]);

function addBrowseButtons() {
  for (const input of $("#load-form").querySelectorAll("input")) {
    const label = input.parentElement.title || input.parentElement.firstChild.textContent.trim();
    const btn = el("button", { type: "button", class: "browse", title: `Browse for ${label}` }, "📂");
    input.addEventListener("blur", () => showPathEnd(input));
    input.addEventListener("input", () => { input.title = input.value; });
    btn.addEventListener("click", async () => {
      btn.disabled = true;
      setStatus("Waiting for the file dialog (it may open behind the browser)…");
      try {
        const r = await api("POST", "/api/browse", {
          mode: SAVE_FIELDS.has(input.name) ? "save" : "open",
          title: `Choose ${label}`,
          current: input.value,
        });
        if (r.path) {
          input.value = r.path;
          showPathEnd(input);
        }
        setStatus(r.path ? "" : "No file chosen");
      } catch (e) {
        setStatus("File dialog failed: " + e.message, true);
      } finally {
        btn.disabled = false;
      }
    });
    const wrap = el("span", { class: "path-field" });
    input.replaceWith(wrap);
    wrap.append(input, btn);
  }
}

function bindEvents() {
  addBrowseButtons();
  setupResizers();
  $("#load-form").addEventListener("submit", onLoad);
  $("#save-all").addEventListener("click", () => {
    document.activeElement && document.activeElement.blur(); // flush pending note edits
    setTimeout(saveAll, 50);
  });
  document.querySelectorAll("#mode-toggle button").forEach((b) =>
    b.addEventListener("click", () => setMode(b.dataset.mode)));
  // Filters define the "selection": analysis counts follow them.
  const onFilter = () => {
    renderParticipants();
    if (S.mode === "analysis") {
      renderCodebook();
      renderAnalysisPanel();
    }
  };
  $("#filter-site").addEventListener("change", onFilter);
  $("#filter-search").addEventListener("input", onFilter);
  document.querySelectorAll(".group-filter input").forEach((i) => i.addEventListener("change", onFilter));
  document.addEventListener("mouseup", (ev) => {
    if (ev.target.closest(".codable")) setTimeout(captureSelection, 0);
  });
  window.addEventListener("beforeunload", () => document.activeElement && document.activeElement.blur());
}

init().catch((e) => setStatus(e.message, true));
