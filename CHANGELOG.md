# Changelog

All notable changes to this project will be documented in this file.
The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/)
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## Unreleased

### Changed

- **Public command surface now matches the Codex companion shape.** The exposed commands are `/cursor:review`, `/cursor:adversarial-review`, `/cursor:rescue`, `/cursor:status`, `/cursor:result`, `/cursor:cancel`, and `/cursor:setup`.
- **`/cursor:rescue` now routes through the `cursor-rescue` subagent.** This matches the Codex plugin pattern while keeping review/status/result/cancel/setup as direct script wrappers.
- **Cursor jobs now use Codex-style tracking and rendering.** A new `cursor-companion.mjs` runtime handles rescue tasks, reviews, background workers, status, result, and cancellation while preserving the existing `~/.cursor-plugin-cc/jobs/<repo-hash>/` layout.
- **Stored Cursor results are no longer capped at 4000 characters.** Long foreground output and `/cursor:result` now preserve the full final Cursor message captured from `cursor-agent`.
- **Marketplace identity is now generic.** The marketplace name is `cursor-plugin-cc`, so local and GitHub installs use `cursor@cursor-plugin-cc` while preserving the `/cursor:*` command namespace.
- **Visible project metadata now uses company attribution.** User-facing docs and plugin manifests refer to `ez`.

### Removed

- Removed stale pre-Codex-style command wrappers, scripts, tests, fixtures, and helper modules that were no longer part of the current runtime.
- Removed stale personal or invalid GitHub-owner references from live docs and plugin metadata.

## Previous History

Earlier pre-Codex-style history was collapsed during the command-surface refactor so the source tree no longer advertises removed commands or obsolete plugin identities.
