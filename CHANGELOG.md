# Changelog

All notable changes to this project will be documented in this file.
The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/)
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## 0.4.0 - 2026-07-26

Read-only reviews, session lifecycle, subagent parity.

### Fixed

- **Reviews and debates are now genuinely read-only.** `/cursor:review`, `/cursor:adversarial-review`, and `/cursor:debate` previously ran `cursor-agent --trust --force`, ie. fully write-capable, while their prompts promised read-only. They now pass `--mode ask` and never `--force`. Verified against cursor-agent 2026.07.23: `--mode plan` also blocks writes but returns its answer as a `createPlanToolCall` payload, leaving the run's `result` event with progress narration only, and `--sandbox enabled` still permits writes.
- **Read-only reviews can see the diff again.** A review touching more than two files omitted the raw diff and told Cursor to inspect the changes itself, which is impossible without shell. The full diff is now written next to the job logs and the prompt points at it, so the agent reads it with its file tool.
- **`/cursor:cancel` no longer orphans `cursor-agent`.** Cancellation signalled a single pid and never the process group, so the shell commands `cursor-agent` spawns survived. It now group-signals, with a Windows `taskkill /T` path, and never group-signals a foreground pid.
- **Removed a broadcast-kill hazard.** A failed worker spawn persisted `pid: -1`, and `process.kill(-1, …)` signals every process the user owns. Every kill site now requires a positive integer pid.
- **Background rescue returns Cursor's answer.** `status --wait` rendered job metadata but never `resultText`, and gave up after 240 s against a longer run.
- **Successful jobs are no longer marked failed.** Advisory warnings and the runtime's own post-result reap flipped completed runs to `failed`.
- **Fixed nine model aliases** that pointed at ids `cursor-agent` does not expose. Grok is namespaced `cursor-grok-4.5-*`, and `grok-4.5-xhigh` is not a real tier.
- Bare `--timeout` armed a 1-second watchdog; `resumeLatest` used a bare `--resume` that swallowed the prompt; `findings: [null]` crashed structured-review rendering; a throw after a job went `running` left it active forever.

### Added

- **Session lifecycle hooks.** `SessionStart` stamps jobs with the Claude session id and `SessionEnd` reaps anything still running, escalating to SIGKILL. Previously detached workers outlived Claude Code, and `/cursor:status` listed every job ever recorded for the repository.
- **Live progress.** Foreground runs stream `[cursor] …` to stderr while Cursor works. stdout stays the verbatim payload and `--json` suppresses the feed.
- **Two internal skills**, `cursor-prompting` and `cursor-result-handling`.
- **Job state is now pruned.** `SessionEnd` removes job records, stream logs and review diff files older than 30 days. Nothing previously deleted any of it, and the new diff files are ~100 KB each for a large review, so the directory grew without bound.

### Changed

- **Default run watchdog is now 480 s (was 1800 s).** Override with `--timeout <seconds>`. The old default outlived the Claude Code Bash tool budget, which turned a foreground delegation into a backgrounded shell. The budget is now ordered 480 s watchdog < 570 s Bash timeout < 600 s tool ceiling.
- **Plugin manifest moved to `plugins/cursor/.claude-plugin/plugin.json`.** Claude Code only discovers it there; at the plugin root `claude plugin validate` exits 1 and the declared version is discarded.
- **Public command surface now matches the Codex companion shape plus Cursor debate.** The exposed commands are `/cursor:review`, `/cursor:adversarial-review`, `/cursor:debate`, `/cursor:rescue`, `/cursor:status`, `/cursor:result`, `/cursor:cancel`, and `/cursor:setup`.
- **Added `/cursor:debate`.** The new command runs a read-only two-model Cursor consensus debate with model alias resolution, up to 5 rounds, early consensus stopping, background job support, and stored transcript results.
- **Slash command prompts now mirror the Codex plugin style.** Prompt markdown is ported from the upstream command shape with Cursor-safe substitutions and without unsupported Codex-only controls.
- **`/cursor:rescue` now routes through the `cursor-rescue` subagent.** This matches the Codex plugin pattern while keeping status/result/cancel/setup as direct companion-runtime calls.
- **`/cursor:review` and `/cursor:adversarial-review` now use Codex-style command orchestration.** They stay out of the subagent path but can ask whether to wait or launch a Claude Code background task when the user does not pass `--wait` or `--background`.
- **`cursor-rescue` now follows Codex-style background selection.** Small bounded rescues prefer foreground; complicated, open-ended, or long-running rescues may prefer background when no explicit mode is supplied.
- **Cursor jobs now use Codex-style tracking and rendering.** A new `cursor-companion.mjs` runtime handles rescue tasks, reviews, background workers, status, result, and cancellation while preserving the existing `~/.cursor-plugin-cc/jobs/<repo-hash>/` layout.
- **Stored Cursor results are no longer capped at 4000 characters.** Long foreground output and `/cursor:result` now preserve the full final Cursor message captured from `cursor-agent`.
- **Marketplace identity is now generic.** The marketplace name is `cursor-plugin-cc`, so local and GitHub installs use `cursor@cursor-plugin-cc` while preserving the `/cursor:*` command namespace.
- **Visible project metadata now uses company attribution.** User-facing docs and plugin manifests refer to `ez`.

### Removed

- Removed stale pre-Codex-style command wrappers, scripts, tests, fixtures, and helper modules that were no longer part of the current runtime.
- Removed stale personal or invalid GitHub-owner references from live docs and plugin metadata.

## Previous History

Earlier pre-Codex-style history was collapsed during the command-surface refactor so the source tree no longer advertises removed commands or obsolete plugin identities.
