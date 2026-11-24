"use strict";
// Code logic shared by the analysis page (analysis.js) and the quant page (cooccurrence.js):
// merging the coders' codes, the code rows, and the participant filters.

const GROUPS = ["A", "B"];
const TRANS = { pp: "Pre → Post", pd: "Pre/Post → Delay-post" };

/** "goodatml_pd" -> "pd". */
const tkind = (transition) => (transition.endsWith("_pd") ? "pd" : "pp");
/** "+training" as shown, with a real minus sign. */
const modLabel = (fc) => fc.replace(/^-/, "−");

/**
 * Rewrite codes for display (the coders' files are not changed): apply CODE_MERGES from
 * app.py (old name -> new name, keeping the modifier), then drop the modifier from pattern
 * codes ("+return-to-pre" -> "return-to-pre"). The original is kept in a.original_code.
 * Returns how many applications changed.
 */
function normalizeCodes(coders, codebook, merges, proposeCode) {
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
      if (a.code === proposeCode || a.original_code) continue;  // already normalized
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

/**
 * From an /api/analysis/state snapshot: the code rows in display order (codebook order with
 * +/-/= as separate rows, then codes not in the codebook, then proposals) and which
 * participant/transition each coder gave each code.
 *
 * Returns {rows, rowByFc, hits, themeColors, recoded} where
 *   rows:  [{fc, code, modifier, theme, kind, description, group}]
 *   hits:  fc -> pid -> {pp: Set(coderIdx), pd: Set(coderIdx)}
 */
function buildCodeIndex(data, participants) {
  const { codebook, coders, proposeCode, proposeLabel } = data;
  const recoded = normalizeCodes(coders, codebook, data.codeMerges || {}, proposeCode);
  const rows = [];
  const rowByFc = new Map();
  const addRow = (r) => {
    if (rowByFc.has(r.fc)) return;
    rows.push(r);
    rowByFc.set(r.fc, r);
  };
  for (const c of codebook) {
    for (const m of c.kind === "pattern" ? [""] : ["+", "-", "="]) {
      addRow({ ...c, fc: m + c.code, modifier: m, group: c.theme || "(no theme)" });
    }
  }
  const hits = new Map();
  const extras = [];
  coders.forEach((coder, ci) => {
    for (const a of coder.annotations) {
      if (!participants.has(a.participant_id) || !a.transition) continue;
      const fc = a.full_code;
      if (!rowByFc.has(fc) && a.code !== proposeCode && !extras.some((r) => r.fc === fc)) {
        extras.push({ fc, code: a.code, modifier: a.modifier, theme: a.theme, kind: a.modifier ? "concept" : "pattern",
          description: a.theme ? `Theme when coded: ${a.theme}` : "", group: "Not in current codebook" });
      }
      const byPid = hits.get(fc) || new Map();
      hits.set(fc, byPid);
      const h = byPid.get(a.participant_id) || { pp: new Set(), pd: new Set() };
      byPid.set(a.participant_id, h);
      h[tkind(a.transition)].add(ci);
    }
  });
  extras.sort((x, y) => x.code.localeCompare(y.code) || x.fc.localeCompare(y.fc)).forEach(addRow);
  addRow({ fc: proposeLabel, code: proposeCode, modifier: "", theme: "", kind: "proposal",
    description: "Highlights where no existing code fit", group: "Proposed new codes" });
  return { rows, rowByFc, hits, themeColors: buildThemeColors(codebook), recoded };
}

/** [strong, tint] for a code row. */
function rowColor(r, themeColors) {
  if (r.kind === "proposal") return PROPOSAL_COLOR;
  if (r.group === "Not in current codebook") return ["#999", "#eee"];
  return themeColors.get(r.theme) || PATTERN_COLOR;
}

/** Participants passing the site / group / id filters (#filter-site etc.), A before B. */
function filterParticipants(participants) {
  const site = $("#filter-site").value;
  const groups = [...document.querySelectorAll(".group-filter input:checked")].map((i) => i.value);
  const q = $("#filter-search").value.trim().toLowerCase();
  const rank = (g) => (GROUPS.includes(g) ? GROUPS.indexOf(g) : GROUPS.length);
  return participants
    .filter((p) => !site || p.site === site)
    .filter((p) => groups.includes(p.group) || !GROUPS.includes(p.group))
    .filter((p) => !q || p.id.toLowerCase().includes(q))
    .sort((x, y) => rank(x.group) - rank(y.group) || x.id.localeCompare(y.id));
}

/** Fill the site filter with the sites present, keeping the current choice if still valid. */
function fillSiteFilter(participants) {
  const sites = [...new Set(participants.map((p) => p.site))].sort();
  const sel = $("#filter-site");
  const cur = sel.value;
  sel.replaceChildren(el("option", { value: "" }, "All sites"), ...sites.map((s) => el("option", { value: s }, s)));
  sel.value = sites.includes(cur) ? cur : "";
}

/** Whether a participant answered at delay-post (counts toward the ->delay-post n). */
function hasDelayPost(p, questions) {
  return questions.some((q) => ((p.responses[q] || {})["3-DelayPost"] || "").trim());
}

// ------------------------------------------------------------ files form (_files_form.html)

// One colour per coder: [strong, tint].
const CODER_PALETTE = [
  ["#1f6fb2", "#cfe2f3"], ["#c45f00", "#fde0c2"], ["#2e8b57", "#cdeccf"],
  ["#7b4fb3", "#e2d5f3"], ["#b8396f", "#f8d3e3"], ["#11807f", "#c6ecec"],
];
const coderColor = (i) => CODER_PALETTE[i % CODER_PALETTE.length];

/** Browse buttons, "+ coder", and Load (which calls onLoad). */
function setupFilesForm(onLoad) {
  const f = $("#load-form").elements;
  addBrowseButton(f.data, "the participant data CSV");
  addBrowseButton(f.codebook, "the codebook CSV");
  addBrowseButton(f.summary, "the code summary JSON", true);
  $("#add-coder").addEventListener("click", () => addCoderField().focus());
  $("#load-form").addEventListener("submit", (ev) => { ev.preventDefault(); onLoad(); });
}

function fillFilesForm(paths) {
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

/** Load the files in the form on the server; returns the new snapshot (throws on error). */
function loadFilesFromForm() {
  const f = $("#load-form").elements;
  return api("POST", "/api/analysis/load", {
    data: f.data.value, codebook: f.codebook.value, summary: f.summary.value,
    highlights: [...document.querySelectorAll(".coder-input")].map((i) => i.value),
  });
}

/** Status line after loading: [message, isWarning]. */
function loadedMessage(snap, recoded) {
  const nAnn = snap.coders.reduce((s, c) => s + c.annotations.length, 0);
  const noNotes = snap.coders.filter((c) => !c.notes_source).map((c) => c.name);
  return [`Loaded ${snap.participants.length} participants, ${snap.coders.length} coders, ${nAnn} code applications.` +
    (recoded ? ` ${recoded} merged or pattern code(s) shown under their new name.` : "") +
    (noNotes.length ? ` No notes found for ${noNotes.join(", ")}: re-save their highlights with the coding app.` : ""),
    noNotes.length > 0];
}

/**
 * On page open: what the server already has loaded, else fill the form with the last-used
 * (or default) files and load them. Returns {snap, fresh} (fresh: just loaded the files), or
 * null if loading failed (the error is in the status line).
 */
async function openingSnapshot() {
  const snap = await api("GET", "/api/analysis/state");
  if (snap.coders.length) {
    fillFilesForm(snap.paths);
    return { snap, fresh: false };
  }
  fillFilesForm(await api("GET", "/api/analysis/last-session"));
  setStatus("Loading files…");
  try {
    return { snap: await loadFilesFromForm(), fresh: true };
  } catch (e) {
    setStatus(e.message, true);
    return null;
  }
}
