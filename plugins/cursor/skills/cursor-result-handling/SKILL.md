---
name: cursor-result-handling
description: Internal guidance for presenting Cursor companion output back to the user
user-invocable: false
---

# Cursor Result Handling

Apply this whenever a `cursor-companion` command returns output, including through the
`cursor:cursor-rescue` subagent.

Presentation:

- Preserve the helper's structure: verdict, summary, findings, files touched, and next steps.
- For review output, present findings first and keep them ordered by severity.
- Use file paths and line numbers exactly as the helper reports them. Do not re-derive or normalise them.
- Preserve evidence boundaries. If Cursor marked something as an inference, an uncertainty, or an open
  question, keep that distinction rather than flattening it into a claim.
- If there are no findings, say so explicitly and keep any residual-risk note brief.
- If the helper reports files touched, state that Cursor edited the working tree and list them.

Honesty rules:

- Never turn a failed or incomplete Cursor run into a Claude-side implementation attempt. Report the
  failure and stop.
- If Cursor was never successfully invoked, do not generate a substitute answer at all.
- If the helper reports malformed output or a parse error, surface the most actionable stderr lines and
  stop there instead of guessing what Cursor meant.
- `[cursor] …` lines on stderr are live progress, not results. Never present them as the outcome.
- A `failed` status with intact output still means the run did not complete cleanly. Say both things.

After a review:

- CRITICAL: after presenting review, adversarial-review, or debate findings, STOP. Do not make any code
  changes. Ask the user which issues they want fixed before touching a single file. Auto-applying fixes
  from a review is strictly forbidden, even when the fix looks obvious.
- `/cursor:review`, `/cursor:adversarial-review`, and `/cursor:debate` run Cursor in read-only mode. If
  the output claims files were written, treat that as a discrepancy worth reporting, not as fact.

Setup failures:

- If the helper reports that Cursor is missing or unauthenticated, direct the user to `/cursor:setup`
  and do not improvise an alternate auth flow.
