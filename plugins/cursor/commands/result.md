---
description: Print the final output of a finished Cursor job (most recent by default).
argument-hint: '[job-id]'
allowed-tools: Bash(node:*)
---

!`node "${CLAUDE_PLUGIN_ROOT}/scripts/result.mjs" -- "$ARGUMENTS"`

Show the result block to the user as-is. Do not truncate or summarise — the user invoked this command specifically to see the full stored output. Preserve the `cursor-agent --resume=…` line when present.
