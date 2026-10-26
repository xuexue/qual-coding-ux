# PRF qualitative coding app

A Flask app implementing `spec.txt`.

## Run

```
python -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
python app.py          # http://127.0.0.1:5001
```

## Files

Enter paths in the top bar (or use **Browse…** to pick them with the native file dialog,
which may open behind the browser window) and click **Load**. To start a new notes or
highlights file, type a path that doesn't exist yet. The last-used paths are remembered in
`~/.prf_open_session.json`.

| Field | Purpose |
|---|---|
| Data CSV | Participant responses (`,id,site,time,question,response`). Rows without an `id` are skipped. Only `goodatml` and `discipline` are shown. |
| Notes CSV | Read if it exists; every edit is saved back to it (created if missing). Messy headers, blank rows and duplicate ids are tolerated; unknown columns are preserved. |
| Codebook CSV | `theme,code,description`. Codes under "Patterns across time" are pattern codes (no modifier); all others are concept codes (`+`, `-`, `=`). Use ↻ to reload after editing. |
| Highlights JSON | Every highlight (participant, source text, offsets, code, modifier, transition, comment). Load it with the CSVs to resume coding. Defaults to `<notes>_highlights.json`. |
| Codes CSV (export) | One row per participant, same columns as the notes CSV, each cell a `;`-separated list such as `+training;+building` or `return-to-pre`. Defaults to `<notes>_codes.csv`. |

All three outputs are written automatically on every change. **Save all** writes them again,
to new paths if you edit the fields (i.e. "save as"). The first time a file is overwritten in
a session, a `.bak` copy is made.

Each code belongs to one of the four transitions. Codes on a note go to that note's transition;
codes on a response default to pre->post (Pre/Post answers) or pre/post->delay-post
(Delay-post answers). Change it with the "Code for transition" picker before applying, or with
the dropdown under each applied code. "Propose new code" exports as `propose-new-code`.

## Workflow

- **Notes mode**: the codebook column is hidden; write the four transition notes (autosaves).
- **Coding mode**: highlight text in a response or a note, then click a code (or a `+ − =`
  button next to it). You can also type in the filter box, optionally ending with `+`, `-` or `=`,
  and press Enter to apply the first match. **Propose new code** records that no existing code fits,
  with an optional description.

Highlights on notes are anchored by offset and text, so they follow the excerpt if the note is
edited later; if the excerpt is deleted, the code is listed as "text no longer found".
