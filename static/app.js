const CODES = ['Model Session', 'Apply Session', 'Both', 'Neither', "Empty/ I don't know answer"];
const CODE_COLORS = ['#ffd166', '#06d6a0', '#6fa8dc', '#ef8da6', '#c9b8f0'];

function codeColor(code) {
  const i = CODES.indexOf(code);
  return i >= 0 ? CODE_COLORS[i] : '';
}

let rows = [];
let currentIndex = 0;
let pendingSelection = null; // {start, end} in the current row's text

const rowListEl = document.getElementById('row-list');
const rowMetaEl = document.getElementById('row-meta');
const coverageBannerEl = document.getElementById('coverage-banner');
const textDisplayEl = document.getElementById('text-display');
const commentBoxEl = document.getElementById('comment-box');
const saveBtnEl = document.getElementById('save-btn');
const saveStatusEl = document.getElementById('save-status');

function gapSegments(text, start, end) {
  const sub = text.slice(start, end);
  const segs = [];
  const re = /\s+|\S+/g;
  let m;
  while ((m = re.exec(sub))) {
    const segStart = start + m.index;
    const segEnd = segStart + m[0].length;
    const isWs = /^\s+$/.test(m[0]);
    segs.push({ start: segStart, end: segEnd, type: isWs ? 'whitespace' : 'uncovered' });
  }
  return segs;
}

function mergeAdjacentSegments(segments) {
  const result = [];
  let i = 0;
  while (i < segments.length) {
    const seg = segments[i];
    if (seg.type !== 'code') { result.push(seg); i++; continue; }
    let end = seg.end;
    let j = i + 1;
    while (j < segments.length) {
      // Skip over whitespace, but only if what follows is the same code
      let k = j;
      while (k < segments.length && segments[k].type === 'whitespace') k++;
      if (k < segments.length && segments[k].type === 'code' && segments[k].code === seg.code) {
        end = segments[k].end;
        j = k + 1;
      } else {
        break;
      }
    }
    result.push({ start: seg.start, end, type: 'code', code: seg.code });
    i = j;
  }
  return result;
}

function getSegments(text, spans) {
  const sorted = spans.slice().sort((a, b) => a.start - b.start);
  const segments = [];
  let pos = 0;
  for (const sp of sorted) {
    if (sp.start > pos) segments.push(...gapSegments(text, pos, sp.start));
    segments.push({ start: sp.start, end: sp.end, type: 'code', code: sp.code });
    pos = Math.max(pos, sp.end);
  }
  if (pos < text.length) segments.push(...gapSegments(text, pos, text.length));
  return mergeAdjacentSegments(segments);
}

function uncoveredCount(row) {
  return getSegments(row.text, row.spans)
    .filter((s) => s.type === 'uncovered')
    .reduce((sum, s) => sum + (s.end - s.start), 0);
}

function renderRowList() {
  rowListEl.innerHTML = '';
  rows.forEach((row, idx) => {
    const item = document.createElement('div');
    item.className = 'row-item' + (idx === currentIndex ? ' active' : '');
    const label = document.createElement('span');
    label.textContent = `${row.id} · ${row.setting} · ${row.time}`;
    const icon = document.createElement('span');
    const complete = uncoveredCount(row) === 0;
    icon.className = 'icon ' + (complete ? 'complete' : 'incomplete');
    icon.textContent = complete ? '✓' : '⚠';
    item.appendChild(label);
    item.appendChild(icon);
    item.addEventListener('click', () => selectRow(idx));
    rowListEl.appendChild(item);
  });
}

function renderText(row) {
  textDisplayEl.innerHTML = '';
  if (!row.text) return;
  const segments = getSegments(row.text, row.spans);
  for (const seg of segments) {
    const span = document.createElement('span');
    span.dataset.start = seg.start;
    span.dataset.end = seg.end;
    span.textContent = row.text.slice(seg.start, seg.end);
    if (seg.type === 'code') {
      span.className = 'code-seg';
      span.style.background = codeColor(seg.code);
    } else if (seg.type === 'uncovered') {
      span.className = 'uncovered-seg';
    }
    textDisplayEl.appendChild(span);
  }
}

function renderEditor() {
  const row = rows[currentIndex];
  rowMetaEl.textContent = `Row ${currentIndex + 1} of ${rows.length} — ID ${row.id} · ${row.setting} · ${row.time}`;
  renderText(row);
  const missing = uncoveredCount(row);
  if (missing > 0) {
    coverageBannerEl.textContent = `${missing} character${missing === 1 ? '' : 's'} not yet coded.`;
    coverageBannerEl.classList.add('visible');
  } else {
    coverageBannerEl.classList.remove('visible');
  }
  commentBoxEl.value = row.comment || '';
  pendingSelection = null;
}

function selectRow(idx) {
  currentIndex = idx;
  renderEditor();
  renderRowList();
}

function getOffset(container, node, offset) {
  const range = document.createRange();
  range.selectNodeContents(container);
  range.setEnd(node, offset);
  return range.toString().length;
}

function captureSelection() {
  const sel = window.getSelection();
  if (!sel || sel.isCollapsed || sel.rangeCount === 0) {
    pendingSelection = null;
    return;
  }
  if (!textDisplayEl.contains(sel.anchorNode) || !textDisplayEl.contains(sel.focusNode)) {
    pendingSelection = null;
    return;
  }
  let start = getOffset(textDisplayEl, sel.anchorNode, sel.anchorOffset);
  let end = getOffset(textDisplayEl, sel.focusNode, sel.focusOffset);
  if (start > end) [start, end] = [end, start];
  pendingSelection = start === end ? null : { start, end };
}

function assignCode(start, end, code) {
  const row = rows[currentIndex];
  const newSpans = [];
  for (const sp of row.spans) {
    if (sp.end <= start || sp.start >= end) {
      newSpans.push(sp);
      continue;
    }
    if (sp.start < start) newSpans.push({ start: sp.start, end: start, code: sp.code });
    if (sp.end > end) newSpans.push({ start: end, end: sp.end, code: sp.code });
  }
  if (code) newSpans.push({ start, end, code });
  row.spans = newSpans;
  pendingSelection = null;
  window.getSelection().removeAllRanges();
  renderEditor();
  renderRowList();
}

function applyPendingSelection(code) {
  if (!pendingSelection) return;
  assignCode(pendingSelection.start, pendingSelection.end, code);
}

function renderCodeButtons() {
  const container = document.getElementById('code-buttons');
  container.innerHTML = '';
  CODES.forEach((code, i) => {
    const btn = document.createElement('button');
    btn.className = 'code-btn';
    btn.dataset.code = code;
    btn.style.background = CODE_COLORS[i];
    btn.innerHTML = `${code} <kbd>${i + 1}</kbd>`;
    btn.addEventListener('click', () => applyPendingSelection(code));
    container.appendChild(btn);
  });
  const clearBtn = document.createElement('button');
  clearBtn.className = 'code-btn clear-btn';
  clearBtn.dataset.code = '';
  clearBtn.innerHTML = 'Clear <kbd>0</kbd>';
  clearBtn.addEventListener('click', () => applyPendingSelection(''));
  container.appendChild(clearBtn);
}

textDisplayEl.addEventListener('mouseup', captureSelection);

document.addEventListener('keydown', (e) => {
  if (e.target === commentBoxEl) return;
  if (e.key >= '1' && e.key <= '5') applyPendingSelection(CODES[Number(e.key) - 1]);
  else if (e.key === '0' || e.key === 'Backspace' || e.key === 'Delete') applyPendingSelection('');
});

commentBoxEl.addEventListener('input', () => {
  rows[currentIndex].comment = commentBoxEl.value;
});

function setSaveStatus(msg) {
  saveStatusEl.textContent = msg;
}

saveBtnEl.addEventListener('click', async () => {
  setSaveStatus('Saving…');
  try {
    const payload = {
      rows: rows.map((r) => ({
        id: r.id,
        setting: r.setting,
        time: r.time,
        text: r.text,
        comment: r.comment,
        spans: r.spans,
      })),
    };
    const resp = await fetch('/api/rows', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    if (!resp.ok) throw new Error('save failed');
    setSaveStatus('Saved ✓');
  } catch (e) {
    setSaveStatus('Save failed');
  }
  setTimeout(() => setSaveStatus(''), 2000);
});

async function init() {
  renderCodeButtons();
  const resp = await fetch('/api/rows');
  const data = await resp.json();
  rows = data.rows;
  renderRowList();
  selectRow(0);
}

init();
