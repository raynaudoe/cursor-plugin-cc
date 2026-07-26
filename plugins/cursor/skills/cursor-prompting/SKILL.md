---
name: cursor-prompting
description: Internal guidance for shaping a rescue request into a Cursor task prompt
user-invocable: false
---

# Cursor Prompting

Use this only inside `cursor:cursor-rescue`, and only to tighten the user's request into a better task
prompt before the single `task` call. Shaping the prompt is the only Claude-side work permitted: do not
inspect the repository, reason through the problem yourself, or draft a solution.

Cursor runs as an operator with full tool access in the user's working tree. It does best with an
explicit end state and explicit verification, and worst with open-ended prose.

## Task shape

Give Cursor five sections, in this order:

1. **Goal** — one sentence naming the desired end state.
2. **Repo context** — the stack, plus a pointer to whatever convention file the repository actually has
   (`AGENTS.md`, `.cursor/rules`, `CONTRIBUTING.md`). Tell Cursor to read it and match that repository's
   existing style. Never assert a language, formatter, or convention of your own.
3. **Acceptance criteria** — 1 to 5 verifiable bullets. "Tests pass" is not verifiable; name the command.
4. **Files to touch** — an explicit list whenever it is predictable. Omit the section rather than guess.
5. **How to verify** — the exact commands to run, copied from the repository, not invented.

Then a **Constraints** block forbidding: touching files outside the list, renaming public APIs, and
modifying lockfiles.

## Rules

- One clear task per run. Split unrelated asks into separate runs rather than bundling them.
- Preserve the user's intent and specifics verbatim. Shaping means structuring what they said, not
  substituting your own plan or adding requirements they did not ask for.
- Strip routing flags (`--background`, `--wait`, `--resume`, `--fresh`, `--model`) from the task text.
- State what "done" looks like. Do not assume Cursor will infer it.
- Require verification for anything that changes behaviour: the run is not finished until the named
  command passes.
- Ask for grounded claims. If something is a hypothesis, Cursor should label it as one.
- For diagnosis-only requests, say explicitly that no edits are wanted and ask for findings plus
  evidence.
- Prefer a tighter contract over a longer prompt. Remove redundant instruction before sending.

## Resuming

On `--resume-last`, send only the delta instruction. The prior thread still holds the context, so
restating the whole task wastes it. Restate fully only when the direction changed materially.
