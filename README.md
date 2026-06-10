# Command Center Skills

Public skills for [Command Center](https://up-to-speed.ai), usable from Claude Code, Codex, and any agent supported by the [`skills`](https://www.npmjs.com/package/skills) CLI.

| Skill | What it does |
|---|---|
| `walkthrough` | Generate a Command Center walkthrough for the current diff and open it in the browser. |
| `refactor` | Run a Command Center AI refactoring over the current diff; the result lands as uncommitted edits in the working tree. |

## Install

```
npx skills add command-center-ai/skills
```

Add `-g` for a global (user-wide) install or `-a <agent>` to target a specific agent. See the [skills CLI docs](https://www.npmjs.com/package/skills) for the full option list and the supported-agent matrix.

## Development

Shared Command Center plumbing (backend discovery/launch, auth, tRPC client, git helpers) lives in `lib/cc-skill-lib.mjs`. Each skill directory carries a vendored copy of it, because the `skills` CLI installs skill directories standalone — a relative import outside the skill dir would break after installation, and symlinks don't survive git checkouts on Windows.

Edit `lib/cc-skill-lib.mjs` (never the copies), then run:

```
npm run sync-lib
```

`npm run check` (run in CI) fails if the vendored copies drift from the source or any `.mjs` file doesn't parse. `test/mock-backend.mjs` speaks the backend's wire protocol for exercising runners end-to-end without a real Command Center.

## License

MIT — see [LICENSE](./LICENSE).
