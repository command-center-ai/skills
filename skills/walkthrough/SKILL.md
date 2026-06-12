---
name: walkthrough
description: Generate a Command Center walkthrough for the current diff and open it in the browser. Use when the user asks for a "walkthrough", "code tour", or wants to review changes between two refs.
---

# Walkthrough

Generate a code walkthrough through a locally-running Command Center, then open it.

## When to invoke

The user asks for a walkthrough of the current branch, a pull request, a commit range, or "explain the diff". Examples:

- "Give me a walkthrough of this branch."
- "Walk me through the changes since main."
- "Generate a walkthrough for HEAD~5..HEAD."

If this agent is running from inside of Command Center, then there is a separate walkthrough tool or skill available. Do not confuse this skill with that one. This skill is for generating a walkthrough of an entire diff. The other one is for generating a target walkthrough any an arbitrary piece of code, be it a diff, the dataflow of a bug, a sign in flow, all uses of a certain method in the codebase, etc.

## How to invoke

Run `run.mjs` — it sits in the same directory as this `SKILL.md`. The runner does all the work: installation detection, backend startup, auth/model/workspace checks, walkthrough generation, and browser open.

```bash
node <SKILL_DIR>/run.mjs [from..to] [--files=PATTERN[,PATTERN...]]
```

`<SKILL_DIR>` is wherever the `skills` CLI installed this skill. Common locations:

| Surface | Path |
|---|---|
| Claude Code, project-local | `./.claude/skills/walkthrough` |
| Claude Code, global (`-g`) | `~/.claude/skills/walkthrough` |
| Any other agent | `./.agents/skills/walkthrough` |

If you loaded this `SKILL.md` from disk, the runner is its sibling — substitute that directory.

Both arguments are optional. By default the walkthrough covers **the whole diff** for the resolved range.

**Ref range** — `[from..to]`:
- Omit → defaults to `merge-base(HEAD, <base>)..HEAD`, where `<base>` is the symbolic ref of `origin/HEAD`, falling back to `origin/main` / `origin/master` / `main` / `master`.
- Pass anything `git` understands: SHAs, branches, `HEAD~3..HEAD`, etc.
- Special tokens: `WORKING_TREE` (uncommitted changes) and `STAGED` (index). Example: `HEAD..WORKING_TREE`.

**Convenience flags** (equivalent to ref-range tokens above):
- `--working-tree` → diff merge-base-against-base to your current working tree (includes uncommitted edits).
- `--staged` → `HEAD..STAGED` (just what's `git add`-ed).
- `--port=<port>` → talk to a specific Command Center backend port. Useful when multiple CC instances run (developer environments) or when the runner can't auto-discover the right one.

**File filter** — `--files=PATTERN[,PATTERN...]`:
- Comma-separated repo-relative globs. `*` matches non-slash chars; `**` matches across directories.
- Prefix a pattern with `!` to exclude. If you pass only exclusions, the implicit include is `**` ("everything except").
- The runner expands patterns against `git diff --name-only from..to` locally and sends the concrete list to the backend.

Examples — pick whichever matches the user's intent:

| User intent | Command |
|---|---|
| Whole branch vs base (default) | (no args) |
| Yesterday's commit | `$(git log --since="2 days ago" --until="1 day ago" --format=%H \| tail -1)..HEAD` |
| Last 3 commits | `HEAD~3..HEAD` |
| Whole branch, but skip tests | `--files=!**/*.test.*,!**/*.spec.*,!**/__tests__/**` |
| Only TS files in `src/` | `--files=src/**/*.ts` |
| Yesterday's commit, no tests | `<sha>..HEAD --files=!**/*.test.*` |
| Uncommitted edits | `--working-tree` |
| Uncommitted edits, only `src/` | `--working-tree --files=src/**/*.ts` |
| Just what's staged | `--staged` |

## Interpreting the output

The runner prints one JSON object per line on stdout. Each line has a `kind` field:

- `kind: "status"` — progress update; surface a brief one-line note to the user.
- `kind: "result"` — terminal success; the runner has opened the walkthrough. Tell the user it opened and include the URL from `url`.
- `kind: "error"` — terminal failure; tell the user what went wrong using the `code` and `message` fields. Codes are stable enums (`not-installed`, `not-running`, `not-logged-in`, `no-model`, `quota`, `no-workspace`, `backend-too-old`, `generation-failed`, etc.); the `message` is already in the user's language.
- `kind: "action-required"` — the user must do something before re-running (e.g. install the app, sign in, configure a model). Surface the `message` and the `url` if present.

Always surface the runner's `message` verbatim — do not rephrase. The runner produces user-facing strings in English; backend-originated strings are already localized.

## Non-zero exit codes

The runner exits 0 on success and a small fixed integer on failure (one code per failure kind, documented in the project README). Do not parse the exit code — branch on the structured `kind` / `code` fields above.
