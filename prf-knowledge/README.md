# Qualitative Coding UI

A small local web app for qualitative coding of `sample.csv`: select portions of each row's `Text` and tag them as `Model`, `Apply`, `Both`, or `Neither`, leave an optional comment per row, and save back out to the CSV.

## Setup

```
pip install -r requirements.txt
```

## Run

```
python3 app.py
```

Then open `http://localhost:5050`.

## Usage

- Pick a row from the left sidebar. The ✓/⚠ icon shows whether every non-whitespace character in that row's text has been coded.
- Drag-select a range of text, then either click one of the `Model`/`Apply`/`Both`/`Neither` buttons or press `1`-`4`. Press `0`, `Backspace`, or `Delete` to clear the code from the current selection.
- A code can cover multiple, non-adjacent parts of the text — just make another selection and click the same code button again.
- Add an optional comment for the row in the text box below it.
- Click **Save to CSV** to write everything back to `sample.csv`.

## Using your own CSV

To code a different dataset, replace `sample.csv` with your own file using the same columns: `ID,Setting,Time,Text,Model,Apply,Both,Neither,Comment` (leave `Model`/`Apply`/`Both`/`Neither`/`Comment` empty for uncoded rows).

### Chunk delimiters

When a code covers multiple non-adjacent parts of the text, they can be delimited by spaces or semicolons (or mixed):
- `Model: "Hello name still"` → three chunks: *Hello*, *name*, *still*
- `Model: "Hello; name; still;"` → three chunks: *Hello*, *name*, *still* (same result)
- `Model: "Hello name; still"` → three chunks: *Hello*, *name*, *still* (mixed delimiters work too)

**Smart handling of semicolons in text:** If the original `Text` contains semicolons, only spaces are treated as chunk delimiters to avoid ambiguity. For example, if `Text` is `"Hello; my name is still Lisa"` (contains a semicolon), then `Model: "Hello my name"` (space-delimited) will correctly reconstruct as three chunks (*Hello*, *my*, *name*); semicolons in the cell value are ignored in this case.

### Sidecar caching

The app keeps a sidecar file, `sample.csv.spans.json`, alongside the CSV — it caches the exact byte offsets of each highlight so reloading the page restores your work pixel-perfectly, and avoids all parsing ambiguities. When you click **Save to CSV**, a fresh sidecar is written.

If you paste in a CSV with no matching sidecar (the normal case the first time you use a file), the app reconstructs approximate highlights from whatever's in the `Model`/`Apply`/`Both`/`Neither` columns using the delimiter rules above — exact for clean, hand-typed example data; best-effort if words repeat in a row. Don't hand-edit `sample.csv.spans.json` directly; it's safe to delete if you want to discard the cache and let the app re-derive highlights from the CSV on next load.
