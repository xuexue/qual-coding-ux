"use strict";
// Helpers shared by the coding page (app.js) and the analysis page (analysis.js).

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

function countBy(items, fn) {
  const out = {};
  for (const x of items) {
    const k = fn(x);
    out[k] = (out[k] || 0) + 1;
  }
  return out;
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

/** Scroll a narrow path input so the file name (the end) is visible; full path on hover. */
function showPathEnd(input) {
  input.title = input.value;
  requestAnimationFrame(() => { input.scrollLeft = input.scrollWidth; });
}

/** Wrap a path input with a 📂 button that opens the native file dialog on the server machine. */
function addBrowseButton(input, label, save = false) {
  const btn = el("button", { type: "button", class: "browse", title: `Browse for ${label}` }, "📂");
  input.addEventListener("blur", () => showPathEnd(input));
  input.addEventListener("input", () => { input.title = input.value; });
  btn.addEventListener("click", async () => {
    btn.disabled = true;
    setStatus("Waiting for the file dialog (it may open behind the browser)…");
    try {
      const r = await api("POST", "/api/browse", {
        mode: save ? "save" : "open", title: `Choose ${label}`, current: input.value,
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
  return wrap;
}
