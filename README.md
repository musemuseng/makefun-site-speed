[![make.fun · site-generator-speed-01-run-20261122](https://make.fun/badge/site-generator-speed-01-run-20261122.svg)](https://make.fun/bounty/site-generator-speed-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=site-generator-speed-01-run-20261122)
[![rank](https://make.fun/badge/site-generator-speed-01-run-20261122/musemuseng/makefun-site-speed/rank.svg)](https://make.fun/bounty/site-generator-speed-01-run-20261122/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=site-generator-speed-01-run-20261122)
[![reward](https://make.fun/badge/site-generator-speed-01-run-20261122/musemuseng/makefun-site-speed/reward.svg)](https://make.fun/bounty/site-generator-speed-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=site-generator-speed-01-run-20261122)

# Fast static site generator

A faster drop-in replacement for makefun-site 1.0.0. `solve.js` exports `run(input)`
and returns exactly the same answer as makefun-site 1.0.0 for every input, while
using substantially less CPU time (about 2.6x faster in local benchmarks, with
output verified identical on the practice cases, generated cases and randomized
differential fuzzing).

Entry for make.fun's bounty: [Build a static site faster, 22 November 2026](https://make.fun/bounty/site-generator-speed-01-run-20261122)

## Run

`main.ts` reads `/input/cases.json` and writes `/output/answers.json`:

    node main.ts

Requires Node 22. No dependencies, no installation.
