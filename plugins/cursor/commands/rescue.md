---
description: Delegate investigation, a fix request, or follow-up rescue work to Cursor.
argument-hint: '[--background] [--wait] [--resume[=chat-id]] [--fresh] [--model <id>] [--timeout <sec>] <task...>'
allowed-tools: Bash(node:*)
---

!`node "${CLAUDE_PLUGIN_ROOT}/scripts/rescue.mjs" -- "$ARGUMENTS"`

Render Cursor's output verbatim. If the job starts in the background, surface the job id and the `/cursor:status` hint.
