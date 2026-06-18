---
description: Check whether the local Cursor CLI is ready.
argument-hint: '[--json] [--print-models]'
allowed-tools: Bash(node:*)
---

!`node "${CLAUDE_PLUGIN_ROOT}/scripts/setup.mjs" -- "$ARGUMENTS"`

Present the check results as-is. If any check failed, tell the user concretely what to do, usually install `cursor-agent` or run `cursor-agent login`. Never attempt to run the installer yourself.
