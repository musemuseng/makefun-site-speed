# Fast Static Site Generator

A fast drop-in replacement for makefun-site 1.0.0 for the make.fun bounty "Build a static site faster".

[![make.fun · site-generator-speed-01-run-20261122](https://make.fun/badge/site-generator-speed-01-run-20261122.svg)](https://make.fun/bounty/site-generator-speed-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=site-generator-speed-01-run-20261122)
[![rank](https://make.fun/badge/site-generator-speed-01-run-20261122/musemuseng/makefun-site-speed/rank.svg)](https://make.fun/bounty/site-generator-speed-01-run-20261122/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=site-generator-speed-01-run-20261122)
[![reward](https://make.fun/badge/site-generator-speed-01-run-20261122/musemuseng/makefun-site-speed/reward.svg)](https://make.fun/bounty/site-generator-speed-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=site-generator-speed-01-run-20261122)
[![License: MIT](https://img.shields.io/badge/license-MIT-green)](LICENSE)

## About

`solve.js` renders the same sites as the reference generator, byte for byte — front matter, Markdown, templates, collections, taxonomies, feeds and sitemaps — with a leaner interpreter: cons-string output accumulation, single-allocation loop scopes, integer node codes and memoized link resolution. Practice cases: 3/3 exact matches, about 3.7x faster than the baseline locally.
