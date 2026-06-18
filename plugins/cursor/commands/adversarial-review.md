---
description: Run a read-only Cursor review that challenges the implementation approach and design choices.
argument-hint: '[--background] [--wait] [--base <ref>] [--scope auto|working-tree|branch] [--model <id>] [focus...]'
allowed-tools: Bash(node:*)
---

!`node "${CLAUDE_PLUGIN_ROOT}/scripts/adversarial-review.mjs" -- "$ARGUMENTS"`

Render the command output verbatim. This is a challenge review, not an implementation step: do not apply fixes or make file changes unless the user explicitly asks in a follow-up.
