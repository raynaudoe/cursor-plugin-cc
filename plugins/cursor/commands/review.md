---
description: Read-only code review of your git diff by a Cursor model. Reports findings; never edits files.
argument-hint: '[--background] [--wait] [--base <ref>] [--scope auto|working-tree|branch] [--model <id>] [--timeout <sec>]'
allowed-tools: Bash(node:*)
---

!`node "${CLAUDE_PLUGIN_ROOT}/scripts/review.mjs" -- "$ARGUMENTS"`

Render the command output verbatim. This command is review-only: do not apply fixes or continue into implementation unless the user explicitly asks in a follow-up. If the user wants custom focus text or design pressure-testing, direct them to `/cursor:adversarial-review`.
