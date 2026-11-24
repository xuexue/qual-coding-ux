"use strict";
// Analysis page (spec.txt, ANALYSIS MODE): merge several coders' highlights, count each code
// per group and transition within the filtered participants, show the quotes behind a code for
// one group and transition, and write one summary per code, transition and group to
// code_summary.json.

const A = {
  data: null,        // snapshot from /api/analysis/state
  sel: null,         // selected code, transition and group: {fc: "+training", k: "pp" | "pd", g: "A" | "B"}
  pid: null,         // selected participant
  numMode: localStorage.getItem("prf-num-mode") === "pct" ? "pct" : "count",  // code table: count or %
  rows: [],          // [{fc, code, modifier, theme, kind, description, group}] in display order
  rowByFc: new Map(),
  hits: new Map(),   // fc -> pid -> {pp: Set(coderIdx), pd: Set(coderIdx)}
};

const TRANS = { pp: "Pre → Post", pd: "Pre/Post → Delay-post" };
const TRANS_TIMES = { pp: ["1-Pre", "2-Post"], pd: ["1-Pre", "2-Post", "3-DelayPost"] };
const GROUPS = ["A", "B"];
// The four numbers in a code row, left to right: [group, transition].
const CELLS = [["A", "pp"], ["B", "pp"], ["A", "pd"], ["B", "pd"]];
const cellLabel = (g, k) => `Group ${g}, ${TRANS[k]}`;

// One colour per coder: [strong, tint]. Highlights in the detail view show a single code,
// so colour only ever means "which coder".
const CODER_PALETTE = [
  ["#1f6fb2", "#cfe2f3"], ["#c45f00", "#fde0c2"], ["#2e8b57", "#cdeccf"],
  ["#7b4fb3", "#e2d5f3"], ["#b8396f", "#f8d3e3"], ["#11807f", "#c6ecec"],
];
const coderColor = (i) => CODER_PALETTE[i % CODER_PALETTE.length];

const tkind = (transition) => (transition.endsWith("_pd") ? "pd" : "pp");
const modLabel = (fc) => fc.replace(/^-/, "−");
const isSel = (fc, k, g) => !!A.sel && A.sel.fc === fc && (!k || A.sel.k === k) && (!g || A.sel.g === g);

/** The saved summary for a code, transition and group ({} if none). */
function summaryOf(fc, k, g) {
  return (((A.data.summaries[fc] || {})[k] || {})[g]) || {};
}
const summaryText = (fc, k, g) => summaryOf(fc, k, g).summary || "";

// ------------------------------------------------------------ loading

async function init() {
  bindEvents();
  const snap = await api("GET", "/api/analysis/state");
  if (snap.coders.length) {
    fillForm(snap.paths);
    applySnapshot(snap);
  } else {
    // Nothing loaded on the server yet: load the last-used (or default) files right away.
    fillForm(await api("GET", "/api/analysis/last-session"));
    await loadFromForm();
  }
}

function fillForm(paths) {
  const f = $("#load-form").elements;
  for (const k of ["data", "codebook", "summary"]) {
    if (paths[k]) { f[k].value = paths[k]; showPathEnd(f[k]); }
  }
  document.querySelectorAll(".coder-field").forEach((n) => n.remove());
  const hl = paths.highlights && paths.highlights.length ? paths.highlights : [""];
  hl.forEach((p) => addCoderField(p));
}

function addCoderField(value = "") {
  const input = el("input", { class: "coder-input", placeholder: "coder_highlights.json" });
  input.value = value;
  const label = el("label", { class: "coder-field" }, el("span", { class: "coder-name" }), input);
  $("#coder-fields").insertBefore(label, $("#add-coder"));
  addBrowseButton(input, "a coder's highlights JSON");
  label.append(el("button", {
    type: "button", class: "del", title: "Remove this coder",
    onclick: () => { label.remove(); numberCoderFields(); },
  }, "×"));
  showPathEnd(input);
  numberCoderFields();
  return input;
}

function numberCoderFields() {
  document.querySelectorAll(".coder-field").forEach((l, i) => {
    const name = l.querySelector(".coder-name");
    name.textContent = `Coder ${i + 1}`;
    name.style.color = coderColor(i)[0];
  });
}

async function onLoad(ev) {
  ev.preventDefault();
  await loadFromForm();
}

async function loadFromForm() {
  await flushSummary();
  const f = $("#load-form").elements;
  try {
    const snap = await api("POST", "/api/analysis/load", {
      data: f.data.value, codebook: f.codebook.value, summary: f.summary.value,
      highlights: [...document.querySelectorAll(".coder-input")].map((i) => i.value),
    });
    applySnapshot(snap);
    const nAnn = snap.coders.reduce((s, c) => s + c.annotations.length, 0);
    const noNotes = snap.coders.filter((c) => !c.notes_source).map((c) => c.name);
    setStatus(`Loaded ${snap.participants.length} participants, ${snap.coders.length} coders, ${nAnn} code applications.` +
      (A.recoded ? ` ${A.recoded} merged or pattern code(s) shown under their new name.` : "") +
      (noNotes.length ? ` No notes found for ${noNotes.join(", ")}: re-save their highlights with the coding app.` : ""),
      noNotes.length > 0);
  } catch (e) {
    setStatus(e.message, true);
  }
}

function applySnapshot(snap) {
  A.data = snap;
  A.participants = new Map(snap.participants.map((p) => [p.id, p]));
  buildIndex();
  const sites = [...new Set(snap.participants.map((p) => p.site))].sort();
  const sel = $("#filter-site");
  const cur = sel.value;
  sel.replaceChildren(el("option", { value: "" }, "All sites"), ...sites.map((s) => el("option", { value: s }, s)));
  sel.value = sites.includes(cur) ? cur : "";
  // The selection survives reloads via the URL hash, e.g. #pd:B:+training.
  const m = decodeURIComponent(location.hash.slice(1)).match(/^(pp|pd):(A|B):(.+)$/);
  if (!(A.sel && A.rowByFc.has(A.sel.fc))) A.sel = m && A.rowByFc.has(m[3]) ? { fc: m[3], k: m[1], g: m[2] } : null;
  if (!A.participants.has(A.pid)) A.pid = null;
  renderAll();
}

/**
 * Rewrite codes for display (the coders' files are not changed): apply CODE_MERGES from
 * app.py (old name -> new name, keeping the modifier), then drop the modifier from pattern
 * codes ("+return-to-pre" -> "return-to-pre"). The original is kept in a.original_code.
 * Returns how many applications changed.
 */
function normalizeCodes(coders, codebook, merges) {
  const concept = new Set(codebook.filter((c) => c.kind !== "pattern").map((c) => c.code));
  const patterns = new Set(codebook.filter((c) => c.kind === "pattern" && !concept.has(c.code)).map((c) => c.code));
  const target = (code) => {
    const seen = new Set();
    while (merges[code] && !seen.has(code)) { seen.add(code); code = merges[code]; }  // follow chains
    return code;
  };
  let changed = 0;
  for (const coder of coders) {
    for (const a of coder.annotations) {
      if (a.code === A.data.proposeCode) continue;
      const code = target(a.code);
      const modifier = patterns.has(code) ? "" : a.modifier;
      if (code === a.code && modifier === a.modifier) continue;
      a.original_code = a.full_code;
      a.code = code;
      a.modifier = modifier;
      a.full_code = modifier + code;
      changed++;
    }
  }
  return changed;
}

/** Code rows in display order, and which participant/transition each coder gave each code. */
function buildIndex() {
  const { codebook, coders, proposeCode, proposeLabel } = A.data;
  A.rows = [];
  A.rowByFc = new Map();
  const addRow = (r) => {
    if (A.rowByFc.has(r.fc)) return;
    A.rows.push(r);
    A.rowByFc.set(r.fc, r);
  };
  for (const c of codebook) {
    for (const m of c.kind === "pattern" ? [""] : ["+", "-", "="]) {
      addRow({ ...c, fc: m + c.code, modifier: m, group: c.theme || "(no theme)" });
    }
  }
  A.recoded = normalizeCodes(coders, codebook, A.data.codeMerges || {});
  A.hits = new Map();
  const extras = [];
  coders.forEach((coder, ci) => {
    for (const a of coder.annotations) {
      if (!A.participants.has(a.participant_id) || !a.transition) continue;
      const fc = a.full_code;
      if (!A.rowByFc.has(fc) && a.code !== proposeCode && !extras.some((r) => r.fc === fc)) {
        extras.push({ fc, code: a.code, modifier: a.modifier, theme: a.theme, kind: a.modifier ? "concept" : "pattern",
          description: a.theme ? `Theme when coded: ${a.theme}` : "", group: "Not in current codebook" });
      }
      const byPid = A.hits.get(fc) || new Map();
      A.hits.set(fc, byPid);
      const h = byPid.get(a.participant_id) || { pp: new Set(), pd: new Set() };
      byPid.set(a.participant_id, h);
      h[tkind(a.transition)].add(ci);
    }
  });
  extras.sort((x, y) => x.code.localeCompare(y.code) || x.fc.localeCompare(y.fc)).forEach(addRow);
  addRow({ fc: proposeLabel, code: proposeCode, modifier: "", theme: "", kind: "proposal",
    description: "Highlights where no existing code fit", group: "Proposed new codes" });
  A.themeColors = buildThemeColors(codebook);
}

// ------------------------------------------------------------ selection & counts

/** Participants passing the site / group / id filters, A before B. */
function filteredParticipants() {
  if (!A.data) return [];
  const site = $("#filter-site").value;
  const groups = [...document.querySelectorAll(".group-filter input:checked")].map((i) => i.value);
  const q = $("#filter-search").value.trim().toLowerCase();
  const rank = (g) => (GROUPS.includes(g) ? GROUPS.indexOf(g) : GROUPS.length);
  return A.data.participants
    .filter((p) => !site || p.site === site)
    .filter((p) => groups.includes(p.group) || !GROUPS.includes(p.group))
    .filter((p) => !q || p.id.toLowerCase().includes(q))
    .sort((x, y) => rank(x.group) - rank(y.group) || x.id.localeCompare(y.id));
}

function hasDelayPost(p) {
  return A.data.questions.some((q) => ((p.responses[q] || {})["3-DelayPost"] || "").trim());
}

/** n per group and transition: everyone for pre->post, only those with a delay-post answer after. */
function groupNs(ps) {
  const n = { A: { pp: 0, pd: 0 }, B: { pp: 0, pd: 0 } };
  for (const p of ps) {
    if (!n[p.group]) continue;
    n[p.group].pp++;
    if (hasDelayPost(p)) n[p.group].pd++;
  }
  return n;
}

/** How many participants in ps were given fc (by at least one coder), per group and transition. */
function codeCounts(fc, ps) {
  const out = { A: { pp: 0, pd: 0 }, B: { pp: 0, pd: 0 } };
  const byPid = A.hits.get(fc);
  if (!byPid) return out;
  for (const p of ps) {
    const h = byPid.get(p.id);
    if (!h || !out[p.group]) continue;
    if (h.pp.size) out[p.group].pp++;
    if (h.pd.size) out[p.group].pd++;
  }
  return out;
}

function hitFor(fc, pid) {
  const byPid = A.hits.get(fc);
  return (byPid && byPid.get(pid)) || null;
}

/** Select a code for one transition and group; selecting the current one again clears it. */
async function selectCode(fc, k, g) {
  await flushSummary();
  A.sel = isSel(fc, k, g) ? null : { fc, k, g };
  history.replaceState(null, "", A.sel ? `#${A.sel.k}:${A.sel.g}:${encodeURIComponent(A.sel.fc)}` : location.pathname);
  $("#a-detail").scrollTop = 0;
  renderAll();
}

function selectParticipant(pid) {
  A.pid = A.pid === pid ? null : pid;
  renderParticipants();
  if (A.sel && A.pid) {
    const card = document.querySelector(`.card[data-pid="${CSS.escape(A.pid)}"]`);
    if (card) {
      card.scrollIntoView({ block: "start", behavior: "smooth" });
      card.classList.add("flash");
      setTimeout(() => card.classList.remove("flash"), 1200);
    } else {
      const p = A.participants.get(pid);
      setStatus(p.group !== A.sel.g ? `${pid} is in group ${p.group || "?"}, not ${A.sel.g}.`
        : `${pid} was not given ${modLabel(A.sel.fc)} in ${TRANS[A.sel.k]}.`);
    }
  } else {
    renderDetail();
  }
}

// ------------------------------------------------------------ rendering

function renderAll() {
  renderParticipants();
  renderCodeTable();
  renderDetail();
  renderSummary();
}

function renderParticipants() {
  const box = $("#participant-list");
  if (!A.data) return;
  const ps = filteredParticipants();
  const sections = [];
  for (const g of [...GROUPS, null]) {
    const inGroup = ps.filter((p) => (g ? p.group === g : !GROUPS.includes(p.group)));
    if (!inGroup.length) continue;
    sections.push(el("div", { class: "group-head" }, g ? `Group ${g}` : "Other", el("span", { class: "count" }, ` ${inGroup.length}`)));
    sections.push(el("ul", { class: "plist" }, ...inGroup.map((p) => {
      const h = A.sel ? hitFor(A.sel.fc, p.id) : null;
      const badges = A.sel ? ["pp", "pd"].map((k) => {
        const n = h ? h[k].size : 0;
        const coders = h ? [...h[k]].map((ci) => A.data.coders[ci].name).join(", ") : "";
        return el("span", {
          class: "badge" + (n ? " done" : " off") + (k === A.sel.k ? " current" : ""),
          title: n ? `${TRANS[k]}: ${coders}` : `${TRANS[k]}: not coded`,
        }, k === "pp" ? "P" : "D");
      }) : [];
      return el("li", {
        class: (p.id === A.pid ? "selected" : "") +
          (A.sel && !(p.group === A.sel.g && h && h[A.sel.k].size) ? " dim" : ""),
        onclick: () => selectParticipant(p.id),
      }, el("span", { class: "pid" }, p.id), el("span", { class: "badges" }, ...badges));
    })));
  }
  box.replaceChildren(...(sections.length ? sections : [el("p", { class: "empty" }, "No participants match.")]));
}

function renderCodeTable() {
  const box = $("#code-table");
  if (!A.data) return;
  const ps = filteredParticipants();
  const n = groupNs(ps);
  const hideUnused = $("#hide-unused").checked;
  const q = $("#code-search").value.trim().toLowerCase();

  const head = el("thead", {},
    el("tr", {}, el("th", { rowspan: 2, class: "code-col" }, ""),
      el("th", { colspan: 2, class: "trans-head" }, "Pre→Post"),
      el("th", { colspan: 2, class: "trans-head" }, "→Delay")),
    el("tr", {}, ...["A", "B", "A", "B"].map((g) => el("th", { class: "num" }, g))),
    el("tr", { class: "n-row" }, el("td", { class: "code-col" }, ""),
      ...CELLS.map(([g, k]) => el("td", { class: "num" }, String(n[g][k])))));

  const body = el("tbody");
  let lastGroup = null, shown = 0;
  for (const r of A.rows) {
    const summarized = CELLS.filter(([g, k]) => summaryText(r.fc, k, g));
    if (hideUnused && !A.hits.has(r.fc) && !isSel(r.fc) && !summarized.length) continue;
    if (q && !r.fc.toLowerCase().includes(q) && !(r.description || "").toLowerCase().includes(q)) continue;
    if (r.group !== lastGroup) {
      lastGroup = r.group;
      const color = r.kind === "proposal" ? PROPOSAL_COLOR : r.group === "Not in current codebook" ? ["#999", "#eee"]
        : (A.themeColors.get(r.theme) || PATTERN_COLOR);
      body.append(el("tr", { class: "theme-row" }, el("td", { colspan: 5 }, themeDot(color), r.group)));
    }
    const c = codeCounts(r.fc, ps);
    // Each number is its own click target: that code for that group and transition.
    const cell = ([g, k]) => {
      const v = c[g][k], d = n[g][k];
      const has = !!summaryText(r.fc, k, g);
      const shown = A.numMode === "pct" ? (d ? String(Math.round((100 * v) / d)) : "–") : String(v);
      return el("td", {
        class: "num cell" + (v ? "" : " zero") + (isSel(r.fc, k, g) ? " sel" : "") + (has ? " has-sum" : ""),
        title: `${modLabel(r.fc)}, ${cellLabel(g, k)}` + (d ? `: ${v}/${d} = ${Math.round((100 * v) / d)}%` : "") +
          (has ? "\n✎ has a summary" : ""),
        onclick: () => selectCode(r.fc, k, g),
      }, shown);
    };
    const color = r.kind === "proposal" ? PROPOSAL_COLOR : (A.themeColors.get(r.theme) || PATTERN_COLOR);
    body.append(el("tr", {
      class: "code-tr" + (isSel(r.fc) ? " selected" : ""),
      dataset: { fc: r.fc },
      style: `--strong:${color[0]};--tint:${color[1] === "transparent" ? "#eee" : color[1]}`,
    },
      el("td", {
        class: "code-col", title: (r.description ? r.description + "\n" : "") + "Click a number to choose the group and transition",
        onclick: () => (isSel(r.fc) ? selectCode(r.fc, A.sel.k, A.sel.g) : selectCode(r.fc, "pp", "A")),
      },
        el("span", { class: "code-label" + (r.kind === "pattern" ? " pattern" : "") }, modLabel(r.fc)),
        summarized.length ? el("span", {
          class: "has-summary",
          title: "Summaries written: " + summarized.map(([g, k]) => cellLabel(g, k)).join("; "),
        }, `✎${summarized.length}`) : null),
      ...CELLS.map(cell)));
    shown++;
  }
  box.replaceChildren(el("table", { class: "code-table" }, head, body));
  if (!shown) box.append(el("p", { class: "empty" }, "No codes match."));
}

// ------------------------------------------------------------ detail: quotes for one code

function renderDetail() {
  const box = $("#detail");
  if (!A.data) return;
  if (!A.sel) {
    box.replaceChildren(A.pid ? participantView(A.pid)
      : el("p", { class: "empty" }, "Click one of a code's numbers to see every quote and highlight behind it for that group and transition, or a participant to compare the coders."));
    return;
  }
  const { fc, k, g } = A.sel;
  const r = A.rowByFc.get(fc);
  const ps = filteredParticipants();
  const counts = codeCounts(fc, ps), n = groupNs(ps);
  const color = r.kind === "proposal" ? PROPOSAL_COLOR : (A.themeColors.get(r.theme) || PATTERN_COLOR);
  const withCode = ps.filter((p) => { const h = hitFor(fc, p.id); return p.group === g && h && h[k].size; });
  // Jump to the same code in another group/transition, with its count (← → also step through).
  const switcher = el("div", { class: "cell-switch" }, ...CELLS.map(([g2, k2]) => el("button", {
    class: g2 === g && k2 === k ? "active" : "",
    title: cellLabel(g2, k2),
    onclick: () => { if (!isSel(fc, k2, g2)) selectCode(fc, k2, g2); },
  }, `${g2} ${k2 === "pp" ? "Pre→Post" : "→Delay"} `, el("span", { class: "count" }, `${counts[g2][k2]}/${n[g2][k2]}`))));
  const header = el("div", { class: "detail-head" },
    el("div", { class: "detail-title" },
      el("span", { class: "ann-code" + (r.kind === "proposal" ? " proposal-code" : ""), style: `--strong:${color[0]};--tint:${color[1]}` }, modLabel(fc)),
      el("span", { class: "trans-name" }, cellLabel(g, k)),
      el("span", { class: "where" }, r.theme || "")),
    r.description ? el("div", { class: "desc" }, r.description) : null,
    el("div", { class: "detail-controls" }, coderLegend(), switcher));

  const sections = [el("div", { class: "where" }, `${withCode.length} of ${n[g][k]} group ${g} participants in the selection`)];
  if (!withCode.length) sections.push(el("p", { class: "empty" }, "Nobody in the selection has this code here."));
  sections.push(...withCode.map((p) => codeCard(p, k)));
  box.replaceChildren(header, ...sections);
}

function coderLegend() {
  return el("div", { class: "coder-legend" }, ...A.data.coders.map((c, i) =>
    el("span", { class: "coder-chip", style: `--strong:${coderColor(i)[0]};--tint:${coderColor(i)[1]}`,
      title: `${c.path}\nnotes: ${c.notes_source || "not found"}` }, c.name)));
}

function coderChip(ci) {
  const [strong, tint] = coderColor(ci);
  return el("span", { class: "coder-chip small", style: `--strong:${strong};--tint:${tint}` }, A.data.coders[ci].name);
}

/** The selected code's applications for one participant and transition kind, with their coder. */
function applications(pid, k, fc = A.sel.fc) {
  const out = [];
  A.data.coders.forEach((coder, ci) => {
    for (const a of coder.annotations) {
      if (a.participant_id === pid && a.full_code === fc && a.transition && tkind(a.transition) === k) out.push({ ci, a });
    }
  });
  return out;
}

/** One participant's evidence for the selected code in one transition: answers + each coder's note. */
function codeCard(p, k) {
  const apps = applications(p.id, k);
  const coderIdx = [...new Set(apps.map((x) => x.ci))].sort();
  const nCoders = A.data.coders.length;
  const card = el("div", { class: "card" + (p.id === A.pid ? " current" : ""), dataset: { pid: p.id } },
    el("div", { class: "card-head" },
      el("strong", {}, p.id), el("span", { class: "where" }, ` ${p.site}`),
      el("span", { class: "card-coders" },
        el("span", { class: "where", title: "Coders who gave this code" }, `${coderIdx.length}/${nCoders} `),
        ...coderIdx.map(coderChip))));

  for (const q of A.data.questions) {
    const tr = `${q}_${k}`;
    const here = apps.filter((x) => x.a.transition === tr);
    if (!here.length) continue;
    const times = TRANS_TIMES[k].filter((t) => (p.responses[q] || {})[t]);
    card.append(el("div", { class: "card-q" }, q));
    card.append(el("div", { class: "answers", style: `grid-template-columns:repeat(${times.length || 1}, 1fr)` },
      ...times.map((t) => {
        const field = `${q}|${t}`;
        const spans = here.filter((x) => x.a.source === "response" && x.a.field === field);
        return el("div", { class: "answer" },
          el("div", { class: "time" }, TIME_LABELS[t] || t),
          markedText(p.responses[q][t], spans));
      })));
    card.append(notesBlock(p.id, tr, here));
  }
  return card;
}

/** Each coder's note for this transition; the ones who applied the code first, highlighted. */
function notesBlock(pid, tr, here) {
  const coded = [...new Set(here.map((x) => x.ci))].sort();
  const others = A.data.coders.map((_, i) => i).filter((i) => !coded.includes(i));
  const noteFor = (ci) => ((A.data.coders[ci].notes[pid] || {})[tr] || "");
  const excerpts = (xs) => xs.map((x) => el("div", { class: "excerpt" }, `“${x.a.text}”`));
  const row = (ci) => {
    const mine = here.filter((x) => x.ci === ci);
    // A highlight belongs to the note it was made in (its field), which can differ from the
    // transition it counts for if the coder moved the code to another transition.
    const onThisNote = mine.filter((x) => x.a.source === "note" && x.a.field === tr);
    const onOtherNote = mine.filter((x) => x.a.source === "note" && x.a.field !== tr);
    const text = noteFor(ci);
    const comments = mine.map((x) => x.a.comment).filter(Boolean);
    let body;
    if (text) body = markedText(text, onThisNote);
    else if (onThisNote.length) body = el("div", { class: "text" }, ...excerpts(onThisNote));
    else body = el("div", { class: "text empty" }, A.data.coders[ci].notes_source ? "(no note)"
      : "(this highlights file has no notes; re-save it with the coding app)");
    const moved = onOtherNote.length ? el("div", { class: "moved" },
      el("span", { class: "where" }, `Highlighted in ${[...new Set(onOtherNote.map((x) => A.data.noteColumns[x.a.field] || x.a.field))].join(", ")}:`),
      ...excerpts(onOtherNote)) : null;
    return el("div", { class: "coder-note" }, coderChip(ci), body, moved,
      comments.length ? el("div", { class: "comment" }, comments.join(" · ")) : null);
  };
  const block = el("div", { class: "notes" }, ...coded.map(row));
  const otherWithNotes = others.filter((ci) => noteFor(ci).trim());
  if (otherWithNotes.length) {
    block.append(el("details", { class: "other-notes" },
      el("summary", {}, `Notes from coders who didn't apply it (${otherWithNotes.length})`),
      ...otherWithNotes.map(row)));
  }
  return block;
}

/** Text with each coder's highlights tinted in that coder's colour (stripes where they overlap). */
function markedText(text, apps) {
  const box = el("div", { class: "text" });
  const spans = [];
  for (const x of apps) {
    const r = resolveAnchor(text, x.a);
    if (r) spans.push({ s: r[0], e: r[1], ...x });
  }
  const cuts = [...new Set([0, text.length, ...spans.flatMap((x) => [x.s, x.e])])].sort((a, b) => a - b);
  for (let i = 0; i < cuts.length - 1; i++) {
    const [b0, b1] = [cuts[i], cuts[i + 1]];
    const piece = text.slice(b0, b1);
    const cover = spans.filter((x) => x.s <= b0 && x.e >= b1);
    if (!cover.length) { box.append(document.createTextNode(piece)); continue; }
    const cis = [...new Set(cover.map((x) => x.ci))].sort();
    const tints = cis.map((ci) => coderColor(ci)[1]);
    const bg = tints.length === 1 ? tints[0]
      : `repeating-linear-gradient(135deg, ${tints.map((t, j) => `${t} ${j * 6}px ${(j + 1) * 6}px`).join(", ")})`;
    box.append(el("span", {
      class: "hl" + (cis.length > 1 ? " multi" : ""),
      style: `background:${bg};border-bottom:2px solid ${coderColor(cis[0])[0]}`,
      title: [...new Set(cover.map((x) => `${A.data.coders[x.ci].name}: ${modLabel(x.a.full_code)}` +
        (x.a.original_code ? ` (coded as ${modLabel(x.a.original_code)})` : "") +
        (x.a.comment ? ` (${x.a.comment})` : "")))].join("\n"),
    }, piece));
  }
  const missing = apps.length - spans.length;
  if (missing > 0) box.append(el("div", { class: "where" }, `${missing} highlight(s) no longer found in this text`));
  return box;
}

/** A clickable chip for a code (opens it for that transition and the participant's group). */
function codeButton(fc, k, group) {
  const g = GROUPS.includes(group) ? group : GROUPS[0];
  const r = A.rowByFc.get(fc) || {};
  const color = r.kind === "proposal" ? PROPOSAL_COLOR : (A.themeColors.get(r.theme) || PATTERN_COLOR);
  return el("button", {
    class: "code-chip", style: `--strong:${color[0]};--tint:${color[1]}`,
    title: (r.description ? r.description + "\n" : "") + `Open ${modLabel(fc)}, ${cellLabel(g, k)}`,
    onclick: () => selectCode(fc, k, g),
  }, modLabel(fc));
}

/**
 * No code selected: compare the coders for one participant. A table of the codes each coder
 * gave in each transition, then per question the original answers (with every coder's
 * highlights) and, per transition, each coder's note with their highlights and codes.
 */
function participantView(pid) {
  const p = A.participants.get(pid);
  const coders = A.data.coders;
  const mine = coders.map((c) => c.annotations.filter((a) => a.participant_id === pid));
  const codesIn = (ci, tr) => [...new Set(mine[ci].filter((a) => a.transition === tr).map((a) => a.full_code))];

  const table = el("table", { class: "pcodes" },
    el("tr", {}, el("th", {}, ""), ...coders.map((_, ci) => el("th", {}, coderChip(ci)))),
    ...NOTE_ORDER.map((tr) => el("tr", {},
      el("th", {}, A.data.noteColumns[tr]),
      ...coders.map((_, ci) => el("td", {}, ...codesIn(ci, tr).map((fc) => codeButton(fc, tkind(tr), p.group)))))));

  const sections = A.data.questions.map((q) => {
    const times = A.data.times.filter((t) => (p.responses[q] || {})[t]);
    const answers = el("div", { class: "answers", style: `grid-template-columns:repeat(${times.length || 1}, 1fr)` },
      ...times.map((t) => {
        const field = `${q}|${t}`;
        const apps = [];
        mine.forEach((anns, ci) => anns.forEach((a) => {
          if (a.source === "response" && a.field === field) apps.push({ ci, a });
        }));
        return el("div", { class: "answer" }, el("div", { class: "time" }, TIME_LABELS[t] || t),
          markedText(p.responses[q][t], apps));
      }));
    const notes = ["pp", "pd"].map((k) => {
      const tr = `${q}_${k}`;
      const rows = coders.map((c, ci) => {
        const text = (c.notes[pid] || {})[tr] || "";
        const onNote = mine[ci].filter((a) => a.source === "note" && a.field === tr).map((a) => ({ ci, a }));
        const fcs = codesIn(ci, tr);
        if (!text && !fcs.length) return null;
        const body = text ? markedText(text, onNote)
          : el("div", { class: "text empty" }, c.notes_source ? "(no note)" : "(this highlights file has no notes)");
        return el("div", { class: "coder-note" }, coderChip(ci),
          el("div", {}, body, fcs.length ? el("div", { class: "note-codes" }, ...fcs.map((fc) => codeButton(fc, k, p.group))) : null));
      }).filter(Boolean);
      if (!rows.length) return null;
      return el("div", { class: "pv-trans" }, el("div", { class: "time" }, A.data.noteColumns[tr]), ...rows);
    }).filter(Boolean);
    return el("div", { class: "card" }, el("div", { class: "card-q" }, q), answers, ...notes);
  });

  return el("div", {},
    el("div", { class: "detail-head" },
      el("div", { class: "detail-title" }, el("strong", {}, p.id), el("span", { class: "where" }, ` ${p.site}, group ${p.group || "?"}`)),
      el("div", { class: "detail-controls" }, coderLegend())),
    el("p", { class: "where" }, "Codes given by each coder. Click a code to see all its quotes."),
    table, ...sections);
}

// ------------------------------------------------------------ summary

// The summary being edited: which code, transition and group it belongs to.
const summaryEdit = { fc: null, k: null, g: null, theme: "", textarea: null, stamp: null, timer: null };

function renderSummary() {
  const box = $("#summary");
  if (!A.data) { box.replaceChildren(); return; }
  if (!A.sel) {
    summaryEdit.fc = summaryEdit.textarea = null;
    box.replaceChildren(el("h2", {}, "Code summary"),
      el("p", { class: "empty" }, "Select one of a code's numbers to write its summary for that group and transition."));
    return;
  }
  const { fc, k, g } = A.sel;
  const saved = summaryOf(fc, k, g);
  const ta = el("textarea", {
    id: "summary-text",
    placeholder: `What does ${modLabel(fc)} look like for group ${g} in ${TRANS[k]}?`,
  });
  ta.value = saved.summary || "";
  const stamp = el("div", { class: "where", id: "summary-stamp" }, saved.updated_at ? `Saved ${saved.updated_at.replace("T", " ")}` : "");
  ta.addEventListener("input", () => {
    clearTimeout(summaryEdit.timer);
    summaryEdit.timer = setTimeout(flushSummary, 800);
    stamp.textContent = "Editing…";
  });
  ta.addEventListener("blur", flushSummary);
  Object.assign(summaryEdit, { fc, k, g, theme: A.rowByFc.get(fc).theme || "", textarea: ta, stamp });
  // The other group's summary for the same code and transition, to compare against.
  const og = GROUPS.find((x) => x !== g);
  const otherText = summaryText(fc, k, og);
  box.replaceChildren(
    el("h2", {}, "Code summary: ", el("span", { class: "code-label" }, modLabel(fc))),
    el("div", { class: "trans-name" }, cellLabel(g, k)),
    countsLine(), ta, stamp);
  if (otherText) {
    box.append(el("details", { class: "other-summary" },
      el("summary", {}, `Group ${og} summary (same transition)`),
      el("div", { class: "text" }, otherText),
      el("button", { class: "switch-trans", onclick: () => selectCode(fc, k, og) }, `Edit group ${og}`)));
  }
}

/** Counts for the selected code, transition and group in words, to copy into the summary. */
function countsLine() {
  const { fc, k, g } = A.sel;
  const ps = filteredParticipants();
  const n = groupNs(ps)[g][k], c = codeCounts(fc, ps)[g][k];
  return el("div", { class: "counts-line" }, `${c}/${n} group ${g} participants` + (n ? ` (${Math.round((100 * c) / n)}%)` : ""));
}

async function flushSummary() {
  clearTimeout(summaryEdit.timer);
  summaryEdit.timer = null;
  const { fc, k, g, theme, textarea } = summaryEdit;
  if (!fc || !textarea) return;
  const value = textarea.value;
  if (summaryText(fc, k, g) === value) return;
  try {
    const saved = await api("POST", "/api/analysis/summary", { code: fc, transition: k, group: g, theme, summary: value });
    A.data.summaries[fc] = saved;
    if (isSel(fc, k, g)) summaryEdit.stamp.textContent = `Saved ${saved[k][g].updated_at.replace("T", " ")}`;
    renderCodeTable();
  } catch (e) {
    setStatus("Failed to save summary: " + e.message, true);
  }
}

// ------------------------------------------------------------ events

/** When not typing: ↑/↓ (or k/j) move between visible codes, ←/→ move between the four numbers. */
function onKey(ev) {
  if (!A.data || ev.target.closest("input, textarea, select")) return;
  const [g, k] = A.sel ? [A.sel.g, A.sel.k] : CELLS[0];
  if ((ev.key === "ArrowLeft" || ev.key === "ArrowRight") && A.sel) {
    ev.preventDefault();
    const i = CELLS.findIndex(([g2, k2]) => g2 === g && k2 === k);
    const [ng, nk] = CELLS[Math.max(0, Math.min(CELLS.length - 1, i + (ev.key === "ArrowLeft" ? -1 : 1)))];
    if (!isSel(A.sel.fc, nk, ng)) selectCode(A.sel.fc, nk, ng);
    return;
  }
  const dir = { ArrowDown: 1, j: 1, ArrowUp: -1, k: -1 }[ev.key];
  if (!dir) return;
  const fcs = [...document.querySelectorAll(".code-tr")].map((r) => r.dataset.fc);
  if (!fcs.length) return;
  ev.preventDefault();
  const i = A.sel ? fcs.indexOf(A.sel.fc) : -1;
  const next = fcs[Math.max(0, Math.min(fcs.length - 1, i === -1 ? 0 : i + dir))];
  if (!isSel(next, k, g)) selectCode(next, k, g);
  requestAnimationFrame(() => document.querySelector(`.code-tr[data-fc="${CSS.escape(next)}"]`)?.scrollIntoView({ block: "nearest" }));
}

function bindEvents() {
  const f = $("#load-form").elements;
  addBrowseButton(f.data, "the participant data CSV");
  addBrowseButton(f.codebook, "the codebook CSV");
  addBrowseButton(f.summary, "the code summary JSON", true);
  $("#add-coder").addEventListener("click", () => addCoderField().focus());
  $("#load-form").addEventListener("submit", onLoad);
  const onFilter = () => { renderParticipants(); renderCodeTable(); renderDetail(); if (A.sel) $("#summary .counts-line")?.replaceWith(countsLine()); };
  $("#filter-site").addEventListener("change", onFilter);
  $("#filter-search").addEventListener("input", onFilter);
  document.querySelectorAll(".group-filter input").forEach((i) => i.addEventListener("change", onFilter));
  $("#hide-unused").addEventListener("change", renderCodeTable);
  const showNumMode = () => document.querySelectorAll("#num-mode button").forEach((b) =>
    b.classList.toggle("active", b.dataset.mode === A.numMode));
  document.querySelectorAll("#num-mode button").forEach((b) => b.addEventListener("click", () => {
    A.numMode = b.dataset.mode;
    localStorage.setItem("prf-num-mode", A.numMode);
    showNumMode();
    renderCodeTable();
  }));
  showNumMode();
  $("#code-search").addEventListener("input", renderCodeTable);
  document.addEventListener("keydown", onKey);
  // An async fetch may not finish while the page unloads; a beacon does.
  window.addEventListener("beforeunload", () => {
    const { fc, k, g, textarea, theme } = summaryEdit;
    if (!fc || !textarea || summaryText(fc, k, g) === textarea.value) return;
    navigator.sendBeacon("/api/analysis/summary", new Blob(
      [JSON.stringify({ code: fc, transition: k, group: g, theme, summary: textarea.value })], { type: "application/json" }));
  });
}

init().catch((e) => setStatus(e.message, true));
