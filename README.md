# cursor-plugin-cc

Use Cursor CLI from inside Claude Code for code reviews or to delegate rescue work to Cursor.

This plugin follows the command shape of [`openai/codex-plugin-cc`](https://github.com/openai/codex-plugin-cc), adapted to `cursor-agent`.

## What You Get

- `/cursor:review` for a normal read-only Cursor review.
- `/cursor:adversarial-review` for a steerable challenge review.
- `/cursor:rescue`, `/cursor:status`, `/cursor:result`, and `/cursor:cancel` to delegate work and manage background jobs.
- `/cursor:setup` to check whether Cursor CLI is installed and authenticated.

The plugin ships as plain ESM JavaScript with zero runtime dependencies. Claude Code runs `scripts/*.mjs` directly after `/plugin install`; no build step or runtime `npm install` is required.

## Requirements

- Node.js 18.18 or later.
- `cursor-agent` on `PATH`.
- `cursor-agent login` completed at least once, or another Cursor CLI auth method supported by your environment.

## Install

Preferred, from GitHub:

```text
/plugin marketplace add raynaudoe/cursor-plugin-cc
/plugin install cursor@tomas-cursor
/reload-plugins
/cursor:setup
```

Local checkout:

```text
/plugin marketplace add /Users/you/path/to/cursor-plugin-cc
/plugin install cursor@tomas-cursor
/reload-plugins
/cursor:setup
```

## Usage

### `/cursor:review`

Runs a normal read-only review on your current work.

By default, dirty working trees are reviewed as uncommitted changes. Clean trees fall back to a branch diff against the detected default branch. Use `--base <ref>` for an explicit branch review.

Examples:

```text
/cursor:review
/cursor:review --base main
/cursor:review --model opus --background
```

This command does not take custom focus text. Use `/cursor:adversarial-review` when you want to challenge a design choice or risk area.

### `/cursor:adversarial-review`

Runs a read-only review that questions the implementation approach, tradeoffs, assumptions, and failure modes.

It uses the same target selection as `/cursor:review`, including `--base <ref>` and `--scope auto|working-tree|branch`. Unlike `/cursor:review`, it accepts focus text after the flags.

Examples:

```text
/cursor:adversarial-review
/cursor:adversarial-review --base main challenge whether this retry design is safe
/cursor:adversarial-review --model gpt --background look for race conditions
```

### `/cursor:rescue`

Delegates investigation, a fix request, or a follow-up task to Cursor.

Examples:

```text
/cursor:rescue investigate why the tests started failing
/cursor:rescue fix the failing test with the smallest safe patch
/cursor:rescue --resume apply the top fix from the last run
/cursor:rescue --model composer fix the issue quickly
/cursor:rescue --background investigate the regression
```

Model aliases are the same as the existing Cursor integration: `composer`/`fast`, `opus`, `sonnet`, `gpt`, `gemini`, `grok`, and any raw Cursor model id.

### `/cursor:status`

Shows active and recent Cursor jobs for the current repository.

```text
/cursor:status
/cursor:status <job-id>
/cursor:status <job-id> --wait
```

The status report includes job kind, status, phase, elapsed time, Cursor chat id, summary, and follow-up actions.

### `/cursor:result`

Shows the stored final output for a finished Cursor job.

```text
/cursor:result
/cursor:result <job-id>
```

When available, it includes the Cursor chat id and a `cursor-agent --resume=<chat-id>` command.

### `/cursor:cancel`

Cancels an active Cursor job.

```text
/cursor:cancel
/cursor:cancel <job-id>
```

With no id, it cancels the single active job. If multiple jobs are active, pass an explicit id.

### `/cursor:setup`

Checks whether the local Cursor CLI is ready.

```text
/cursor:setup
/cursor:setup --print-models
```

If Cursor is missing, install it from <https://cursor.com/install>. If Cursor is installed but not authenticated, run `cursor-agent login`.

## How It Works

The plugin stores job records under:

```text
~/.cursor-plugin-cc/jobs/<repo-hash>/
```

Cursor still runs through:

```text
cursor-agent -p --output-format stream-json --trust --model <id>
```

Reviews are guarded as read-only by prompt contract and post-flight checks: if a review run writes files, the job is marked failed and the result tells you which files were touched.

## Development

```bash
cd plugins/cursor
npm install
npm test
npm run lint
```

The shipped plugin has zero runtime dependencies. The npm dependencies are dev-only test and lint tooling.
