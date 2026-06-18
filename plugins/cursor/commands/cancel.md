---
description: Cancel an active Cursor job in this repository.
argument-hint: '[job-id]'
allowed-tools: Bash(node:*)
---

!`node "${CLAUDE_PLUGIN_ROOT}/scripts/cancel.mjs" -- "$ARGUMENTS"`

Surface the cancellation result to the user. If multiple active jobs exist, forward the error and ask which id to cancel.
