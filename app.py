import csv
import hashlib
import json
import os
import re

from flask import Flask, jsonify, request, send_from_directory

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
CSV_PATH = os.path.join(BASE_DIR, "sample.csv")
SIDECAR_PATH = CSV_PATH + ".spans.json"
CODES = ["Model Session", "Apply Session", "Both", "Neither", "Empty/ I don't know answer"]
FIELDNAMES = ["id", "site", "time", "response", *CODES, "Comments", "Length check"]

app = Flask(__name__, static_folder=os.path.join(BASE_DIR, "static"), static_url_path="/static")


def normalize_newlines(text):
    """Canonicalize Windows (\\r\\n) and classic-Mac (\\r) line breaks to \\n.

    Source CSVs get edited across Windows, Mac, and various tools (Excel,
    git autocrlf, ...), each with their own convention for line breaks
    embedded inside a cell. Left as-is, that convention can silently change
    between saves without the text actually changing meaning, which:
    - shifts `text_hash`, since it hashes raw bytes (\\n, \\r\\n, and \\r all
      hash completely differently for the same content), invalidating the
      sidecar cache and forcing a `reconstruct_fallback` re-derive every
      time the file round-trips through a different tool/OS, and
    - can misalign previously-saved span offsets against the current text
      if the character count of a row's embedded newlines changed.

    Normalizing once, right where text enters the app (CSV read, POST
    payload), keeps hashing/tokenizing/offsets stable regardless of what
    last touched the file, and any row saved from here on writes back with
    a consistent \\n, so the file's line endings converge over time.
    """
    if text is None:
        return text
    return text.replace("\r\n", "\n").replace("\r", "\n")


def text_hash(text):
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def tokenize_with_offsets(text):
    return [(m.start(), m.end(), m.group()) for m in re.finditer(r"[^\s;]+", text)]


def _reconstruct_fallback_greedy(toks_with_offsets, code_tokens):
    """Single-pass greedy matcher: largest-token-count code first, each
    claiming the first unclaimed occurrence of each of its tokens in text
    order. Fast, but not complete: it can leave a code's sequence
    half-matched when an earlier, greedier claim on a shared word was the
    wrong one. Used only as a last-resort fallback when the exhaustive
    search in `reconstruct_fallback` gives up (genuinely no full matching
    exists, or the search budget is exhausted).

    If a token can't be found from the current scan position onward, it is
    skipped rather than treated as a dead end: an earlier version stopped
    advancing for that code entirely the moment one token failed (e.g. a
    typo like "start" saved as "st art", where "st"/"art" don't exist in
    the text at all), silently abandoning every token after it too — and
    whatever it had already (wrongly) claimed on the way to getting stuck
    stayed claimed, which could starve an otherwise-perfectly-matchable
    *other* code of a token it needed. Skipping means one bad token only
    costs itself, not the rest of its own code's sequence or anyone else's.
    """
    claimed = [False] * len(toks_with_offsets)
    spans = []
    for code in sorted(CODES, key=lambda c: -len(code_tokens[c])):
        pos = 0  # resume point in text for this code's next candidate
        for tok in code_tokens[code]:
            for i in range(pos, len(toks_with_offsets)):
                start, end, t = toks_with_offsets[i]
                if not claimed[i] and t == tok:
                    spans.append({"start": start, "end": end, "code": code})
                    claimed[i] = True
                    pos = i + 1
                    break
            # else: not found from `pos` onward — skip this one token and
            # keep trying the rest of the code's sequence from the same `pos`.
    spans.sort(key=lambda s: s["start"])
    return spans


def reconstruct_fallback(text, cells):
    """Best-effort span reconstruction from saved per-code strings.

    Matches whitespace-delimited tokens of `text`, in order, against each
    code's own token sequence. Used only when no exact sidecar spans are
    available for a row (e.g. after a hand-edit). A cell's tokens can be
    delimited by spaces or semicolons (some coders separate multiple
    excerpts within one cell with "; "), and this always strips semicolons
    the same way `tokenize_with_offsets` does for `text` itself: unconditionally,
    regardless of whether `text` happens to contain a semicolon too. Cell
    values are literal substrings of `text`, so a word that's tokenized
    without its semicolon on the text side (e.g. "sets;" -> "sets") must be
    tokenized identically on the cell side, or the two token streams can
    never line up — treating semicolons as a delimiter only when `text`
    itself has none was tried before and broke exactly that case.

    A single greedy left-to-right pass is not enough: when a word is shared
    between codes (or a code's own tokens repeat), claiming the first
    available occurrence can strand a *later* code (or a later token of the
    same code) with no occurrence left to match, even though a different,
    still-valid choice earlier on would have left one free. For example
    "cat dog cat dog" with Model="cat dog" and Apply="dog cat": grabbing
    token 0/1 for Model leaves Apply only "dog" at the end, unmatched —
    but Model taking tokens 0 and 3 instead leaves 1/2 free for Apply.

    So this does a backtracking search: try to place each code's token
    sequence (largest token-count first, so failures surface, and get
    backtracked, as early as possible), and whenever a placement dead-ends,
    undo it and try the next candidate occurrence — including reopening
    choices made for earlier codes — until every code's tokens are fully
    matched or every possibility has been tried. This is exponential in the
    worst case, so a step budget caps the search; if the budget runs out
    (or no full matching exists at all, e.g. the cell text doesn't actually
    come from this text) it falls back to the old single-pass greedy match,
    which is complete but may leave some tokens unmatched.
    """
    code_tokens = {code: cells[code].replace(';', ' ').split() for code in CODES}

    toks_with_offsets = tokenize_with_offsets(text)
    positions_by_tok = {}
    for i, (_, _, tok) in enumerate(toks_with_offsets):
        positions_by_tok.setdefault(tok, []).append(i)

    # A cell token that doesn't exist anywhere in `text` (a typo, a
    # hand-edit, ...) can never be matched no matter what order things are
    # tried in. Requiring it anyway would make the *entire* joint search
    # fail — since every code must be fully satisfied at once — silently
    # taking every other, perfectly-matchable code down with it. Drop those
    # tokens from the search target before searching: they get no span
    # (there's nothing in `text` to point them at), but the rest of that
    # code's real tokens, and every other code, still get matched.
    code_tokens = {
        code: [tok for tok in toks if tok in positions_by_tok]
        for code, toks in code_tokens.items()
    }

    codes_order = sorted(CODES, key=lambda c: -len(code_tokens[c]))
    token_lists = [code_tokens[c] for c in codes_order]

    MAX_STEPS = 200_000
    steps = 0
    claimed = [False] * len(toks_with_offsets)
    assignment = [None] * len(codes_order)

    def place(code_idx, tok_idx, positions, after):
        nonlocal steps
        tokens = token_lists[code_idx]
        if tok_idx == len(tokens):
            assignment[code_idx] = list(positions)
            return advance(code_idx + 1)
        for i in positions_by_tok.get(tokens[tok_idx], ()):
            if i <= after or claimed[i]:
                continue
            steps += 1
            if steps > MAX_STEPS:
                return False
            claimed[i] = True
            positions.append(i)
            if place(code_idx, tok_idx + 1, positions, i):
                return True
            positions.pop()
            claimed[i] = False
        return False

    def advance(code_idx):
        if code_idx == len(codes_order):
            return True
        if not token_lists[code_idx]:
            assignment[code_idx] = []
            return advance(code_idx + 1)
        return place(code_idx, 0, [], -1)

    if advance(0):
        spans = []
        for code, positions in zip(codes_order, assignment):
            for i in positions:
                start, end, _ = toks_with_offsets[i]
                spans.append({"start": start, "end": end, "code": code})
        spans.sort(key=lambda s: s["start"])
        return spans

    return _reconstruct_fallback_greedy(toks_with_offsets, code_tokens)


def spans_to_cells(text, spans):
    by_code = {code: [] for code in CODES}
    for sp in spans:
        if sp.get("code") in by_code:
            by_code[sp["code"]].append(sp)
    cells = {}
    for code, sps in by_code.items():
        sps_sorted = sorted(sps, key=lambda s: s["start"])
        pieces = [text[s["start"]:s["end"]] for s in sps_sorted]
        cells[code] = " ".join(pieces)
    return cells


def read_csv_rows():
    with open(CSV_PATH, newline="", encoding="utf-8-sig") as f:
        reader = csv.DictReader(f)
        raw_rows = list(reader)
    # Strip leading/trailing whitespace from all column names to handle
    # Excel exports that add trailing spaces (e.g. "Both " -> "Both")
    fieldnames = reader.fieldnames or []
    stripped = [fn.strip() if fn else fn for fn in fieldnames]
    needs_rename = any(orig != new for orig, new in zip(fieldnames, stripped))
    rows = []
    for row in raw_rows:
        if needs_rename:
            row = {stripped[i]: v for i, (k, v) in enumerate(row.items())}
        rows.append(row)
    # Handle BOM or encoding artifacts on the first column by position
    if rows and "id" not in rows[0]:
        first_field = stripped[0] if stripped else None
        if first_field and first_field != "id":
            for row in rows:
                if first_field in row:
                    row["id"] = row.pop(first_field)
    # Canonicalize line endings so hashing/tokenizing/offsets are stable
    # regardless of what OS/tool last saved the file (see normalize_newlines).
    for row in rows:
        for k, v in row.items():
            if isinstance(v, str):
                row[k] = normalize_newlines(v)
    return rows


def write_csv_rows(rows):
    tmp_path = CSV_PATH + ".tmp"
    with open(tmp_path, "w", newline="", encoding="utf-8") as f:
        writer = csv.DictWriter(f, fieldnames=FIELDNAMES, lineterminator="\n")
        writer.writeheader()
        writer.writerows(rows)
    os.replace(tmp_path, CSV_PATH)


def load_sidecar():
    if not os.path.exists(SIDECAR_PATH):
        return []
    with open(SIDECAR_PATH, encoding="utf-8") as f:
        return json.load(f).get("rows", [])


def write_sidecar(rows_spans):
    tmp_path = SIDECAR_PATH + ".tmp"
    with open(tmp_path, "w", encoding="utf-8") as f:
        json.dump({"version": 1, "rows": rows_spans}, f, indent=2)
    os.replace(tmp_path, SIDECAR_PATH)


@app.route("/")
def index():
    return send_from_directory(app.static_folder, "index.html")


@app.route("/api/rows", methods=["GET"])
def get_rows():
    rows = read_csv_rows()
    sidecar_rows = load_sidecar()
    result = []
    for idx, row in enumerate(rows):
        text = row.get("response", "")
        cells = {code: row.get(code, "") for code in CODES}
        entry = sidecar_rows[idx] if idx < len(sidecar_rows) else None
        spans = entry.get("spans", []) if entry else []
        codes_set = set(CODES)
        cached_is_current = (
            entry is not None
            and entry.get("text_hash") == text_hash(text)
            and all(sp.get("code") in codes_set for sp in spans)
            and spans_to_cells(text, spans) == cells
        )
        if not cached_is_current:
            spans = reconstruct_fallback(text, cells)
        result.append({
            "id": row.get("id", ""),
            "setting": row.get("site", ""),
            "time": row.get("time", ""),
            "text": text,
            "comment": row.get("Comments", ""),
            "spans": spans,
        })
    return jsonify({"rows": result})


@app.route("/api/rows", methods=["POST"])
def post_rows():
    payload = request.get_json(force=True) or {}
    in_rows = payload.get("rows", [])
    csv_rows = []
    sidecar_rows = []
    for r in in_rows:
        # Defensive: GET always hands out already-normalized text, so this
        # is normally a no-op, but keeps the on-disk file converging to a
        # single newline convention even if a client ever sends \r\n back.
        text = normalize_newlines(r.get("text", ""))
        spans = r.get("spans", [])
        cells = spans_to_cells(text, spans)
        csv_rows.append({
            "id": r.get("id", ""),
            "site": r.get("setting", ""),
            "time": r.get("time", ""),
            "response": text,
            "Comments": normalize_newlines(r.get("comment", "")),
            "Length check": "",
            **cells,
        })
        sidecar_rows.append({"text_hash": text_hash(text), "spans": spans})
    write_csv_rows(csv_rows)
    write_sidecar(sidecar_rows)
    return jsonify({"ok": True})


if __name__ == "__main__":
    app.run(port=5050, debug=True)
