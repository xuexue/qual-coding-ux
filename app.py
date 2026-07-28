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


def text_hash(text):
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def tokenize_with_offsets(text):
    return [(m.start(), m.end(), m.group()) for m in re.finditer(r"[^\s;]+", text)]


def reconstruct_fallback(text, cells):
    """Best-effort span reconstruction from saved per-code strings.

    Matches whitespace-delimited tokens of `text`, in order, against each
    code's own token sequence. Used only when no exact sidecar spans are
    available for a row (e.g. after a hand-edit). Chunks can be delimited by
    spaces or semicolons, but if the original text contains semicolons, only
    spaces are treated as delimiters (to avoid ambiguity).

    Codes are matched largest-token-count first, not in CODES order: a
    longer piece has fewer other occurrences of its words to fall back on,
    so if a shorter piece claimed a shared word first, the longer piece
    could be left unable to complete its sequence at all. Claiming
    greedily from largest to smallest avoids that. Ties fall back to CODES
    order.
    """
    if ';' in text:
        code_tokens = {code: cells[code].split() for code in CODES}
    else:
        code_tokens = {code: cells[code].replace(';', ' ').split() for code in CODES}
    toks_with_offsets = tokenize_with_offsets(text)
    claimed = [False] * len(toks_with_offsets)
    spans = []
    for code in sorted(CODES, key=lambda c: -len(code_tokens[c])):
        toks = code_tokens[code]
        ptr = 0
        for i, (start, end, tok) in enumerate(toks_with_offsets):
            if ptr >= len(toks):
                break
            if not claimed[i] and toks[ptr] == tok:
                spans.append({"start": start, "end": end, "code": code})
                claimed[i] = True
                ptr += 1
    spans.sort(key=lambda s: s["start"])
    return spans


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
        text = r.get("text", "")
        spans = r.get("spans", [])
        cells = spans_to_cells(text, spans)
        csv_rows.append({
            "id": r.get("id", ""),
            "site": r.get("setting", ""),
            "time": r.get("time", ""),
            "response": text,
            "Comments": r.get("comment", ""),
            "Length check": "",
            **cells,
        })
        sidecar_rows.append({"text_hash": text_hash(text), "spans": spans})
    write_csv_rows(csv_rows)
    write_sidecar(sidecar_rows)
    return jsonify({"ok": True})


if __name__ == "__main__":
    app.run(port=5050, debug=True)
