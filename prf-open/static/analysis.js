"use strict";
// Analysis page (spec.txt, ANALYSIS MODE): merge several coders' highlights, count each code
// per group and transition within the filtered participants, show the quotes behind a code,
// and write one summary per code to code_summary.json.

const A = {
  data: null,        // snapshot from /api/analysis/state
  code: null,        // selected full code, e.g. "+training"
  pid: null,         // selected participant
  trans: "all",      // detail filter: "all" | "pp" | "pd"
  rows: [],          // [{fc, code, modifier, theme, kind, description, group}] in display order
  rowByFc: new Map(),
  hits: new Map(),   // fc -> pid -> {pp: Set(coderIdx), pd: Set(coderIdx)}
};

const TRANS = { pp: "Pre → Post", pd: "Pre/Post → Delay-post" };
const TRANS_TIMES = { pp: ["1-Pre", "2-Post"], pd: ["1-Pre", "2-Post", "3-DelayPost"] };
const GROUPS = ["A", "B"];

// One colour per coder: [strong, tint]. Highlights in the detail view show a single code,
// so colour only ever means "which coder".
const CODER_PALETTE = [
  ["#1f6fb2", "#cfe2f3"], ["#c45f00", "#fde0c2"], ["#2e8b57", "#cdeccf"],
  ["#7b4fb3", "#e2d5f3"], ["#b8396f", "#f8d3e3"], ["#11807f", "#c6ecec"],
];
const coderColor = (i) => CODER_PALETTE[i % CODER_PALETTE.length];

const tkind = (transition) => (transition.endsWith("_pd") ? "pd" : "pp");
const modLabel = (fc) => fc.replace(/^-/, "−");

// ------------------------------------------------------------ loading

async function init() {
  bindEvents();
  const snap = await api("GET", "/api/analysis/state");
  if (snap.coders.length) {
    fillForm(snap.paths);
    applySnapshot(snap);
  } else {
    fillForm(await api("GET", "/api/analysis/last-session"));
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
  await flushSummary();
  const f = ev.target.elements;
  try {
    const snap = await api("POST", "/api/analysis/load", {
      data: f.data.value, codebook: f.codebook.value, summary: f.summary.value,
      highlights: [...document.querySelectorAll(".coder-input")].map((i) => i.value),
    });
    applySnapshot(snap);
    const nAnn = snap.coders.reduce((s, c) => s + c.annotations.length, 0);
    const noNotes = snap.coders.filter((c) => !c.notes_source).map((c) => c.name);
    setStatus(`Loaded ${snap.participants.length} participants, ${snap.coders.length} coders, ${nAnn} code applications.` +
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
  const fromHash = decodeURIComponent(location.hash.slice(1));
  if (!A.rowByFc.has(A.code)) A.code = A.rowByFc.has(fromHash) ? fromHash : null;
  if (!A.participants.has(A.pid)) A.pid = null;
  renderAll();
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

async function selectCode(fc) {
  await flushSummary();
  A.code = A.code === fc ? null : fc;
  history.replaceState(null, "", A.code ? `#${encodeURIComponent(A.code)}` : location.pathname);
  $("#a-detail").scrollTop = 0;
  renderAll();
}

function selectParticipant(pid) {
  A.pid = A.pid === pid ? null : pid;
  renderParticipants();
  if (A.code && A.pid) {
    const card = document.querySelector(`.card[data-pid="${CSS.escape(A.pid)}"]`);
    if (card) {
      card.scrollIntoView({ block: "start", behavior: "smooth" });
      card.classList.add("flash");
      setTimeout(() => card.classList.remove("flash"), 1200);
    } else {
      setStatus(`${pid} was not given ${modLabel(A.code)}.`);
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
      const h = A.code ? hitFor(A.code, p.id) : null;
      const badges = A.code ? ["pp", "pd"].map((k) => {
        const n = h ? h[k].size : 0;
        const coders = h ? [...h[k]].map((ci) => A.data.coders[ci].name).join(", ") : "";
        return el("span", {
          class: "badge" + (n ? " done" : " off"),
          title: n ? `${TRANS[k]}: ${coders}` : `${TRANS[k]}: not coded`,
        }, k === "pp" ? "P" : "D");
      }) : [];
      return el("li", {
        class: (p.id === A.pid ? "selected" : "") + (A.code && !h ? " dim" : ""),
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
  const summaries = A.data.summaries;

  const head = el("thead", {},
    el("tr", {}, el("th", { rowspan: 2, class: "code-col" }, ""),
      el("th", { colspan: 2, class: "trans-head" }, "Pre→Post"),
      el("th", { colspan: 2, class: "trans-head" }, "→Delay")),
    el("tr", {}, ...["A", "B", "A", "B"].map((g) => el("th", { class: "num" }, g))),
    el("tr", { class: "n-row" }, el("td", { class: "code-col" }, "n (selected)"),
      ...[["A", "pp"], ["B", "pp"], ["A", "pd"], ["B", "pd"]].map(([g, k]) => el("td", { class: "num" }, String(n[g][k])))));

  const body = el("tbody");
  let lastGroup = null, shown = 0;
  for (const r of A.rows) {
    if (hideUnused && !A.hits.has(r.fc) && r.fc !== A.code && !(summaries[r.fc] || {}).summary) continue;
    if (q && !r.fc.toLowerCase().includes(q) && !(r.description || "").toLowerCase().includes(q)) continue;
    if (r.group !== lastGroup) {
      lastGroup = r.group;
      const color = r.kind === "proposal" ? PROPOSAL_COLOR : r.group === "Not in current codebook" ? ["#999", "#eee"]
        : (A.themeColors.get(r.theme) || PATTERN_COLOR);
      body.append(el("tr", { class: "theme-row" }, el("td", { colspan: 5 }, themeDot(color), r.group)));
    }
    const c = codeCounts(r.fc, ps);
    const cell = (g, k) => {
      const v = c[g][k], d = n[g][k];
      return el("td", { class: "num" + (v ? "" : " zero"), title: d ? `${v}/${d} = ${Math.round((100 * v) / d)}% of group ${g}` : "" }, String(v));
    };
    const color = r.kind === "proposal" ? PROPOSAL_COLOR : (A.themeColors.get(r.theme) || PATTERN_COLOR);
    body.append(el("tr", {
      class: "code-tr" + (r.fc === A.code ? " selected" : ""),
      title: r.description || "",
      style: `--strong:${color[0]};--tint:${color[1] === "transparent" ? "#eee" : color[1]}`,
      onclick: () => selectCode(r.fc),
    },
      el("td", { class: "code-col" },
        el("span", { class: "code-label" + (r.kind === "pattern" ? " pattern" : "") }, modLabel(r.fc)),
        (summaries[r.fc] || {}).summary ? el("span", { class: "has-summary", title: "Has a summary" }, "✎") : null),
      cell("A", "pp"), cell("B", "pp"), cell("A", "pd"), cell("B", "pd")));
    shown++;
  }
  box.replaceChildren(el("table", { class: "code-table" }, head, body));
  if (!shown) box.append(el("p", { class: "empty" }, "No codes match."));
}

// ------------------------------------------------------------ detail: quotes for one code

function renderDetail() {
  const box = $("#detail");
  if (!A.data) return;
  if (!A.code) {
    box.replaceChildren(A.pid ? participantView(A.pid)
      : el("p", { class: "empty" }, "Click a code to see every quote and highlight behind it, or a participant to see all their codes."));
    return;
  }
  const r = A.rowByFc.get(A.code);
  const ps = filteredParticipants();
  const color = r.kind === "proposal" ? PROPOSAL_COLOR : (A.themeColors.get(r.theme) || PATTERN_COLOR);
  const header = el("div", { class: "detail-head" },
    el("div", { class: "detail-title" },
      el("span", { class: "ann-code" + (r.kind === "proposal" ? " proposal-code" : ""), style: `--strong:${color[0]};--tint:${color[1]}` }, modLabel(r.fc)),
      el("span", { class: "where" }, r.theme || "")),
    r.description ? el("div", { class: "desc" }, r.description) : null,
    el("div", { class: "detail-controls" },
      coderLegend(),
      el("div", { class: "mod-filter" }, ...[["all", "Both"], ["pp", TRANS.pp], ["pd", TRANS.pd]].map(([k, label]) =>
        el("button", { class: k === A.trans ? "active" : "", onclick: () => { A.trans = k; renderDetail(); } }, label)))));

  const sections = [];
  for (const k of A.trans === "all" ? ["pp", "pd"] : [A.trans]) {
    const withCode = ps.filter((p) => { const h = hitFor(A.code, p.id); return h && h[k].size; });
    sections.push(el("h3", { class: "trans-title" }, TRANS[k], el("span", { class: "count" }, ` ${withCode.length} participants`)));
    if (!withCode.length) {
      sections.push(el("p", { class: "empty" }, "Nobody in the selection."));
      continue;
    }
    for (const g of [...GROUPS, null]) {
      const inGroup = withCode.filter((p) => (g ? p.group === g : !GROUPS.includes(p.group)));
      if (!inGroup.length) continue;
      sections.push(el("div", { class: "group-head" }, g ? `Group ${g}` : "Other", el("span", { class: "count" }, ` ${inGroup.length}`)));
      sections.push(...inGroup.map((p) => codeCard(p, k)));
    }
  }
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
function applications(pid, k, fc = A.code) {
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
  const row = (ci) => {
    const mine = here.filter((x) => x.ci === ci);
    const onNote = mine.filter((x) => x.a.source === "note");
    const text = noteFor(ci);
    const comments = mine.map((x) => x.a.comment).filter(Boolean);
    let body;
    if (text) body = markedText(text, onNote);
    else if (onNote.length) body = el("div", { class: "text" }, ...onNote.map((x) => el("div", { class: "excerpt" }, `“${x.a.text}”`)));
    else body = el("div", { class: "text empty" }, A.data.coders[ci].notes_source ? "(no note)"
      : "(this highlights file has no notes; re-save it with the coding app)");
    return el("div", { class: "coder-note" }, coderChip(ci), body,
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
      title: cis.map((ci) => A.data.coders[ci].name).join(", "),
    }, piece));
  }
  const missing = apps.length - spans.length;
  if (missing > 0) box.append(el("div", { class: "where" }, `${missing} highlight(s) no longer found in this text`));
  return box;
}

/** No code selected: every code each coder gave this participant, per transition. */
function participantView(pid) {
  const p = A.participants.get(pid);
  const coders = A.data.coders;
  const table = el("table", { class: "pcodes" },
    el("tr", {}, el("th", {}, ""), ...coders.map((_, ci) => el("th", {}, coderChip(ci)))),
    ...NOTE_ORDER.map((tr) => el("tr", {},
      el("th", {}, A.data.noteColumns[tr]),
      ...coders.map((c) => {
        const fcs = [...new Set(c.annotations.filter((a) => a.participant_id === pid && a.transition === tr).map((a) => a.full_code))];
        return el("td", {}, ...fcs.map((fc) => {
          const r = A.rowByFc.get(fc) || {};
          const color = r.kind === "proposal" ? PROPOSAL_COLOR : (A.themeColors.get(r.theme) || PATTERN_COLOR);
          return el("button", {
            class: "code-chip", style: `--strong:${color[0]};--tint:${color[1]}`, title: r.description || "",
            onclick: () => selectCode(fc),
          }, modLabel(fc));
        }));
      }))));
  return el("div", {},
    el("div", { class: "detail-head" }, el("div", { class: "detail-title" }, el("strong", {}, p.id),
      el("span", { class: "where" }, ` ${p.site}, group ${p.group || "?"}`))),
    el("p", { class: "where" }, "Codes given by each coder. Click one to see its quotes."),
    table);
}

// ------------------------------------------------------------ summary

const summaryEdit = { fc: null, textarea: null, timer: null };

function renderSummary() {
  const box = $("#summary");
  if (!A.data) { box.replaceChildren(); return; }
  const written = A.rows.filter((r) => (A.data.summaries[r.fc] || {}).summary);
  const list = el("details", { class: "summary-list", ...(A.code ? {} : { open: "" }) },
    el("summary", {}, `Summaries written (${written.length})`),
    el("ul", {}, ...written.map((r) => el("li", { class: r.fc === A.code ? "current" : "", onclick: () => selectCode(r.fc) },
      el("strong", {}, modLabel(r.fc)), " ",
      el("span", { class: "snippet" }, A.data.summaries[r.fc].summary)))));
  if (!A.code) {
    summaryEdit.fc = summaryEdit.textarea = null;
    box.replaceChildren(el("h2", {}, "Code summary"), el("p", { class: "empty" }, "Select a code to write its summary."), list);
    return;
  }
  const r = A.rowByFc.get(A.code);
  const saved = A.data.summaries[A.code] || {};
  const ta = el("textarea", { id: "summary-text", placeholder: `What does ${modLabel(A.code)} look like in the data? How do A and B differ?` });
  ta.value = saved.summary || "";
  const stamp = el("div", { class: "where", id: "summary-stamp" }, saved.updated_at ? `Saved ${saved.updated_at.replace("T", " ")}` : "");
  ta.addEventListener("input", () => {
    clearTimeout(summaryEdit.timer);
    summaryEdit.timer = setTimeout(flushSummary, 800);
    stamp.textContent = "Editing…";
  });
  ta.addEventListener("blur", flushSummary);
  summaryEdit.fc = A.code;
  summaryEdit.theme = r.theme || "";
  summaryEdit.textarea = ta;
  summaryEdit.stamp = stamp;
  box.replaceChildren(el("h2", {}, "Code summary: ", el("span", { class: "code-label" }, modLabel(A.code))),
    countsLine(), ta, stamp, list);
}

/** Counts for the selected code in words, so they can be copied into the summary. */
function countsLine() {
  const ps = filteredParticipants();
  const n = groupNs(ps), c = codeCounts(A.code, ps);
  const part = (k) => `${TRANS[k]}: A ${c.A[k]}/${n.A[k]}, B ${c.B[k]}/${n.B[k]}`;
  return el("div", { class: "counts-line" }, part("pp"), el("br"), part("pd"));
}

async function flushSummary() {
  clearTimeout(summaryEdit.timer);
  summaryEdit.timer = null;
  const { fc, textarea } = summaryEdit;
  if (!fc || !textarea) return;
  const value = textarea.value;
  if (((A.data.summaries[fc] || {}).summary || "") === value) return;
  try {
    const saved = await api("POST", "/api/analysis/summary", { code: fc, theme: summaryEdit.theme, summary: value });
    A.data.summaries[fc] = saved;
    if (summaryEdit.fc === fc) summaryEdit.stamp.textContent = `Saved ${saved.updated_at.replace("T", " ")}`;
    renderCodeTable();
  } catch (e) {
    setStatus("Failed to save summary: " + e.message, true);
  }
}

// ------------------------------------------------------------ events

/** ↑/↓ (or k/j) step through the visible codes when not typing. */
function onKey(ev) {
  if (!A.data || ev.target.closest("input, textarea, select")) return;
  const dir = { ArrowDown: 1, j: 1, ArrowUp: -1, k: -1 }[ev.key];
  if (!dir) return;
  const rows = [...document.querySelectorAll(".code-tr")];
  if (!rows.length) return;
  ev.preventDefault();
  const i = rows.findIndex((r) => r.classList.contains("selected"));
  const next = rows[Math.max(0, Math.min(rows.length - 1, i === -1 ? 0 : i + dir))];
  next.click();
  next.scrollIntoView({ block: "nearest" });
}

function bindEvents() {
  const f = $("#load-form").elements;
  addBrowseButton(f.data, "the participant data CSV");
  addBrowseButton(f.codebook, "the codebook CSV");
  addBrowseButton(f.summary, "the code summary JSON", true);
  $("#add-coder").addEventListener("click", () => addCoderField().focus());
  $("#load-form").addEventListener("submit", onLoad);
  const onFilter = () => { renderParticipants(); renderCodeTable(); renderDetail(); if (A.code) $("#summary .counts-line")?.replaceWith(countsLine()); };
  $("#filter-site").addEventListener("change", onFilter);
  $("#filter-search").addEventListener("input", onFilter);
  document.querySelectorAll(".group-filter input").forEach((i) => i.addEventListener("change", onFilter));
  $("#hide-unused").addEventListener("change", renderCodeTable);
  $("#code-search").addEventListener("input", renderCodeTable);
  document.addEventListener("keydown", onKey);
  // An async fetch may not finish while the page unloads; a beacon does.
  window.addEventListener("beforeunload", () => {
    const { fc, textarea, theme } = summaryEdit;
    if (!fc || !textarea || ((A.data.summaries[fc] || {}).summary || "") === textarea.value) return;
    navigator.sendBeacon("/api/analysis/summary", new Blob(
      [JSON.stringify({ code: fc, theme, summary: textarea.value })], { type: "application/json" }));
  });
}

init().catch((e) => setStatus(e.message, true));
