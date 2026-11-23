# Fast makefun-site drop-in

Entry for `site-generator-speed-01-run-20261122` — "Build a static site faster,
22 November 2026".

`solve.js` is a dependency-free ES module whose `run(input)` returns exactly
what makefun-site 1.0.0's `build` returns for the same input: the output tree
of a generated site (page HTML, index and tag pages, `build-report.txt`, and
every static file), byte for byte. `main.ts` is the harness driver: it reads
`/input/cases.json`, answers each case with `run`, and writes
`/output/answers.json`.

The implementation is written from scratch against the reference semantics
(front matter, template dialect, Markdown subset, slug rule, report). It is
not a copy of the reference program. Speed comes from:

- a single-pass Markdown renderer that batches plain text instead of escaping
  one character at a time, with index-based scans for span closers;
- a line lexer driven by first-character dispatch instead of a regex per line;
- front matter parsed by scanning line starts, so the body is sliced, never
  split and re-joined;
- template compilation to flat operation lists rendered into an output array,
  with loop frames reused across iterations;
- per-case caches for slugs and long dates, and cheap ASCII fast paths.

Nothing is cached from one case to the next; every case is answered alone, and
the program is fully deterministic.

## Layout

- `solve.js` — the fast generator (`run`)
- `main.ts` — the harness entrypoint
- `LICENSE` — MIT
