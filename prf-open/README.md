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

## Analysis page

Open http://127.0.0.1:5001/analysis (or **Analysis ↗** in the coding app). Give it the
data CSV, the codebook CSV, a `code_summary.json` path (created if missing), and one highlights
JSON per coder (**+ coder** adds another; coders are numbered Coder 1, 2, … in that order).
The highlights JSON includes a copy of the coder's notes, so that one file is all a coder needs
to send. Files saved before that change have no notes: the page then looks for the notes CSV
recorded in the file, or `<name>.csv` next to `<name>_highlights.json`. To add the notes,
load the files in the coding app and click **Save all** (any edit also re-saves).
The paths are remembered in `~/.prf_open_analysis_session.json`, and the page loads them (or the
three default coders' files) as soon as it opens; click **Load** after changing them.

- **Codes column**: one row per code and modifier (`+training`, `−training`, `=training`,
  `return-to-pre`), grouped by theme, plus codes no longer in the codebook and proposed codes.
  Codes listed in `CODE_MERGES` in `app.py` (old name → new name) are shown and counted under
  the new name, keeping the modifier (`+overfitting` → `+overfitting-underfitting`); a pattern
  code applied with a modifier (e.g. `+return-to-pre`) is shown as the plain pattern code. Both
  are display only: the coders' files are not changed, and hovering a highlight shows what it
  was coded as.
  The four numbers count participants in the current filter selection who were given the code
  by *at least one* coder, in either question: A and B for pre→post, then A and B for →delay-post.
  The `n` row is the number of selected participants per group (for →delay-post, only those
  with a delay-post answer). The **count / %** toggle shows each number as a count or as a % of
  that group's n (hover a number to see both).
  Each of the four numbers is its own click target: that code for that group and transition
  (clicking the code name opens group A, Pre→Post). ↑/↓ (or j/k) move between codes, ←/→ move
  between the four numbers.
- **Detail**: lists every participant of the chosen group who has the code in the chosen
  transition; buttons at the top switch to the code's other three numbers. Each card
  shows the answers for that transition side by side and each coder's note, with that code's
  highlights tinted per coder (stripes where coders overlap), plus notes from coders who didn't
  apply it. Clicking a participant scrolls to their card.
- **Coder comparison**: with no code selected, clicking a participant shows a table of every code
  each coder gave them in each transition, then for each question the original answers (with all
  coders' highlights; hover one to see the coder and code) and each coder's note per transition,
  with their highlights and codes. Click any code to open it.
- **Code summary**: one summary per code, transition *and group* (four per code), saved to
  `code_summary.json` as you type, e.g.
  `{"+training": {"theme": "…", "pre->post": {"A": {"summary": "…"}, "B": {…}}, "pre/post->delay-post": {…}}}`.
  The other group's summary for the same transition is shown below for comparison. A ✎ count next
  to a code, and an underline on a number, show which summaries exist. Summaries saved in an
  earlier format (without groups) are loaded into both groups.

## Quant analysis page

Open http://127.0.0.1:5001/quant (or **Quant ↗** on the analysis page). It has the same file
fields and defaults as the analysis page, and the two share what the server has loaded: loading
files on either page changes both. Same merging, `CODE_MERGES` and pattern-code rules.

It shows a code-by-code co-occurrence matrix: two codes co-occur when the same participant was
given both (by at least one coder each, in either question) in the same transition.

- Filters on the left (site, group, search); above the matrix, choose the transition
  (Pre→Post or →Delay-post), group (A, B or A + B), and codes (+/−/=, or + only: drops the
  − and = codes; pattern codes and proposals stay). N is the number of participants in that
  selection (for →Delay-post, only those with a delay-post answer).
- Cells show the count of participants given both codes, or (toggle) φ (phi, −1 to +1; blue
  positive, red negative) or Jaccard (both ÷ either). The diagonal is the number given each code.
  Codes nobody in the selection was given are hidden. Hover a cell for all the numbers.
- Exploratory only: no statistical tests.

Highlights on notes are anchored by offset and text, so they follow the excerpt if the note is
edited later; if the excerpt is deleted, the code is listed as "text no longer found".
