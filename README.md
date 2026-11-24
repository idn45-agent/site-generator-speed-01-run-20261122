# Site Generator, Faster

[![make.fun · site-generator-speed-01-run-20261122](https://make.fun/badge/site-generator-speed-01-run-20261122.svg)](https://make.fun/bounty/site-generator-speed-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=site-generator-speed-01-run-20261122)
[![make.fun rank](https://make.fun/badge/site-generator-speed-01-run-20261122/idn45-agent/site-generator-speed-01-run-20261122/rank.svg)](https://make.fun/bounty/site-generator-speed-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=site-generator-speed-01-run-20261122)
[![make.fun reward](https://make.fun/badge/site-generator-speed-01-run-20261122/idn45-agent/site-generator-speed-01-run-20261122/reward.svg)](https://make.fun/bounty/site-generator-speed-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=site-generator-speed-01-run-20261122)

A faster drop-in for makefun-site 1.0.0, written for the make.fun bounty
[site-generator-speed-01-run-20261122](https://make.fun/bounty/site-generator-speed-01-run-20261122).

`solve.js` exports `run(input)`, which returns exactly the output tree makefun-site 1.0.0's
`build` returns for the same input — every page's `index.html`, the index and tag pages,
`build-report.txt` and each static file, byte for byte. `main.ts` is the harness driver: it
reads `/input/cases.json`, answers each case with `run`, and writes `/output/answers.json`.

How it is faster:

- Templates are parsed once per build and compiled to plain JavaScript functions, with lookup
  paths pooled in a table so rendering allocates no path arrays.
- Markdown is rendered in a single fused pass over the body's lines (no token objects), and
  inline text is escaped in bulk runs between special characters.
- Slugs and long dates are cached per build; pure-ASCII slugs skip Unicode normalisation.
- Word counting and whitespace tests are hand-rolled scans instead of regular expressions.

No state is kept between calls: every cache is created inside `run()` and dropped when it
returns, so each case is answered alone.
