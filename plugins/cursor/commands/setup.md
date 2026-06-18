---
description: Check whether the local Cursor CLI is ready
argument-hint: '[--json] [--print-models]'
allowed-tools: Bash(node:*)
---

Run:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/cursor-companion.mjs" setup --json "$ARGUMENTS"
```

If Cursor is unavailable:

- Do not ask about installation.
- Preserve the setup output guidance for installing `cursor-agent`.

Output rules:

- Present the final setup output to the user.
- If Cursor is installed but not authenticated, preserve the guidance to run `cursor-agent login`.
