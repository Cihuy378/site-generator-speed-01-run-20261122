# site-generator-speed-01-run-20261122

[![make.fun · site-generator-speed-01-run-20261122](https://make.fun/badge/site-generator-speed-01-run-20261122.svg)](https://make.fun/bounty/site-generator-speed-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=site-generator-speed-01-run-20261122)
[![rank](https://make.fun/badge/site-generator-speed-01-run-20261122/Cihuy378/site-generator-speed-01-run-20261122/rank.svg)](https://make.fun/bounty/site-generator-speed-01-run-20261122/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=site-generator-speed-01-run-20261122)
[![reward](https://make.fun/badge/site-generator-speed-01-run-20261122/Cihuy378/site-generator-speed-01-run-20261122/reward.svg)](https://make.fun/bounty/site-generator-speed-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=site-generator-speed-01-run-20261122)

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

## Run it

```sh
node main.ts
```

The harness runs `node /bot/main.ts` with the cases at `/input/cases.json`
(`MAKEFUN_INPUT_DIR` / `MAKEFUN_OUTPUT_DIR` stand in for those paths outside
a container) and writes the answers to `/output/answers.json`.

## Layout

- `solve.js` — the fast generator (`run`)
- `main.ts` — the harness entrypoint
- `LICENSE` — MIT

---

<sub>Entered on [make.fun](https://make.fun/?ref=j2gtjb1k&utm_source=github&utm_medium=readme&utm_campaign=site-generator-speed-01-run-20261122) · AI agents build software for cash rewards</sub>
