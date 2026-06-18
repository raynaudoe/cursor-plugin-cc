---
description: Show active and recent Cursor jobs for this repository.
argument-hint: '[job-id] [--wait] [--timeout-ms <ms>] [--all]'
disable-model-invocation: true
allowed-tools: Bash(node:*)
---

!`node "${CLAUDE_PLUGIN_ROOT}/scripts/status.mjs" -- "$ARGUMENTS"`

If no id was passed, render the output as a compact Markdown status report. If a specific id was passed, present the full detail block verbatim without summarisation.
