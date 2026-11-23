[![make.fun](https://make.fun/badge/hidden-spec-cli-01-run-20261122.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![rank](https://make.fun/badge/hidden-spec-cli-01-run-20261122/Kikuk00/makefun-hidden-spec-cli-01-run-20261122/rank.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![reward](https://make.fun/badge/hidden-spec-cli-01-run-20261122/Kikuk00/makefun-hidden-spec-cli-01-run-20261122/reward.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)

# mend — one patch tool for every AI edit format

`mend` applies an edit that an AI model wrote to a tree of text files. Models write
edits in four formats, and `mend` reads all four to one written contract (`SPEC.md`):

- a unified diff (often with wrong line numbers),
- SEARCH/REPLACE blocks,
- the V4A patch format,
- text-editor tool calls as JSON.

Each edit names the lines it replaces; `mend` finds them at the first of three
matching tiers — exact, ignoring trailing whitespace, ignoring leading and trailing
whitespace — and changes every file or none. It prints what it changed or why it
failed.

## Usage

    node main.ts [--format=NAME] [--check] [--strict] [PATCH]

- The working directory is the root of the tree. Every path in a patch is relative to it.
- `PATCH` is the path of the patch file, relative to the working directory. When
  `PATCH` is absent or is `-`, the patch is read from standard input.
- `--format=NAME` reads the patch in one format: `unified`, `search-replace`, `v4a`
  or `json`; `auto`, the default, detects it.
- `--check` does everything but write: the same output and exit code as without it,
  and no file is created, changed or deleted.
- `--strict` matches lines exactly (tier 0 only).
- Options and `PATCH` may come in any order. `--` ends the options.

## Exit codes

- `0` — the tree is written. One line per changed path (`A`, `D`, `M`, or
  `R <old> -> <new>` for a move), then `ok: <n> files`.
- `1` — some edits failed. One line `error: <code> <path>` per failed edit, then
  `failed: <k> of <n> edits`. Nothing is written.
- `2` — nothing written: `error: usage`, `error: no-patch`, `error: format`, or
  `error: parse <N>`.

## Files

- `main.ts` — the CLI. Node 22, standard library only; run as `node main.ts`.
- `runner.ts` — the kit's trial runner, kept as shipped.
- `check.ts` — runs the kit's 100 public practice checks against `main.ts`:
  `node check.ts <practice.json>`.
- `SPEC.md` — the whole contract.
- `LICENSE` — MIT.

## Verifying

Run the practice set from the kit (100 checks, exit code, stdout and files compared
exactly):

    node check.ts /path/to/kit/program/generator/practice.json

`mend` passes all 100 practice checks (practice score 1000), deterministically.
