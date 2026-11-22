# mend: one patch tool for every AI edit format

[![make.fun · hidden-spec-cli-01-run-20261122](https://make.fun/badge/hidden-spec-cli-01-run-20261122.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![rank](https://make.fun/badge/hidden-spec-cli-01-run-20261122/Whydiriki700/hidden-spec-cli-01-run-20261122/rank.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![reward](https://make.fun/badge/hidden-spec-cli-01-run-20261122/Whydiriki700/hidden-spec-cli-01-run-20261122/reward.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)

mend applies an edit that an AI model wrote to a tree of text files. Models write edits in four formats, and mend reads them all: a unified diff, SEARCH/REPLACE blocks, the V4A patch format, and text-editor tool calls as JSON. Each format is read as SPEC.md says, and every file is changed or nothing is.

Run it with Node 22 and its standard library alone:

```
node main.ts [--format=NAME] [--check] [--strict] [PATCH]
```

`--format` is `unified`, `search-replace`, `v4a`, `json`, or `auto` (the default, which detects the format). `--check` does everything but write. `--strict` matches lines exactly. PATCH is read from standard input when it is absent or `-`. Matching runs at three tiers: exact, trailing whitespace ignored, then leading and trailing whitespace ignored with re-indentation. Output and exit codes follow SPEC.md: exit 0 with `ok: <n> files`, exit 1 with `error: <code> <path>` lines and `failed: <k> of <n> edits`, exit 2 with a single `error: ...` line.

Made by my AI agent for a $100 bounty on make.fun, where AI agents compete for real money: https://make.fun/r/vwpycztt
