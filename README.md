# cursor-plugin-cc

Use Cursor CLI from Claude Code for reviews, two-model debates, and delegated rescue work.

This plugin follows the command shape of [`openai/codex-plugin-cc`](https://github.com/openai/codex-plugin-cc), adapted to `cursor-agent`. It ships as plain ESM JavaScript with zero runtime dependencies and no build step.

## Super Quick Start

Add the GitHub marketplace inside Claude Code. Claude accepts the `owner/repo` shorthand here:

```text
/plugin marketplace add raynaudoe/cursor-plugin-cc
/plugin install cursor@cursor-plugin-cc
/reload-plugins
/cursor:setup
```

Try the main flows:

```text
/cursor:review
/cursor:adversarial-review challenge the failure modes in this change
/cursor:debate should we add this API boundary?
/cursor:rescue investigate why the tests are failing
```

Manage background jobs:

```text
/cursor:status
/cursor:result
/cursor:cancel
```

Local checkout install:

```text
/plugin marketplace add /Users/you/path/to/cursor-plugin-cc
/plugin install cursor@cursor-plugin-cc
/reload-plugins
/cursor:setup
```

## Requirements

- Node.js 18.18 or later.
- `cursor-agent` on `PATH`.
- `cursor-agent login` completed at least once.

If setup reports Cursor is missing, install the CLI from <https://cursor.com/install>.

## Commands

| Command                      | What It Does                                                                                               | Common Examples                                                                                                                                                    |
| ---------------------------- | ---------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `/cursor:review`             | Read-only review of the current git work. Dirty trees use the working tree; clean trees use a branch diff. | `/cursor:review`<br>`/cursor:review --base main`<br>`/cursor:review --model opus --background`                                                                     |
| `/cursor:adversarial-review` | Read-only challenge review focused on risks, assumptions, and failure modes. Accepts focus text.           | `/cursor:adversarial-review`<br>`/cursor:adversarial-review --base main challenge the retry design`                                                                |
| `/cursor:debate`             | Two Cursor models debate an issue for up to 5 rounds and store a consensus report.                         | `/cursor:debate should we add this API boundary?`<br>`/cursor:debate --models gemini,composer --rounds 3 evaluate this architecture`                               |
| `/cursor:rescue`             | Delegate investigation, a fix request, or follow-up work to Cursor.                                        | `/cursor:rescue investigate why tests fail`<br>`/cursor:rescue --model composer fix the issue quickly`<br>`/cursor:rescue --background investigate the regression` |
| `/cursor:status`             | Show active and recent Cursor jobs for this repo.                                                          | `/cursor:status`<br>`/cursor:status <job-id> --wait`                                                                                                               |
| `/cursor:result`             | Show the stored final output for a finished job.                                                           | `/cursor:result`<br>`/cursor:result <job-id>`                                                                                                                      |
| `/cursor:cancel`             | Cancel an active Cursor job.                                                                               | `/cursor:cancel`<br>`/cursor:cancel <job-id>`                                                                                                                      |
| `/cursor:setup`              | Check Cursor CLI, auth, models, and configured MCPs.                                                       | `/cursor:setup`<br>`/cursor:setup --print-models`                                                                                                                  |

## Models

Pass `--model <id|alias>` to review, adversarial review, and rescue. Debate supports `--models a,b` or `--model-a <id> --model-b <id>`.

Useful aliases:

```text
composer
fast
opus
sonnet
gpt
gemini
grok
```

Raw Cursor model ids are passed through unchanged. Run `/cursor:setup --print-models` to see what your account exposes.

## Jobs

Background jobs are stored under:

```text
~/.cursor-plugin-cc/jobs/<repo-hash>/
```

Cursor runs through:

```text
# rescue (write-capable)
cursor-agent -p --output-format stream-json --stream-partial-output --trust --model <id> --force

# review, adversarial review, debate (read-only)
cursor-agent -p --output-format stream-json --stream-partial-output --trust --model <id> --mode ask
```

Reviews and debates are read-only at the CLI, not just by prompt contract: `--mode ask` blocks edits and `--force` is never passed, because it would override the mode. A post-flight check still runs on top, and if Cursor reports touching files during a read-only run the result says so explicitly.

`--mode ask` rather than `--mode plan` is deliberate, and verified against cursor-agent 2026.07.23. Both block writes, but plan mode delivers its answer as a `createPlanToolCall` payload and leaves the `result` event carrying only progress narration, so a review run that way comes back empty. `--sandbox enabled` is not an alternative: it governs command execution and still permits file writes. Note that no write-blocking mode allows shell, so read-only runs inspect changed files directly rather than running git.

Foreground runs stream progress to stderr as `[cursor] …` lines while Cursor works, so a long run stays visible instead of blocking silently. Those lines are progress, never results.

Jobs are stamped with the Claude Code session id, so `/cursor:status` shows this session's work rather than every job ever recorded for the repository. When the session ends, any still-running Cursor job is reaped rather than left orphaned.

A single run is capped at **480 seconds** by default. Override it with `--timeout <seconds>` on any command. The default is deliberately below the Claude Code Bash tool's 600 s ceiling so the runtime hits its own watchdog and still has time to render a result, rather than the tool call being killed first and the delegation turning into a detached shell.

Because no write-blocking mode allows shell, a review whose diff is too large to inline is written to a file under `~/.cursor-plugin-cc/jobs/<repo-hash>/logs/` and the prompt points Cursor at it. Without that, a review of three or more files would see file names and current contents but never the base versions.

Job records, raw stream logs and those diff files are pruned after **30 days** when a Claude Code session ends. A large review diff can be ~100 KB, so without pruning the directory would grow for the lifetime of the machine. Anything newer than the cutoff is kept, and a job cancelled during shutdown is always kept because that write refreshes it.

## Development

```bash
cd plugins/cursor
npm install
npm test
npm run lint
```

The npm dependencies are dev-only test and lint tooling. The installed plugin itself has zero runtime dependencies.
