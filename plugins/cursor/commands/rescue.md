---
description: Delegate investigation, a fix request, or follow-up rescue work to Cursor.
argument-hint: '[--background] [--wait] [--resume[=chat-id]] [--fresh] [--model <id>] [--timeout <sec>] <task...>'
allowed-tools: Bash(node:*), AskUserQuestion, Agent
---

Invoke the `cursor:cursor-rescue` subagent via the `Agent` tool (`subagent_type: "cursor:cursor-rescue"`), forwarding the raw user request as the prompt.

`cursor:cursor-rescue` is a subagent, not a skill. Do not call `Skill(cursor:cursor-rescue)` or `Skill(cursor:rescue)`.

Raw user request: $ARGUMENTS

Execution mode:

- If the request includes `--background`, run the `cursor:cursor-rescue` subagent in the background.
- If the request includes `--wait`, run the `cursor:cursor-rescue` subagent in the foreground.
- If neither flag is present, prefer foreground only for small, clearly bounded requests. For long-running or output-heavy work, run the subagent in the background so the user can fetch the stored output with `/cursor:result`.
- `--background` and `--wait` are execution flags for Claude Code. Do not treat them as part of the natural-language task text.
- Preserve `--model`, `--timeout`, `--resume`, `--resume=<chat-id>`, and `--fresh` for the subagent.

Resume routing:

- If the request includes `--resume`, `--resume=<chat-id>`, or `--fresh`, do not ask whether to continue. The user already chose.
- Otherwise, before starting Cursor, check for a resumable rescue thread from this repository by running:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/cursor-companion.mjs" task-resume-candidate --json
```

- If that helper reports `available: true`, use `AskUserQuestion` exactly once to ask whether to continue the current Cursor thread or start a new one.
- The two choices must be:
  - `Continue current Cursor thread`
  - `Start a new Cursor thread`
- If the user is clearly giving a follow-up instruction such as "continue", "keep going", "resume", "apply the top fix", or "dig deeper", put `Continue current Cursor thread (Recommended)` first.
- Otherwise put `Start a new Cursor thread (Recommended)` first.
- If the user chooses continue, add `--resume` before routing to the subagent.
- If the user chooses a new thread, add `--fresh` before routing to the subagent.
- If the helper reports `available: false`, do not ask. Route normally.

Operating rules:

- The subagent is a thin forwarder only. It should use one `Bash` call to invoke `node "${CLAUDE_PLUGIN_ROOT}/scripts/cursor-companion.mjs" task ...` and return that command's stdout as-is.
- Return the Cursor companion stdout verbatim to the user.
- Do not paraphrase, summarize, rewrite, or add commentary before or after it.
- If the expected Cursor response is long, prefer a background run. Foreground subagent output still passes through Claude Code's Agent result channel and may be truncated by the host even when the plugin stores the full result.
- Do not ask the subagent to inspect files, monitor progress, poll `/cursor:status`, fetch `/cursor:result`, call `/cursor:cancel`, summarize output, or do follow-up work of its own.
- Leave the model unset unless the user explicitly asks for one.
- If Cursor is missing or unauthenticated, stop and tell the user to run `/cursor:setup`.
- If the user did not supply a request, ask what Cursor should investigate or fix.
