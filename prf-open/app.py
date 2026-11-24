"""Qualitative coding web app (see spec.txt).

Run with:  python app.py   (then open http://127.0.0.1:5000)
"""

import csv
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import uuid
from datetime import datetime
from pathlib import Path

from flask import Flask, jsonify, render_template, request

app = Flask(__name__)
# Flask < 2.0 lets browsers cache static files for 12 hours; always serve the current JS/CSS.
app.config["SEND_FILE_MAX_AGE_DEFAULT"] = 0


@app.context_processor
def static_versioning():
    def static_url(filename):
        path = Path(app.static_folder) / filename
        version = int(path.stat().st_mtime) if path.exists() else 0
        return f"/static/{filename}?v={version}"
    return {"static_url": static_url}

QUESTIONS = ["goodatml", "discipline"]
TIMES = ["1-Pre", "2-Post", "3-DelayPost"]
PATTERN_THEME = "patterns across time"
PROPOSE_CODE = "__propose__"

# Canonical note keys -> header written to the notes CSV.
NOTE_COLUMNS = {
    "goodatml_pp": "goodatml: pre->post",
    "goodatml_pd": "goodatml: pre/post->delay-post",
    "discipline_pp": "discipline: pre->post",
    "discipline_pd": "discipline: pre/post -> delaypost",
}

ANNOTATION_FIELDS = [
    "annotation_id", "participant_id", "source", "field", "transition", "start", "end",
    "text", "code", "theme", "modifier", "full_code", "comment", "created_at",
]
PROPOSE_LABEL = "propose-new-code"
HIGHLIGHTS_VERSION = 1

SESSION_FILE = Path.home() / ".prf_open_session.json"
APP_DIR = Path(__file__).resolve().parent
DEFAULT_DATA_DIR = (APP_DIR / ".." / ".." / "ml-prf-data" / "qual").resolve()
DEFAULT_PATHS = {
    "data": DEFAULT_DATA_DIR / "qual_participant_view.csv",
    "notes": DEFAULT_DATA_DIR / "lisa_utm_utsg_open.csv",
    "codebook": DEFAULT_DATA_DIR / "open_codebook_oct27.csv",
}
# Every coder's highlights, offered by default on the analysis page (Coder 1, 2, 3 in this order).
DEFAULT_CODERS = [
    DEFAULT_DATA_DIR / "lisa_utm_utsg_open_highlights.json",
    DEFAULT_DATA_DIR / "KaterinaNCSU_highlights.json",
    DEFAULT_DATA_DIR / "ilinca_tud_open_highlights.json",
]

# In-memory state. The source of truth on disk is the CSV files the user picks.
state = {
    "paths": {"data": "", "notes": "", "codebook": "", "highlights": "", "codes": ""},
    "participants": {},   # id -> {id, site, group, responses: {question: {time: text}}}
    "notes": {},          # id -> {note_key: text}
    "notes_extra": {"columns": [], "rows": {}},  # unknown columns in the notes file
    "codebook": [],       # [{theme, code, description, kind}]
    "annotations": [],    # [dict with ANNOTATION_FIELDS]
    "backed_up": set(),   # paths already backed up this session
}


# ---------------------------------------------------------------- helpers

def norm_header(h):
    return re.sub(r"[^a-z0-9:/>]", "", (h or "").strip().lower())


def note_key_for_header(h):
    """Map a (possibly messy) notes header onto a canonical note key."""
    n = norm_header(h)
    q = next((q for q in QUESTIONS if q in n), None)
    if q is None:
        return None
    return f"{q}_pd" if "delay" in n else f"{q}_pp"


def canonical_time(t):
    """Map spelling variants ('3-Delay Post', 'post') onto the labels in TIMES."""
    low = t.lower()
    if "delay" in low:
        return "3-DelayPost"
    if "post" in low:
        return "2-Post"
    if "pre" in low:
        return "1-Pre"
    return t


def parse_group(pid):
    m = re.search(r"-([A-Za-z])-", pid)
    return m.group(1).upper() if m else ""


def read_rows(path):
    with open(path, newline="", encoding="utf-8-sig") as f:
        return list(csv.reader(f))


def atomic_write(path, write_fn):
    """Write via a temp file; back up the original once per session."""
    path = Path(path)
    if path.exists() and str(path) not in state["backed_up"]:
        shutil.copy2(path, str(path) + ".bak")
        state["backed_up"].add(str(path))
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp = tempfile.mkstemp(dir=path.parent, suffix=".tmp")
    with os.fdopen(fd, "w", newline="", encoding="utf-8") as f:
        write_fn(f)
    os.replace(tmp, path)


def atomic_write_csv(path, header, rows):
    def write(f):
        w = csv.writer(f)
        w.writerow(header)
        w.writerows(rows)
    atomic_write(path, write)


def save_session():
    try:
        SESSION_FILE.write_text(json.dumps(state["paths"], indent=2))
    except OSError:
        pass


def load_session_paths():
    try:
        return json.loads(SESSION_FILE.read_text())
    except (OSError, ValueError):
        return {}


def expand(p):
    return str(Path(p).expanduser()) if p else ""


# ---------------------------------------------------------------- loaders

def load_data(path):
    state["participants"] = parse_data(path)


def parse_data(path):
    rows = read_rows(path)
    if not rows:
        raise ValueError("Data file is empty")
    header = [norm_header(h) for h in rows[0]]
    idx = {name: header.index(name) for name in ("id", "site", "time", "question", "response")
           if name in header}
    missing = {"id", "time", "question", "response"} - idx.keys()
    if missing:
        raise ValueError(f"Data file missing columns: {', '.join(sorted(missing))}")

    def get(row, name):
        i = idx.get(name)
        return row[i].strip() if i is not None and i < len(row) else ""

    participants = {}
    for row in rows[1:]:
        pid = get(row, "id")
        if not pid:
            continue  # rows without an id are not analyzed
        question = get(row, "question")
        if question not in QUESTIONS:
            continue
        p = participants.setdefault(pid, {
            "id": pid, "site": get(row, "site"), "group": parse_group(pid),
            "responses": {q: {} for q in QUESTIONS},
        })
        time = canonical_time(get(row, "time"))
        response = row[idx["response"]] if idx["response"] < len(row) else ""
        prev = p["responses"][question].get(time)
        p["responses"][question][time] = f"{prev}\n\n{response}" if prev else response
    # Coding is about change from Pre, so show only participants with a Pre answer and at
    # least one later answer. (Hidden participants' notes rows are still kept by write_notes.)
    def has(p, pred):
        return any(pred(t) and text.strip()
                   for answers in p["responses"].values() for t, text in answers.items())

    return {
        pid: p for pid, p in participants.items()
        if has(p, lambda t: t == "1-Pre") and has(p, lambda t: t != "1-Pre")
    }


def load_notes(path):
    notes, extra_cols, extra_rows = parse_notes(path)
    state["notes"] = notes
    state["notes_extra"] = {"columns": extra_cols, "rows": extra_rows}


def parse_notes(path):
    """Return (notes, extra_columns, extra_rows) from a notes CSV; empty if it doesn't exist."""
    notes, extra_cols, extra_rows = {}, [], {}
    if path and Path(path).exists():
        rows = read_rows(path)
        if rows:
            header = rows[0]
            id_col = next((i for i, h in enumerate(header) if norm_header(h) == "id"), None)
            if id_col is None:
                raise ValueError("Notes file has no 'id' column")
            col_keys = {}
            for i, h in enumerate(header):
                if i == id_col:
                    continue
                key = note_key_for_header(h)
                if key:
                    col_keys[i] = key
                elif h.strip():
                    col_keys[i] = ("extra", h.strip())
                    extra_cols.append(h.strip())
            for row in rows[1:]:
                pid = row[id_col].strip() if id_col < len(row) else ""
                if not pid:
                    continue
                entry = notes.setdefault(pid, {})
                for i, key in col_keys.items():
                    val = row[i].strip() if i < len(row) else ""
                    if not val:
                        continue
                    if isinstance(key, tuple):
                        extra_rows.setdefault(pid, {})[key[1]] = val
                    elif entry.get(key):  # duplicate rows: keep both texts
                        if val not in entry[key]:
                            entry[key] += "\n" + val
                    else:
                        entry[key] = val
    return notes, extra_cols, extra_rows


def write_notes():
    path = state["paths"]["notes"]
    if not path:
        raise ValueError("No notes file path set")
    extra = state["notes_extra"]
    ids = list(state["participants"].keys())
    ids += [pid for pid in state["notes"] if pid not in state["participants"]]
    header = ["id"] + list(NOTE_COLUMNS.values()) + extra["columns"]
    rows = []
    for pid in ids:
        n = state["notes"].get(pid, {})
        e = extra["rows"].get(pid, {})
        rows.append([pid] + [n.get(k, "") for k in NOTE_COLUMNS] +
                    [e.get(c, "") for c in extra["columns"]])
    atomic_write_csv(path, header, rows)


def load_codebook(path):
    state["codebook"] = parse_codebook(path)


def parse_codebook(path):
    rows = read_rows(path)
    if not rows:
        raise ValueError("Codebook is empty")
    header = [re.sub(r"[^a-z]", "", h.lower()) for h in rows[0]]
    try:
        ti, ci = header.index("theme"), header.index("code")
    except ValueError:
        raise ValueError("Codebook needs 'theme' and 'code' columns")
    di = header.index("description") if "description" in header else None
    codes, seen = [], set()
    for row in rows[1:]:
        theme = row[ti].strip() if ti < len(row) else ""
        code = row[ci].strip() if ci < len(row) else ""
        if not code or (theme, code) in seen:
            continue
        seen.add((theme, code))
        # Description may itself contain unquoted commas: rejoin the tail.
        desc = ",".join(row[di:]).strip() if di is not None and di < len(row) else ""
        kind = "pattern" if theme.lower() == PATTERN_THEME else "concept"
        codes.append({"theme": theme, "code": code, "description": desc, "kind": kind})
    return codes


def default_transition(source, field):
    """Best guess at which note transition a highlight belongs to."""
    if source == "note":
        return field if field in NOTE_COLUMNS else ""
    question, _, time = field.partition("|")
    if question not in QUESTIONS:
        return ""
    return f"{question}_pd" if time == "3-DelayPost" else f"{question}_pp"


def load_highlights(path):
    state["annotations"] = parse_highlights(path)[0]


def parse_highlights(path):
    """Return (annotations, files, notes) from a highlights JSON; empty if it doesn't exist.

    notes is None for files saved before notes were included in the JSON.
    """
    anns, files, notes = [], {}, None
    if path and Path(path).exists():
        with open(path, encoding="utf-8") as f:
            doc = json.load(f)
        if isinstance(doc, dict) and isinstance(doc.get("files"), dict):
            files = doc["files"]
        if isinstance(doc, dict) and isinstance(doc.get("notes"), dict):
            notes = doc["notes"]
        raw = doc.get("highlights", []) if isinstance(doc, dict) else doc
        for item in raw:
            a = {k: item.get(k, "") for k in ANNOTATION_FIELDS}
            a["annotation_id"] = a["annotation_id"] or uuid.uuid4().hex[:12]
            try:
                a["start"], a["end"] = int(a["start"]), int(a["end"])
            except (TypeError, ValueError):
                a["start"], a["end"] = -1, -1
            if a["transition"] not in NOTE_COLUMNS:
                a["transition"] = default_transition(a["source"], a["field"])
            a["full_code"] = export_code(a)
            anns.append(a)
    return anns, files, notes


def export_code(a):
    """How an applied code appears in the codes CSV, e.g. '+training' or 'return-to-pre'."""
    if a["code"] == PROPOSE_CODE:
        return PROPOSE_LABEL
    return f"{a['modifier']}{a['code']}"


def write_highlights():
    path = state["paths"]["highlights"]
    if not path:
        raise ValueError("No highlights JSON path set")
    doc = {
        "version": HIGHLIGHTS_VERSION,
        "saved_at": datetime.now().isoformat(timespec="seconds"),
        "files": {k: v for k, v in state["paths"].items() if k != "highlights"},
        # A copy of the notes (the CSV stays the source of truth), so this one file is enough
        # for the analysis page to show a coder's notes with their highlights.
        "notes": {pid: {k: v for k, v in n.items() if v.strip()}
                  for pid, n in sorted(state["notes"].items()) if any(v.strip() for v in n.values())},
        "highlights": state["annotations"],
    }
    atomic_write(path, lambda f: json.dump(doc, f, indent=2, ensure_ascii=False))


def write_codes_csv():
    path = state["paths"]["codes"]
    if not path:
        return
    cells = {}  # pid -> transition -> [codes, de-duplicated, in order applied]
    for a in state["annotations"]:
        if a["transition"] not in NOTE_COLUMNS:
            continue
        lst = cells.setdefault(a["participant_id"], {}).setdefault(a["transition"], [])
        c = export_code(a)
        if c not in lst:
            lst.append(c)
    ids = [pid for pid in state["participants"]]
    ids += [pid for pid in cells if pid not in state["participants"]]
    rows = [[pid] + [";".join(cells.get(pid, {}).get(k, [])) for k in NOTE_COLUMNS] for pid in ids]
    atomic_write_csv(path, ["id"] + list(NOTE_COLUMNS.values()), rows)


def write_annotations():
    write_highlights()
    write_codes_csv()


def sibling_path(path, suffix):
    if not path:
        return ""
    p = Path(path)
    return str(p.with_name(p.stem + suffix))


def snapshot():
    return {
        "paths": state["paths"],
        "participants": sorted(state["participants"].values(), key=lambda p: p["id"]),
        "notes": state["notes"],
        "codebook": state["codebook"],
        "annotations": state["annotations"],
        "questions": QUESTIONS,
        "times": TIMES,
        "noteColumns": NOTE_COLUMNS,
        "proposeCode": PROPOSE_CODE,
        "proposeLabel": PROPOSE_LABEL,
    }


# ---------------------------------------------------------------- routes

@app.route("/")
def index():
    return render_template("index.html")


def applescript_str(s):
    return '"' + s.replace("\\", "\\\\").replace('"', '\\"') + '"'


def native_file_dialog(mode, title, current):
    """Show a native open/save dialog on this machine; return the chosen path or ''."""
    cur = Path(current).expanduser() if current else None
    start_dir = str(cur.parent if cur and not cur.is_dir() else cur) if cur else str(Path.home())
    if not Path(start_dir).is_dir():
        start_dir = str(Path.home())
    default_name = cur.name if cur and not cur.is_dir() else ""

    if sys.platform == "darwin":
        loc = f"default location (POSIX file {applescript_str(start_dir)})"
        if mode == "save":
            name = f" default name {applescript_str(default_name)}" if default_name else ""
            cmd = f"choose file name with prompt {applescript_str(title)}{name} {loc}"
        else:
            cmd = f"choose file with prompt {applescript_str(title)} {loc}"
        script = f"POSIX path of ({cmd})"
        r = subprocess.run(["osascript", "-e", script], capture_output=True, text=True)
        if r.returncode != 0:
            if "-128" in r.stderr:  # user cancelled
                return ""
            raise OSError(r.stderr.strip() or "file dialog failed")
        return r.stdout.strip()

    # Other platforms: tkinter in a child process (it must own the main thread).
    fn = "asksaveasfilename" if mode == "save" else "askopenfilename"
    code = (
        "import sys, tkinter as tk; from tkinter import filedialog as fd\n"
        "root = tk.Tk(); root.withdraw(); root.attributes('-topmost', True)\n"
        f"p = fd.{fn}(title=sys.argv[1], initialdir=sys.argv[2], initialfile=sys.argv[3])\n"
        "print(p or '')\n"
    )
    r = subprocess.run([sys.executable, "-c", code, title, start_dir, default_name],
                       capture_output=True, text=True)
    if r.returncode != 0:
        raise OSError(r.stderr.strip() or "file dialog failed")
    return r.stdout.strip()


@app.route("/api/browse", methods=["POST"])
def browse():
    body = request.get_json(force=True)
    mode = "save" if body.get("mode") == "save" else "open"
    try:
        path = native_file_dialog(mode, body.get("title") or "Choose a file", body.get("current") or "")
    except OSError as e:
        return jsonify({"error": str(e)}), 500
    return jsonify({"path": path})


@app.route("/api/state", methods=["GET"])
def get_state():
    return jsonify(snapshot())


@app.route("/api/last-session", methods=["GET"])
def last_session():
    paths = load_session_paths()
    for k, default in DEFAULT_PATHS.items():
        if not paths.get(k):
            paths[k] = str(default)
    return jsonify(paths)


@app.route("/api/load", methods=["POST"])
def api_load():
    body = request.get_json(force=True)
    paths = {k: expand(body.get(k, "").strip()) for k in ("data", "notes", "codebook", "highlights", "codes")}
    paths["highlights"] = paths["highlights"] or sibling_path(paths["notes"], "_highlights.json")
    paths["codes"] = paths["codes"] or sibling_path(paths["notes"], "_codes.csv")
    try:
        if not paths["data"]:
            raise ValueError("A participant data CSV path is required")
        if not Path(paths["data"]).exists():
            raise ValueError(f"Data file not found: {paths['data']}")
        if not paths["notes"]:
            raise ValueError("A notes CSV path is required (it will be created if missing)")
        load_data(paths["data"])
        load_notes(paths["notes"])
        if paths["codebook"]:
            if not Path(paths["codebook"]).exists():
                raise ValueError(f"Codebook not found: {paths['codebook']}")
            load_codebook(paths["codebook"])
        else:
            state["codebook"] = []
        load_highlights(paths["highlights"])
    except (OSError, ValueError, csv.Error) as e:
        return jsonify({"error": str(e)}), 400
    state["paths"] = paths
    state["backed_up"] = set()
    save_session()
    return jsonify(snapshot())


@app.route("/api/reload-codebook", methods=["POST"])
def reload_codebook():
    path = state["paths"]["codebook"]
    try:
        if not path:
            raise ValueError("No codebook path set")
        load_codebook(path)
    except (OSError, ValueError, csv.Error) as e:
        return jsonify({"error": str(e)}), 400
    return jsonify({"codebook": state["codebook"]})


@app.route("/api/notes", methods=["POST"])
def save_note():
    body = request.get_json(force=True)
    pid, key, value = body.get("participant"), body.get("key"), body.get("value", "")
    if key not in NOTE_COLUMNS or not pid:
        return jsonify({"error": "bad note key or participant"}), 400
    state["notes"].setdefault(pid, {})[key] = value
    try:
        write_notes()
    except (OSError, ValueError) as e:
        return jsonify({"error": str(e)}), 500
    return jsonify({"ok": True})


@app.route("/api/annotations", methods=["POST"])
def add_annotation():
    body = request.get_json(force=True)
    code = body.get("code", "")
    modifier = body.get("modifier", "")
    if modifier not in ("", "+", "-", "="):
        return jsonify({"error": "bad modifier"}), 400
    source, field = body.get("source", ""), body.get("field", "")
    transition = body.get("transition") or default_transition(source, field)
    if transition not in NOTE_COLUMNS:
        return jsonify({"error": "bad transition"}), 400
    a = {
        "annotation_id": uuid.uuid4().hex[:12],
        "participant_id": body.get("participant", ""),
        "source": source,
        "field": field,
        "transition": transition,
        "start": int(body.get("start", 0)),
        "end": int(body.get("end", 0)),
        "text": body.get("text", ""),
        "code": code,
        "theme": body.get("theme", ""),
        "modifier": modifier,
        "full_code": PROPOSE_LABEL if code == PROPOSE_CODE else f"{modifier}{code}",
        "comment": body.get("comment", ""),
        "created_at": datetime.now().isoformat(timespec="seconds"),
    }
    state["annotations"].append(a)
    try:
        write_annotations()
    except (OSError, ValueError) as e:
        state["annotations"].pop()
        return jsonify({"error": str(e)}), 500
    return jsonify(a)


@app.route("/api/annotations/<ann_id>", methods=["DELETE"])
def delete_annotation(ann_id):
    before = state["annotations"]
    state["annotations"] = [a for a in before if a["annotation_id"] != ann_id]
    try:
        write_annotations()
    except (OSError, ValueError) as e:
        state["annotations"] = before
        return jsonify({"error": str(e)}), 500
    return jsonify({"ok": True})


@app.route("/api/annotations/<ann_id>", methods=["PATCH"])
def update_annotation(ann_id):
    """Re-anchor a highlight after its note was edited, or change its transition/comment."""
    body = request.get_json(force=True)
    if "transition" in body and body["transition"] not in NOTE_COLUMNS:
        return jsonify({"error": "bad transition"}), 400
    for a in state["annotations"]:
        if a["annotation_id"] == ann_id:
            for k in ("start", "end"):
                if k in body:
                    a[k] = int(body[k])
            for k in ("comment", "transition"):
                if k in body:
                    a[k] = body[k]
            try:
                write_annotations()
            except (OSError, ValueError) as e:
                return jsonify({"error": str(e)}), 500
            return jsonify(a)
    return jsonify({"error": "not found"}), 404


@app.route("/api/save", methods=["POST"])
def save_all():
    """Write notes CSV, codes CSV and highlights JSON, optionally to new paths."""
    body = request.get_json(force=True) or {}
    if not state["paths"]["data"]:
        return jsonify({"error": "Load a data file first"}), 400
    for k in ("notes", "highlights", "codes"):
        new = expand((body.get(k) or "").strip())
        if new:
            state["paths"][k] = new
    try:
        write_notes()
        write_annotations()
    except (OSError, ValueError, csv.Error) as e:
        return jsonify({"error": str(e)}), 500
    save_session()
    return jsonify({"paths": state["paths"]})


# ---------------------------------------------------------------- analysis page
#
# A separate, read-only view over several coders' highlights JSON files (see spec.txt,
# ANALYSIS MODE). The only thing it writes is code_summary.json: one summary per code,
# transition (pre->post, pre/post->delay-post) and group (A, B).

ANALYSIS_SESSION_FILE = Path.home() / ".prf_open_analysis_session.json"

# Codes merged into another code on the analysis page: old code name -> new code name.
# The modifier is kept (+overfitting -> +overfitting-underfitting); a code merged into a pattern
# code loses it. Display only: the coders' highlights files are not changed.
CODE_MERGES = {
    "overfitting": "overfitting-underfitting",
}
SUMMARY_VERSION = 1

astate = {
    "paths": {"data": "", "codebook": "", "summary": "", "highlights": []},
    "participants": {},
    "codebook": [],
    "coders": [],      # [{name, path, notes_path, notes, annotations}]
    # full_code ("+training", "return-to-pre") ->
    #   {"theme": str, "pp"/"pd": {"A"/"B": {summary, updated_at}}}
    "summaries": {},
}
# A code summary is written per transition (as labelled in code_summary.json) and group.
SUMMARY_TRANSITIONS = {"pp": "pre->post", "pd": "pre/post->delay-post"}
SUMMARY_GROUPS = ("A", "B")


def coder_notes_path(highlights_path, files):
    """The notes CSV a highlights file was made with: as recorded in it, else its sibling."""
    recorded = expand(files.get("notes", "")) if isinstance(files.get("notes"), str) else ""
    if recorded and Path(recorded).exists():
        return recorded
    p = Path(highlights_path)
    if p.name.endswith("_highlights.json"):
        sibling = p.with_name(p.name[: -len("_highlights.json")] + ".csv")
        if sibling.exists():
            return str(sibling)
    return ""


def parse_summaries(path):
    if not path or not Path(path).exists():
        return {}
    with open(path, encoding="utf-8") as f:
        doc = json.load(f)
    raw = doc.get("summaries", {}) if isinstance(doc, dict) else {}

    def one(s):
        return {"summary": s.get("summary", ""), "updated_at": s.get("updated_at", "")}

    out = {}
    for code, v in raw.items():
        if not isinstance(v, dict):
            continue
        entry = {"theme": v.get("theme", "")}
        # Earlier formats had no groups: copy such a summary to both groups so nothing is lost.
        if "summary" in v:  # one summary per code: kept as pre->post
            entry["pp"] = {g: one(v) for g in SUMMARY_GROUPS}
        for k, label in SUMMARY_TRANSITIONS.items():
            t = v.get(label)
            if not isinstance(t, dict):
                continue
            if "summary" in t:  # one summary per code and transition
                entry[k] = {g: one(t) for g in SUMMARY_GROUPS}
            else:
                entry[k] = {g: one(t[g]) for g in SUMMARY_GROUPS if isinstance(t.get(g), dict)}
        out[code] = entry
    return out


def write_summaries():
    path = astate["paths"]["summary"]
    if not path:
        raise ValueError("No code summary path set")
    summaries = {}
    for code, entry in sorted(astate["summaries"].items()):
        # Empty summaries are dropped; sorted so diffs stay readable.
        written = {}
        for k, label in SUMMARY_TRANSITIONS.items():
            groups = {g: s for g, s in sorted(entry.get(k, {}).items()) if s["summary"].strip()}
            if groups:
                written[label] = groups
        if written:
            summaries[code] = {"theme": entry.get("theme", ""), **written}
    doc = {
        "version": SUMMARY_VERSION,
        "saved_at": datetime.now().isoformat(timespec="seconds"),
        "files": {
            "data": astate["paths"]["data"],
            "codebook": astate["paths"]["codebook"],
            "highlights": [c["path"] for c in astate["coders"]],
        },
        "summaries": summaries,
    }
    atomic_write(path, lambda f: json.dump(doc, f, indent=2, ensure_ascii=False))


def analysis_snapshot():
    return {
        "paths": astate["paths"],
        "participants": sorted(astate["participants"].values(), key=lambda p: p["id"]),
        "codebook": astate["codebook"],
        "coders": astate["coders"],
        "summaries": astate["summaries"],
        "codeMerges": CODE_MERGES,
        "questions": QUESTIONS,
        "times": TIMES,
        "noteColumns": NOTE_COLUMNS,
        "proposeCode": PROPOSE_CODE,
        "proposeLabel": PROPOSE_LABEL,
    }


@app.route("/analysis")
def analysis_page():
    return render_template("analysis.html")


@app.route("/quant")
def quant_page():
    """Co-occurrence between codes (spec.txt, QUANT ANALYSIS MODE); uses the analysis files."""
    return render_template("quant.html")


@app.route("/api/analysis/state", methods=["GET"])
def analysis_state():
    return jsonify(analysis_snapshot())


@app.route("/api/analysis/last-session", methods=["GET"])
def analysis_last_session():
    try:
        paths = json.loads(ANALYSIS_SESSION_FILE.read_text())
    except (OSError, ValueError):
        paths = {}
    coding = load_session_paths()
    for k in ("data", "codebook"):
        paths[k] = paths.get(k) or coding.get(k) or str(DEFAULT_PATHS[k])
    if not paths.get("highlights"):
        paths["highlights"] = [str(p) for p in DEFAULT_CODERS]
    paths["summary"] = paths.get("summary") or str(Path(paths["data"]).parent / "code_summary.json")
    return jsonify(paths)


@app.route("/api/analysis/load", methods=["POST"])
def analysis_load():
    body = request.get_json(force=True)
    data, codebook, summary = (expand((body.get(k) or "").strip()) for k in ("data", "codebook", "summary"))
    hl_paths = [expand(p.strip()) for p in body.get("highlights") or [] if p and p.strip()]
    try:
        if not data or not Path(data).exists():
            raise ValueError(f"Data file not found: {data or '(none given)'}")
        if not codebook or not Path(codebook).exists():
            raise ValueError(f"Codebook not found: {codebook or '(none given)'}")
        if not hl_paths:
            raise ValueError("Add at least one coder's highlights JSON")
        if not summary:
            raise ValueError("A code summary JSON path is required (it will be created if missing)")
        participants = parse_data(data)
        codes = parse_codebook(codebook)
        coders = []
        for i, path in enumerate(hl_paths, 1):
            if not Path(path).exists():
                raise ValueError(f"Highlights file not found: {path}")
            anns, files, notes = parse_highlights(path)
            if notes is not None:
                notes_source = "highlights JSON"
            else:  # older highlights file: look for the coder's notes CSV
                notes_source = coder_notes_path(path, files)
                notes = parse_notes(notes_source)[0] if notes_source else {}
            coders.append({
                "name": f"Coder {i}", "path": path, "notes_source": notes_source,
                "notes": notes, "annotations": anns,
            })
        summaries = parse_summaries(summary)
    except (OSError, ValueError, csv.Error) as e:
        return jsonify({"error": str(e)}), 400
    astate.update(participants=participants, codebook=codes, coders=coders, summaries=summaries,
                  paths={"data": data, "codebook": codebook, "summary": summary, "highlights": hl_paths})
    try:
        ANALYSIS_SESSION_FILE.write_text(json.dumps(astate["paths"], indent=2))
    except OSError:
        pass
    return jsonify(analysis_snapshot())


@app.route("/api/analysis/summary", methods=["POST"])
def analysis_save_summary():
    body = request.get_json(force=True)
    code = (body.get("code") or "").strip()
    trans, group = body.get("transition"), body.get("group")
    if not code or trans not in SUMMARY_TRANSITIONS or group not in SUMMARY_GROUPS:
        return jsonify({"error": "missing code, or bad transition or group"}), 400
    previous = astate["summaries"].get(code)
    entry = {**(previous or {}), "theme": body.get("theme", "") or (previous or {}).get("theme", "")}
    entry[trans] = {**entry.get(trans, {}), group: {
        "summary": body.get("summary", ""), "updated_at": datetime.now().isoformat(timespec="seconds")}}
    astate["summaries"][code] = entry
    try:
        write_summaries()
    except (OSError, ValueError) as e:
        if previous is None:
            astate["summaries"].pop(code, None)
        else:
            astate["summaries"][code] = previous
        return jsonify({"error": str(e)}), 500
    return jsonify(entry)


if __name__ == "__main__":
    app.run(debug=True, port=int(os.environ.get("PORT", 5001)))
