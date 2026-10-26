"use strict";

const S = {
  data: null,          // snapshot from the server
  pid: null,           // selected participant id
  mode: "notes",       // "notes" | "coding"
  selection: null,     // {source, field, start, end, text}
  transition: "",      // note transition the pending selection will be coded under
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
}

function annotationsFor(pid) {
  return S.data ? S.data.annotations.filter((a) => a.participant_id === pid) : [];
}

function renderParticipants() {
  const list = $("#participant-list");
  if (!S.data) return;
  const site = $("#filter-site").value;
  const groups = [...document.querySelectorAll(".group-filter input:checked")].map((i) => i.value);
  const q = $("#filter-search").value.trim().toLowerCase();
  const items = S.data.participants
    .filter((p) => !site || p.site === site)
    .filter((p) => groups.includes(p.group) || (p.group !== "A" && p.group !== "B"))
    .filter((p) => !q || p.id.toLowerCase().includes(q))
    .map((p) => {
      const notes = S.data.notes[p.id] || {};
      const expected = expectedNoteKeys(p);
      const nNotes = expected.filter((k) => (notes[k] || "").trim()).length;
      const nCodes = annotationsFor(p.id).length;
      return el("li", {
        class: p.id === S.pid ? "selected" : "",
        onclick: () => selectParticipant(p.id),
      },
        el("span", { class: "pid" }, p.id),
        el("span", { class: "badges" },
          el("span", { class: "badge" + (nNotes === expected.length ? " done" : ""), title: "notes written" },
            `${nNotes}/${expected.length}`),
          el("span", { class: "badge" + (nCodes ? " done" : ""), title: "codes applied" }, `${nCodes}c`)));
    });
  list.replaceChildren(...items);
  if (!items.length) list.append(el("li", { class: "empty" }, "No participants match."));
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
    container.append(el("span", {
      class: "hl" + (cover.length > 1 ? " multi" : "") + (isPending ? " pending" : "") +
        (mods ? " has-mod" : "") + (hasProposal ? " proposal" : ""),
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
  if (S.renderedCodebook === S.data.codebook) return; // static list; keep collapsed/expanded state
  S.renderedCodebook = S.data.codebook;

  const themes = new Map();
  for (const c of S.data.codebook) {
    if (!themes.has(c.theme)) themes.set(c.theme, []);
    themes.get(c.theme).push(c);
  }
  if (!themes.size) {
    box.replaceChildren(el("p", { class: "empty" }, "No codebook loaded."));
    return;
  }
  box.replaceChildren(...[...themes.entries()].map(([theme, codes]) =>
    el("details", { class: "theme", open: "" },
      el("summary", {}, themeDot(colorFor(theme)), theme || "(no theme)"),
      el("div", { class: "code-list" }, ...codes.map(codeChip)))));
}

/** A code in the codebook column: description on hover; click opens the popup for it. */
function codeChip(c) {
  const [strong, tint] = colorFor(c.theme, c.code);
  return el("button", {
    class: `code-chip ${c.kind}`,
    style: `--strong:${strong};--tint:${tint}`,
    title: c.description || c.code,
    onclick: () => {
      if (!S.selection) {
        setStatus("Highlight some text first.", true);
        return;
      }
      const mark = document.querySelector(".pending");
      openCodePopup(mark ? mark.getBoundingClientRect() : null, c.code);
    },
  }, c.code);
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
  return el("ul", { class: "annotation-list" }, ...anns.map((a) =>
    el("li", {
      class: a._stale ? "stale" : "",
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
  if (S.mode !== "coding" || !S.pid) return;
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
  $("#filter-site").addEventListener("change", renderParticipants);
  $("#filter-search").addEventListener("input", renderParticipants);
  document.querySelectorAll(".group-filter input").forEach((i) => i.addEventListener("change", renderParticipants));
  document.addEventListener("mouseup", (ev) => {
    if (ev.target.closest(".codable")) setTimeout(captureSelection, 0);
  });
  window.addEventListener("beforeunload", () => document.activeElement && document.activeElement.blur());
}

init().catch((e) => setStatus(e.message, true));
