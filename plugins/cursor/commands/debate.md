---
description: Run a two-model Cursor debate to reach consensus on a proposal or issue
argument-hint: '[--models a,b|--model-a <id> --model-b <id>] [--rounds <1..5>] [--background|--wait] [issue...]'
disable-model-invocation: true
allowed-tools: Bash(node:*), AskUserQuestion
---

Run a Cursor debate through the shared companion runtime.

Raw slash-command arguments:
`$ARGUMENTS`

Core constraint:

- This command is advisory and read-only.
- Do not fix issues, apply patches, or suggest that you are about to make changes.
- Your only job is to run the debate and return Cursor's output verbatim to the user.

Model selection:

- If the raw arguments include `--models`, `--model-a`, or `--model-b`, do not ask. The user already chose.
- Otherwise, use `AskUserQuestion` exactly once to ask which two Cursor models should debate.
- The choices must be:
  - `Gemini + Composer (Recommended)` -> add `--models gemini,composer`
  - `Gemini + Opus` -> add `--models gemini,opus`
  - `Composer + Opus` -> add `--models composer,opus`
- Add the selected `--models ...` value before running the companion command.

Execution mode:

- If the raw arguments include `--wait`, run the debate in the foreground.
- If the raw arguments include `--background`, launch the debate with `Bash` in the background.
- If neither flag is present, default to foreground.
- Preserve `--rounds`, `--json`, and the issue text exactly.
- The runtime defaults to 5 maximum rounds and rejects values outside `1..5`.

Foreground flow:

- Run:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/cursor-companion.mjs" debate "$ARGUMENTS"
```

- Return the command stdout verbatim, exactly as-is.
- Do not paraphrase, summarize, or add commentary before or after it.
- Do not fix any issues mentioned in the debate output.

Background flow:

- Launch the debate with `Bash` in the background:

```typescript
Bash({
  command: `node "${CLAUDE_PLUGIN_ROOT}/scripts/cursor-companion.mjs" debate "$ARGUMENTS"`,
  description: 'Cursor debate',
  run_in_background: true,
});
```

- Do not call `BashOutput` or wait for completion in this turn.
- After launching the command, tell the user: "Cursor debate started in the background. Check `/cursor:status` for progress."
