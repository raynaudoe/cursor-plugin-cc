# AGENTS.md — rules for any AI agent editing this repo

This file is the contract any agent (Claude Code, Cursor, Codex, …) must follow before touching code in `cursor-plugin-cc`. If you are human, read it too.

## What this repo is

A Claude Code plugin that uses the Cursor CLI (`cursor-agent`) for read-only reviews, two-model debates, and delegated rescue work. Eight slash commands under the `cursor:` namespace plus a `cursor-rescue` subagent are exposed. Source of truth lives under `plugins/cursor/`.

## Hard rules

1. **Zero runtime dependencies.** The plugin ships as plain ESM `.mjs` and must execute directly after `/plugin install` with zero `npm install` in the user's plugin cache. If you are about to add `execa`, `zod`, `nanoid`, a HTTP client, a command parser, or any other third-party runtime package — stop. Write a small inline helper instead. See `plugins/cursor/scripts/lib/run.mjs` as the reference pattern (it replaced `execa` in ~80 lines).
2. **No build step.** No TypeScript, no bundler, no `dist/`. `scripts/*.mjs` IS the ship artefact. If you find yourself wanting one, something has gone wrong with the approach.
3. **Slash command prompts live under `plugins/cursor/commands/<cmd>.md`.** Keep them as Codex-style prompt ports with Cursor-safe substitutions. Management commands should call `node "${CLAUDE_PLUGIN_ROOT}/scripts/cursor-companion.mjs" <subcommand> "$ARGUMENTS"` with quoted `$ARGUMENTS` — unquoted breaks under zsh on any prompt containing `?`, `*`, or `@`. `/cursor:rescue`, `/cursor:review`, `/cursor:adversarial-review`, and `/cursor:debate` are orchestration prompts: rescue routes through the `cursor-rescue` subagent, review commands choose foreground/background execution like the Codex plugin, and debate asks for model selection when needed before invoking the shared runtime.
4. **`Bash(node:*)` is the default permission pattern used in `allowed-tools`.** The allowed exceptions are `/cursor:rescue`, which may also use `AskUserQuestion` and `Agent`; `/cursor:debate`, which may also use `AskUserQuestion`; and `/cursor:review` plus `/cursor:adversarial-review`, which may use `Read`, `Glob`, `Grep`, `Bash(git:*)`, and `AskUserQuestion` to estimate review size before choosing foreground or background. Do not invent path-based patterns — Claude Code does not expand `${CLAUDE_PLUGIN_ROOT}` inside `allowed-tools`.
5. **Jobs are persisted under `~/.cursor-plugin-cc/jobs/<repo-hash>/`.** Never break that layout; users point scripts at those files when reporting bugs.
6. **Language: everything in this repo is English.** Code, comments, commit messages, docs, PR bodies, issue titles. The plugin does not impose a language policy on target repos — `cursor-rescue` reads target-repo conventions — but this repo itself is English-only.
7. **Do not impose conventions on target repos.** The `cursor-rescue` subagent reads `AGENTS.md` / `.cursor/rules` / existing code in whatever repo the user is working in and tells Cursor to match THAT style. When editing the subagent, do not hardcode English / Prettier / whatever.
8. **Do not advertise unsupported Codex-only controls.** Cursor prompts must not mention `--effort`, `spark`, Codex model ids, `--write`, Codex skills, npm-based Codex installation, or review-gate controls unless the Cursor runtime actually supports that behavior.

## Task format

Every delegated rescue task should use five sections in this order:

1. **Goal** — one sentence.
2. **Repo context** — stack + pointer to AGENTS.md / `.cursor/rules` / conventions file.
3. **Acceptance criteria** — 1–5 verifiable bullets.
4. **Files to touch** — explicit list when predictable.
5. **How to verify** — exact commands (`npm test`, `task typecheck`, etc.).

Plus a **Constraints** block that forbids: touching files outside the list, renaming public APIs, modifying lockfiles.

## How to make a change

1. Branch named `feat/…`, `fix/…`, `refactor/…`, or `docs/…`.
2. Work inside `plugins/cursor/`. `cd plugins/cursor && npm install` installs dev deps (vitest, eslint, prettier — the only ones).
3. Run tests: `npm test`. Run lint: `npm run lint`. Both must be green before committing.
4. Commit messages in conventional style (`type(scope): subject`).
5. Open a PR against `main` with a summary + test plan. CI must pass across Node 18.18 / 20 / 22 × Ubuntu / macOS.
6. Squash-merge only.

## Guardrails for automated edits

- Do not touch `package-lock.json` unless you are changing dependencies on purpose.
- Do not modify `~/.cursor-plugin-cc/jobs/**` — that is user state, never ours.
- Do not rename the command namespace (`cursor:`), install target (`cursor@cursor-plugin-cc`), or marketplace name (`cursor-plugin-cc`) without explicit user approval — all are referenced in user environments.
- When adding a new slash command, follow the recipe in `CONTRIBUTING.md`.

## Where things live

- `plugins/cursor/.claude-plugin/plugin.json` — the plugin manifest. Claude Code only discovers it here; a manifest at the plugin root fails `claude plugin validate` and its declared version is discarded.
- `plugins/cursor/scripts/<cmd>.mjs` — command entrypoints (8) and thin wrappers around `cursor-companion.mjs`.
- `plugins/cursor/scripts/cursor-companion.mjs` — unified runtime for setup, review, adversarial review, debate, rescue, status, result, cancel, and background workers.
- `plugins/cursor/scripts/session-lifecycle-hook.mjs` — SessionStart/SessionEnd handler: stamps jobs with the Claude session id and reaps them when the session ends.
- `plugins/cursor/scripts/lib/*.mjs` — shared helpers (run, id, args, paths, jobs, parse, cursor, git, invoked, md).
- `plugins/cursor/commands/*.md` — slash command wrappers.
- `plugins/cursor/agents/cursor-rescue.md` — the handoff subagent prompt.
- `plugins/cursor/skills/*/SKILL.md` — internal, non-user-invocable skills. `cursor-prompting` shapes the forwarded rescue prompt and is bound to the subagent; `cursor-result-handling` governs how the main thread presents Cursor output.
- `plugins/cursor/hooks/hooks.json` — SessionStart/SessionEnd registration. No stop-time review gate: rule 8 forbids advertising one until the Cursor runtime supports it.
- `plugins/cursor/tests/*.test.mjs` — vitest specs + fixtures.
- `.claude-plugin/marketplace.json` — what Claude Code's `/plugin install` reads.

If you are about to add a file outside these paths, justify it in the PR description.
