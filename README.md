# Command Center Skills

Public skills for [Command Center](https://commandcenter.ai), usable from Claude Code, Codex, and any agent supported by the [`skills`](https://www.npmjs.com/package/skills) CLI.

| Skill | What it does |
|---|---|
| `walkthrough` | Generate a Command Center walkthrough for the current diff and open it in the browser. |

## Install

```
npx skills add up-to-speed/skills
```

Add `--skill walkthrough` to install just one skill, `-g` for a global (user-wide) install, or `-a <agent>` to target a specific agent. See the [skills CLI docs](https://www.npmjs.com/package/skills) for the full option list and the supported-agent matrix.

## License

MIT — see [LICENSE](./LICENSE).
