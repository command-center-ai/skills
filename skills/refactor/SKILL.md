---
name: refactor
description: Run a Command Center AI refactoring over the current diff. The refactoring runs inside Command Center and edits the working tree. Use when the user asks to "refactor with Command Center", "run the refactoring agent", "clean up / deduplicate these changes", or similar.
---

# Refactor

Run Command Center's refactoring agent over a diff. Command Center plans the refactoring, spawns its own coding-agent sessions to apply it, and leaves the result as **uncommitted edits in the working tree**.

## When to invoke

The user asks to refactor recent changes using Command Center — the current branch, a commit range, or uncommitted work. Examples:

- "Refactor this branch with Command Center."
- "Run the Command Center refactoring agent on my changes."
- "Deduplicate the code I just wrote using CC."

## Before invoking — important

1. **The refactoring edits the working tree.** Do not edit files in the repo while the runner is waiting, and re-read any files you have cached once it finishes (the result lists exactly which files are dirty).
2. **Prefer a committed baseline.** If there is meaningful uncommitted work, suggest committing it first so the refactoring is cleanly reviewable (and revertible) as `git diff`. Not a hard requirement — `--working-tree` exists for refactoring uncommitted changes deliberately.
3. **It takes a while.** Typically minutes, up to tens of minutes for large diffs. Run it in the background if your harness supports that, and surface the runner's progress lines to the user.

## How to invoke

Run `run.mjs` — it sits in the same directory as this `SKILL.md`. The runner does all the work: installation detection, backend startup, auth/model/agent checks, file screening, kicking off the refactoring, and streaming progress until it finishes.

```bash
node <SKILL_DIR>/run.mjs [from..to] [--workflow=do-it-all|de-duplicate] [--files=PATTERN[,PATTERN...]]
```

`<SKILL_DIR>` is wherever the `skills` CLI installed this skill. Common locations:

| Surface | Path |
|---|---|
| Claude Code, project-local | `./.claude/skills/refactor` |
| Claude Code, global (`-g`) | `~/.claude/skills/refactor` |
| Any other agent | `./.agents/skills/refactor` |

If you loaded this `SKILL.md` from disk, the runner is its sibling — substitute that directory.

All arguments are optional. By default the runner refactors **every changed file** in the resolved range.

**Ref range** — `[from..to]`:
- Omit → defaults to `merge-base(HEAD, <base>)..HEAD`, where `<base>` is the symbolic ref of `origin/HEAD`, falling back to `origin/main` / `origin/master` / `main` / `master`.
- Pass anything `git` understands: SHAs, branches, `HEAD~3..HEAD`, etc.
- Special tokens: `WORKING_TREE` (uncommitted changes) and `STAGED` (index). Example: `HEAD..WORKING_TREE`.

**Workflow** — `--workflow=`:
- `do-it-all` (default) — the full refactoring pass Command Center's own Refactor button runs.
- `de-duplicate` — focused pass that only merges duplicated code.

**Convenience flags**:
- `--working-tree` → refactor the diff from the merge base to your current working tree (includes uncommitted edits).
- `--staged` → refactor just what's `git add`-ed.
- `--files=PATTERN[,PATTERN...]` → narrow to a subset of the changed files. Comma-separated repo-relative globs; `*` matches non-slash chars, `**` crosses directories, a `!` prefix excludes. If you pass only exclusions, the implicit include is `**`.
- `--timeout-mins=<n>` → how long to wait for the refactoring to finish (default 60). On timeout the refactoring keeps running in Command Center.
- `--port=<port>` → talk to a specific Command Center backend port. Useful when multiple CC instances run (developer environments) or when the runner can't auto-discover the right one.

Note: Command Center additionally screens the file list down to reasonably-sized code files — lockfiles, generated files, and very large files are skipped automatically.

Examples — pick whichever matches the user's intent:

| User intent | Command |
|---|---|
| Whole branch vs base (default) | (no args) |
| Last 3 commits | `HEAD~3..HEAD` |
| Uncommitted edits | `--working-tree` |
| Just deduplicate the branch | `--workflow=de-duplicate` |
| Whole branch, but skip tests | `--files=!**/*.test.*,!**/*.spec.*,!**/__tests__/**` |
| Only TS files in `src/` | `--files=src/**/*.ts` |

## Interpreting the output

The runner prints one JSON object per line on stdout. Each line has a `kind` field:

- `kind: "status"` — progress update (including `percentageDone` while refactoring); surface a brief one-line note to the user.
- `kind: "result"` — terminal success. The refactored code is now **uncommitted in the working tree**. The payload includes `dirtyFiles` (re-read these before further edits), `filesSubmitted`, and the Command Center `sessionId` whose session contains per-change explanations. Tell the user it finished and suggest reviewing with `git diff`.
- `kind: "error"` — terminal failure; tell the user what went wrong using the `code` and `message` fields. Codes are stable enums (`not-installed`, `not-running`, `not-logged-in`, `no-model`, `no-agent`, `quota`, `no-workspace`, `no-files-matched`, `no-eligible-files`, `backend-too-old`, `refactoring-failed`, `refactoring-cancelled`, etc.); the `message` is already in the user's language.
- `kind: "action-required"` — the user must do something before re-running (e.g. install the app, sign in, configure a model or coding agent). Surface the `message` and the `url` if present.

Always surface the runner's `message` verbatim — do not rephrase. The runner produces user-facing strings in English; backend-originated strings are already localized.

After a successful run, review the diff before relying on it: the refactoring is AI-generated. If the user dislikes the result, `git checkout -- <files>` (or `git stash`) reverts it, since nothing was committed.

## Cancellation

Killing the runner (SIGINT/SIGTERM) sends a best-effort cancel to Command Center so the refactoring doesn't keep editing files after you've moved on. The refactoring can also be cancelled from the Command Center app.

## Non-zero exit codes

The runner exits 0 on success and a small fixed integer on failure (one code per failure kind). Do not parse the exit code — branch on the structured `kind` / `code` fields above.
