#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { closeSync, openSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parseCommandArgv, parseTimeout } from './lib/args.mjs';
import {
  authStatus,
  listConfiguredMcps,
  listModels,
  resolveBin,
  resolveModel,
  runHeadless,
} from './lib/cursor.mjs';
import { collectReviewContext, isGitRepo, repoRoot } from './lib/git.mjs';
import { id as newId } from './lib/id.mjs';
import {
  cancelJob,
  createJob,
  filterForSession,
  isActiveStatus,
  listJobs,
  rawLogPath as rawLogPathFor,
  readJob,
  updateJob,
} from './lib/jobs.mjs';
import { mdCell } from './lib/md.mjs';
import { ensureDir, jobsDir, logsDir, pluginHome } from './lib/paths.mjs';
import { chatIdFromEvent, extractChatId, summariseEvents, walkToolUses } from './lib/parse.mjs';
import { run } from './lib/run.mjs';

const DEFAULT_STATUS_WAIT_TIMEOUT_MS = 240_000;
const DEFAULT_STATUS_POLL_INTERVAL_MS = 2_000;
const DEFAULT_CONTINUE_PROMPT =
  'Continue from the current Cursor chat state. Pick the next highest-value step and follow through until the task is resolved.';
const DEFAULT_DEBATE_MODELS = ['gemini', 'composer'];
const DEFAULT_DEBATE_ROUNDS = 5;
const MAX_DEBATE_ROUNDS = 5;

function output(value, asJson = false) {
  process.stdout.write(asJson ? `${JSON.stringify(value, null, 2)}\n` : value);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Advisory warnings (and the runtime's own post-result reap) must never flip a
// successful run to `failed` — they are reported alongside the result instead.
// Only a non-zero exit, an unsuccessful transcript, or a timeout kill fails a job.
function completionStatus(exitCode, summary, killed = false) {
  return exitCode === 0 && summary.success && !killed ? 'completed' : 'failed';
}

// Live progress for the humans (and the model) watching the tool call. Without
// this a foreground run is a frozen Bash call for its entire duration, which is
// the single biggest reason the plugin reads as an external console process
// rather than a subagent. Mirrors the Codex companion's `[codex] …` stderr feed.
function createProgressReporter(enabled) {
  if (!enabled) return () => {};
  return (message) => {
    if (!message) return;
    process.stderr.write(`[cursor] ${message}\n`);
  };
}

function nowIso() {
  return new Date().toISOString();
}

function firstLine(text, fallback) {
  const line = String(text ?? '')
    .split(/\r?\n/)
    .map((s) => s.trim())
    .find(Boolean);
  return line ?? fallback;
}

function shorten(text, limit = 96) {
  const clean = String(text ?? '')
    .trim()
    .replace(/\s+/g, ' ');
  if (!clean) return '';
  return clean.length <= limit ? clean : `${clean.slice(0, limit - 3)}...`;
}

function formatElapsedDuration(startValue, endValue = null) {
  const start = Date.parse(startValue ?? '');
  if (!Number.isFinite(start)) return '';
  const end = endValue ? Date.parse(endValue) : Date.now();
  if (!Number.isFinite(end) || end < start) return '';
  const seconds = Math.max(0, Math.round((end - start) / 1000));
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const rest = seconds % 60;
  if (hours > 0) return `${hours}h ${minutes}m`;
  if (minutes > 0) return `${minutes}m ${rest}s`;
  return `${rest}s`;
}

// Session-scoped views. Explicit `<job-id>` lookups deliberately search the
// unfiltered list so a user can always reach a job they know the id of.
function sessionJobs(repo) {
  return filterForSession(listJobs(repo));
}

function activeJobs(repo) {
  return sessionJobs(repo).filter((job) => isActiveStatus(job.status));
}

function finishedJobs(repo) {
  return sessionJobs(repo).filter((job) => !isActiveStatus(job.status));
}

function matchJobReference(jobs, reference, predicate = () => true) {
  const filtered = jobs.filter(predicate);
  if (!reference) return filtered[0] ?? null;
  const exact = filtered.find((job) => job.id === reference);
  if (exact) return exact;
  const prefixMatches = filtered.filter((job) => job.id.startsWith(reference));
  if (prefixMatches.length === 1) return prefixMatches[0];
  if (prefixMatches.length > 1) {
    throw new Error(`Job reference "${reference}" is ambiguous. Use a longer job id.`);
  }
  return null;
}

function jobKindLabel(job) {
  if (job.kindLabel) return job.kindLabel;
  if (job.kind === 'adversarial-review') return 'adversarial-review';
  if (job.jobClass === 'review') return 'review';
  if (job.jobClass === 'debate') return 'debate';
  if (job.jobClass === 'task') return 'rescue';
  return job.kind ?? 'job';
}

function inferPhase(job) {
  if (job.phase) return job.phase;
  if (job.status === 'queued') return 'queued';
  if (job.status === 'completed') return 'done';
  if (job.status === 'failed') return 'failed';
  if (job.status === 'cancelled') return 'cancelled';
  if (job.jobClass === 'review') return 'reviewing';
  return 'running';
}

function enrichJob(job) {
  return {
    ...job,
    kindLabel: jobKindLabel(job),
    phase: inferPhase(job),
    elapsed: formatElapsedDuration(job.startedAt, job.completedAt ?? job.finishedAt ?? null),
    duration: isActiveStatus(job.status)
      ? ''
      : formatElapsedDuration(job.startedAt, job.completedAt ?? job.finishedAt ?? job.startedAt),
  };
}

function resumeCommand(job) {
  return job.cursorChatId ? `cursor-agent --resume=${job.cursorChatId}` : null;
}

function renderJobList(jobs) {
  const lines = [];
  lines.push('| Job | Kind | Status | Phase | Elapsed | Cursor Chat ID | Summary | Actions |');
  lines.push('| --- | --- | --- | --- | --- | --- | --- | --- |');
  for (const raw of jobs.map(enrichJob)) {
    const actions = [`/cursor:status ${raw.id}`];
    if (isActiveStatus(raw.status)) actions.push(`/cursor:cancel ${raw.id}`);
    else actions.push(`/cursor:result ${raw.id}`);
    lines.push(
      `| ${mdCell(raw.id)} | ${mdCell(raw.kindLabel)} | ${mdCell(raw.status)} | ${mdCell(
        raw.phase,
      )} | ${mdCell(raw.elapsed)} | ${mdCell(raw.cursorChatId ?? '')} | ${mdCell(
        shorten(raw.summary ?? raw.prompt ?? ''),
      )} | ${actions.map((a) => `\`${a}\``).join('<br>')} |`,
    );
  }
  return lines;
}

function pushJobDetails(lines, raw, options = {}) {
  const job = enrichJob(raw);
  lines.push(`- ${job.id} | ${job.status} | ${job.kindLabel}${job.title ? ` | ${job.title}` : ''}`);
  if (job.summary) lines.push(`  Summary: ${job.summary}`);
  if (job.phase) lines.push(`  Phase: ${job.phase}`);
  const active = isActiveStatus(job.status);
  if (active && job.elapsed) lines.push(`  Elapsed: ${job.elapsed}`);
  if (!active && job.duration) lines.push(`  Duration: ${job.duration}`);
  if (job.cursorChatId) {
    lines.push(`  Cursor chat ID: ${job.cursorChatId}`);
    lines.push(`  Resume in Cursor: ${resumeCommand(job)}`);
  }
  if (job.rawLogPath && options.showLog) lines.push(`  Raw log: ${job.rawLogPath}`);
  if (active) lines.push(`  Cancel: /cursor:cancel ${job.id}`);
  if (!active) lines.push(`  Result: /cursor:result ${job.id}`);
  if (!active && job.jobClass === 'task' && options.showReviewHint) {
    lines.push('  Review changes: /cursor:review --wait');
    lines.push('  Stricter review: /cursor:adversarial-review --wait');
  }
}

function renderStatusReport(repo, { all = false } = {}) {
  const jobs = sessionJobs(repo);
  const running = jobs.filter((job) => isActiveStatus(job.status));
  const latestFinished = jobs.find((job) => !isActiveStatus(job.status)) ?? null;
  const recent = (all ? jobs : jobs.slice(0, 8)).filter(
    (job) => !isActiveStatus(job.status) && job.id !== latestFinished?.id,
  );

  const lines = ['# Cursor Status', ''];
  if (running.length > 0) {
    lines.push('Active jobs:');
    lines.push(...renderJobList(running));
    lines.push('');
    lines.push('Live details:');
    for (const job of running) {
      pushJobDetails(lines, job, { showLog: true });
    }
    lines.push('');
  }

  if (latestFinished) {
    lines.push('Latest finished:');
    pushJobDetails(lines, latestFinished, {
      showLog: latestFinished.status === 'failed',
      showReviewHint: true,
    });
    lines.push('');
  }

  if (recent.length > 0) {
    lines.push('Recent jobs:');
    for (const job of recent) {
      pushJobDetails(lines, job, { showLog: job.status === 'failed' });
    }
  } else if (running.length === 0 && !latestFinished) {
    lines.push('No Cursor jobs recorded yet.');
  }

  return `${lines.join('\n').trimEnd()}\n`;
}

function renderSingleJob(job) {
  const lines = ['# Cursor Job Status', ''];
  pushJobDetails(lines, job, { showLog: true, showReviewHint: true });
  if (job.prompt) {
    lines.push('', 'Prompt:', '', job.prompt);
  }
  if (job.filesTouched?.length) {
    lines.push('', 'Files touched:');
    for (const file of job.filesTouched) lines.push(`- ${file}`);
  }
  return `${lines.join('\n').trimEnd()}\n`;
}

function renderStoredResult(job) {
  const text = String(job.resultText ?? job.summary ?? '(no final output captured)').trim();
  const lines = [text];
  // Whether Cursor edited anything is the first thing a reader needs, and it was
  // stored but never surfaced.
  if (job.filesTouched?.length) {
    lines.push('', `Files touched by Cursor (${job.filesTouched.length}):`);
    for (const file of job.filesTouched) lines.push(`- ${file}`);
  }
  const command = resumeCommand(job);
  if (command) {
    lines.push('', `Cursor chat ID: ${job.cursorChatId}`, `Resume in Cursor: ${command}`);
  }
  return `${lines.join('\n').trimEnd()}\n`;
}

function renderCancelReport(job) {
  return [
    '# Cursor Cancel',
    '',
    `Cancelled ${job.id}.`,
    '',
    job.title ? `- Title: ${job.title}` : null,
    job.summary ? `- Summary: ${job.summary}` : null,
    job.cancelSignalled === false
      ? '- No live process was found; the job record was already stale and has been tidied up.'
      : null,
    '- Check `/cursor:status` for the updated queue.',
  ]
    .filter(Boolean)
    .join('\n')
    .concat('\n');
}

function stripCodeFence(text) {
  const trimmed = String(text ?? '').trim();
  const match = /^```(?:json)?\s*([\s\S]*?)\s*```$/i.exec(trimmed);
  return match ? match[1].trim() : trimmed;
}

function parseStructuredReview(text) {
  const raw = stripCodeFence(text);
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return { parsed: null, parseError: 'Expected a top-level JSON object.', rawOutput: text };
    }
    if (typeof parsed.verdict !== 'string' || typeof parsed.summary !== 'string') {
      return { parsed: null, parseError: 'Missing `verdict` or `summary`.', rawOutput: text };
    }
    if (!Array.isArray(parsed.findings) || !Array.isArray(parsed.next_steps)) {
      return {
        parsed: null,
        parseError: 'Missing `findings` or `next_steps` array.',
        rawOutput: text,
      };
    }
    // The renderer sorts and dereferences these directly, so a null or scalar
    // element is a TypeError mid-render. Fall back to the raw-output branch,
    // which loses nothing, rather than dropping elements the model produced.
    if (parsed.findings.some((f) => !f || typeof f !== 'object' || Array.isArray(f))) {
      return {
        parsed: null,
        parseError: '`findings` must contain objects.',
        rawOutput: text,
      };
    }
    return { parsed, parseError: null, rawOutput: text };
  } catch (err) {
    return {
      parsed: null,
      parseError: err instanceof Error ? err.message : String(err),
      rawOutput: text,
    };
  }
}

function severityRank(severity) {
  switch (severity) {
    case 'critical':
      return 0;
    case 'high':
      return 1;
    case 'medium':
      return 2;
    default:
      return 3;
  }
}

function formatLineRange(finding) {
  const start = Number.isInteger(finding.line_start) ? finding.line_start : null;
  const end = Number.isInteger(finding.line_end) ? finding.line_end : start;
  if (!start) return '';
  return end && end !== start ? `:${start}-${end}` : `:${start}`;
}

function renderStructuredReview(parsedResult, meta) {
  if (!parsedResult.parsed) {
    return [
      `# Cursor ${meta.label}`,
      '',
      `Target: ${meta.targetLabel}`,
      '',
      'Cursor did not return valid structured JSON.',
      '',
      `- Parse error: ${parsedResult.parseError}`,
      '',
      'Raw final message:',
      '',
      '```text',
      String(parsedResult.rawOutput ?? '').trim(),
      '```',
      '',
    ].join('\n');
  }

  const data = parsedResult.parsed;
  const findings = [...data.findings].sort(
    (left, right) => severityRank(left.severity) - severityRank(right.severity),
  );
  const lines = [
    `# Cursor ${meta.label}`,
    '',
    `Target: ${meta.targetLabel}`,
    `Verdict: ${data.verdict}`,
    '',
    data.summary,
    '',
  ];
  if (findings.length === 0) {
    lines.push('No material findings.');
  } else {
    lines.push('Findings:');
    for (const finding of findings) {
      const file = finding.file || 'unknown';
      lines.push(
        `- [${finding.severity || 'low'}] ${finding.title || 'Finding'} (${file}${formatLineRange(finding)})`,
      );
      lines.push(`  ${finding.body || 'No details provided.'}`);
      if (finding.recommendation) lines.push(`  Recommendation: ${finding.recommendation}`);
    }
  }
  if (data.next_steps.length > 0) {
    lines.push('', 'Next steps:');
    for (const step of data.next_steps) lines.push(`- ${step}`);
  }
  return `${lines.join('\n').trimEnd()}\n`;
}

function asStringArray(value) {
  if (!Array.isArray(value)) return [];
  return value.map((item) => String(item ?? '').trim()).filter((item) => item.length > 0);
}

function uniqueStrings(items) {
  return [...new Set(items.map((item) => String(item ?? '').trim()).filter(Boolean))];
}

function extractJsonObjectCandidates(text) {
  const source = String(text ?? '');
  const candidates = [];
  for (let start = source.indexOf('{'); start !== -1; start = source.indexOf('{', start + 1)) {
    let depth = 0;
    let inString = false;
    let escaped = false;
    for (let i = start; i < source.length; i += 1) {
      const ch = source[i];
      if (inString) {
        if (escaped) escaped = false;
        else if (ch === '\\') escaped = true;
        else if (ch === '"') inString = false;
        continue;
      }
      if (ch === '"') {
        inString = true;
        continue;
      }
      if (ch === '{') {
        depth += 1;
      } else if (ch === '}') {
        depth -= 1;
        if (depth === 0) {
          candidates.push(source.slice(start, i + 1).trim());
          break;
        }
      }
    }
  }
  return candidates;
}

function parseDebateTurn(text) {
  const raw = stripCodeFence(text);
  const candidates = [raw, ...extractJsonObjectCandidates(raw).filter((value) => value !== raw)];
  let firstError = null;
  for (const candidate of candidates) {
    let parsed;
    try {
      parsed = JSON.parse(candidate);
    } catch (err) {
      firstError ??= err instanceof Error ? err.message : String(err);
      continue;
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      firstError ??= 'Expected a top-level JSON object.';
      continue;
    }
    const requiredStrings = ['verdict', 'analysis', 'consensus_proposal', 'confidence_score'];
    let shapeError = null;
    for (const key of requiredStrings) {
      if (typeof parsed[key] !== 'string') {
        shapeError = `Missing string field \`${key}\`.`;
        break;
      }
    }
    if (shapeError) {
      firstError ??= shapeError;
      continue;
    }
    for (const key of ['agreements', 'disagreements', 'concessions']) {
      if (!Array.isArray(parsed[key])) {
        shapeError = `Missing array field \`${key}\`.`;
        break;
      }
    }
    if (shapeError) {
      firstError ??= shapeError;
      continue;
    }
    if (typeof parsed.consensus_ready !== 'boolean') {
      firstError ??= 'Missing boolean field `consensus_ready`.';
      continue;
    }
    return { parsed, parseError: null, rawOutput: text };
  }
  return {
    parsed: null,
    parseError: firstError ?? 'No JSON object found.',
    rawOutput: text,
  };
}

function debateStancePrompt(stance) {
  if (stance === 'for') {
    return [
      'SUPPORTIVE PERSPECTIVE WITH INTEGRITY',
      '',
      'You are tasked with advocating FOR this proposal, but with critical guardrails:',
      '- Act in good faith and in the best interest of the questioner.',
      '- Think deeply about whether supporting this idea is safe, sound, and passes essential requirements.',
      '- Be direct in saying "this is a bad idea" when it truly is.',
      '- There must be at least one compelling reason to be optimistic, otherwise do not support it.',
      '',
      'Your supportive analysis should identify genuine strengths, propose ways to overcome legitimate challenges, highlight synergies with existing systems, and present realistic implementation paths.',
    ].join('\n');
  }
  return [
    'CRITICAL PERSPECTIVE WITH RESPONSIBILITY',
    '',
    'You are tasked with critiquing this proposal, but with essential boundaries:',
    '- Do not oppose genuinely excellent, common-sense ideas just to be contrarian.',
    '- Acknowledge when a proposal is fundamentally sound and well-conceived.',
    '- Identify legitimate risks, overlooked complexity, negative consequences, and simpler alternatives.',
    '- If the idea is outstanding, say so clearly while offering constructive refinements.',
    '',
    'Your critical analysis should apply rigorous scrutiny to ensure quality, not undermine good ideas that deserve support.',
  ].join('\n');
}

function debateTranscriptForPrompt(turns) {
  if (turns.length === 0) return '(no prior turns)';
  return turns
    .map((turn) => {
      const parsed = turn.parsed;
      const body = parsed
        ? [
            `Verdict: ${parsed.verdict}`,
            `Analysis: ${parsed.analysis}`,
            `Agreements: ${asStringArray(parsed.agreements).join('; ') || '(none)'}`,
            `Disagreements: ${asStringArray(parsed.disagreements).join('; ') || '(none)'}`,
            `Concessions: ${asStringArray(parsed.concessions).join('; ') || '(none)'}`,
            `Consensus proposal: ${parsed.consensus_proposal}`,
            `Consensus ready: ${parsed.consensus_ready}`,
            `Confidence: ${parsed.confidence_score}`,
          ].join('\n')
        : `Non-JSON output (${turn.parseError || 'parse failed'}):\n${turn.rawText}`;
      return `Round ${turn.round} - ${turn.label} (${turn.model}, ${turn.stance})\n${body}`;
    })
    .join('\n\n---\n\n');
}

function buildDebateTurnPrompt({ issue, round, maxRounds, participant, opponent, transcript }) {
  const phase =
    round === 1
      ? 'Deliver your initial stanced assessment of the issue.'
      : 'Respond to the prior transcript, concede where appropriate, isolate remaining disagreement, and move toward consensus.';
  return [
    'ROLE',
    'You are an expert technical consultant in a two-model consensus debate.',
    'Your feedback may directly influence project decisions. Be rigorous, practical, and honest.',
    '',
    'PERSPECTIVE FRAMEWORK',
    debateStancePrompt(participant.stance),
    '',
    'DEBATE CONTEXT',
    `Issue: ${issue}`,
    `Round: ${round} of ${maxRounds}`,
    `You are: ${participant.label} (${participant.model}, ${participant.stance})`,
    `Other model: ${opponent.label} (${opponent.model}, ${opponent.stance})`,
    phase,
    '',
    'EVALUATION FRAMEWORK',
    'Assess technical feasibility, project suitability, user value, implementation complexity, alternatives, industry perspective, and long-term implications.',
    '',
    'PRIOR TRANSCRIPT',
    debateTranscriptForPrompt(transcript),
    '',
    'MANDATORY RESPONSE FORMAT',
    'Return only valid JSON. Do not wrap it in markdown fences. Use this exact shape:',
    '{"verdict":"single clear sentence","analysis":"concise rigorous assessment","agreements":["point"],"disagreements":["point"],"concessions":["point"],"consensus_proposal":"specific proposal both sides could accept or the strongest current position","consensus_ready":false,"confidence_score":"X/10 - brief justification"}',
    '',
    'CONSENSUS RULES',
    '- Set consensus_ready to true only if your side can accept the consensus_proposal without hiding a material unresolved risk.',
    '- Bad ideas must be called out regardless of stance; good ideas must be acknowledged regardless of stance.',
    '- If consensus is not ready, state the exact blocking disagreement.',
    '- Keep the reply under 850 tokens.',
    '',
    'READ-ONLY CONSTRAINTS',
    '- Do not modify, create, delete, stage, or commit files.',
    '- This is an advisory debate only.',
  ].join('\n');
}

function renderList(title, items, fallback = '(none)') {
  const lines = [title];
  const clean = uniqueStrings(items);
  if (clean.length === 0) lines.push(`- ${fallback}`);
  else for (const item of clean) lines.push(`- ${item}`);
  return lines;
}

function renderDebateTurn(turn) {
  const lines = [`### Round ${turn.round} - ${turn.label} (${turn.model}, ${turn.stance})`, ''];
  if (!turn.parsed) {
    lines.push(`Non-JSON output preserved. Parse error: ${turn.parseError || 'unknown'}`, '');
    lines.push('```text', String(turn.rawText ?? '').trim(), '```');
    return lines;
  }
  lines.push(`Verdict: ${turn.parsed.verdict}`);
  lines.push(`Confidence: ${turn.parsed.confidence_score}`);
  lines.push(`Consensus ready: ${turn.parsed.consensus_ready ? 'yes' : 'no'}`, '');
  lines.push(turn.parsed.analysis, '');
  lines.push(...renderList('Agreements:', asStringArray(turn.parsed.agreements)));
  lines.push('', ...renderList('Disagreements:', asStringArray(turn.parsed.disagreements)));
  lines.push('', ...renderList('Concessions:', asStringArray(turn.parsed.concessions)));
  lines.push('', 'Consensus proposal:', '', turn.parsed.consensus_proposal);
  return lines;
}

function renderDebateReport({ request, turns, consensusReached, warnings = [] }) {
  const parsedTurns = turns.filter((turn) => turn.parsed);
  const finalRound = turns.length ? Math.max(...turns.map((turn) => turn.round)) : 0;
  const finalTurns = turns.filter((turn) => turn.round === finalRound);
  const finalParsed = finalTurns.map((turn) => turn.parsed).filter(Boolean);
  const agreements = uniqueStrings(finalParsed.flatMap((turn) => asStringArray(turn.agreements)));
  const disagreements = uniqueStrings(
    finalParsed.flatMap((turn) => asStringArray(turn.disagreements)),
  );
  const concessions = uniqueStrings(finalParsed.flatMap((turn) => asStringArray(turn.concessions)));
  const proposal =
    finalParsed
      .map((turn) => String(turn.consensus_proposal ?? '').trim())
      .find((value) => value.length > 0) || '(no consensus proposal captured)';
  const lines = [
    '# Cursor Debate Consensus',
    '',
    `Issue: ${request.debate.issue}`,
    `Models: ${request.debate.participants.map((p) => `${p.label}=${p.model}`).join(', ')}`,
    `Rounds used: ${finalRound} of ${request.debate.maxRounds}`,
    `Consensus: ${consensusReached ? 'reached' : 'not reached'}`,
    '',
    'Final recommendation:',
    '',
    proposal,
    '',
    ...renderList('Key agreements:', agreements),
    '',
    ...renderList('Remaining disagreements:', disagreements),
    '',
    ...renderList('Concessions:', concessions),
    '',
    'Next steps:',
  ];
  if (consensusReached) {
    lines.push('- Treat the consensus proposal as the decision candidate.');
    lines.push('- Validate the proposal against repo constraints before implementation.');
  } else {
    lines.push('- Decide explicitly on the unresolved disagreements before implementation.');
    lines.push('- Use the strongest shared ground above as the minimum defensible position.');
  }
  if (parsedTurns.length !== turns.length) {
    lines.push('- Review non-JSON transcript entries before relying on the summary.');
  }
  if (warnings.length > 0) {
    lines.push('', '[plugin post-flight]');
    for (const warning of warnings) lines.push(`- ${warning}`);
  }
  lines.push('', '## Transcript');
  for (const turn of turns) {
    lines.push('', ...renderDebateTurn(turn));
  }
  return `${lines.join('\n').trimEnd()}\n`;
}

function buildReviewPrompt({ context, adversarial = false, focusText = '' }) {
  if (!adversarial) {
    return [
      'You are a senior code reviewer.',
      '',
      `Review target: ${context.label}`,
      context.collectionGuidance ? `Context mode: ${context.collectionGuidance}` : '',
      '',
      'Review ONLY the changes below, not the entire codebase.',
      '',
      context.body,
      '',
      'How to respond:',
      '- Group findings by severity: Blocking, Should-fix, Nits.',
      '- For each finding: `path:line` — what is wrong, why it matters, and a concrete fix described but not applied.',
      '- Flag correctness bugs, security holes, missing error handling, broken or missing tests, and deviations from repo conventions.',
      '- End with exactly one verdict line: APPROVE, APPROVE WITH NITS, or REQUEST CHANGES.',
      '',
      'Hard constraints:',
      '- This is a READ-ONLY review. Do not modify, create, delete, stage, or commit files.',
      '- If the diff context is lightweight or truncated, inspect specific files or git diff output read-only before finalizing.',
    ].join('\n');
  }

  return [
    '<role>',
    'You are Cursor performing an adversarial software review.',
    'Your job is to break confidence in the change, not validate it.',
    '</role>',
    '',
    '<task>',
    `Review target: ${context.label}`,
    `User focus: ${focusText || 'No extra focus provided.'}`,
    context.collectionGuidance ? `Context mode: ${context.collectionGuidance}` : '',
    'Review the provided repository context and challenge whether this change should ship.',
    '</task>',
    '',
    '<review_method>',
    'Prioritize correctness, security, data loss, rollback safety, race conditions, stale state, version skew, and missing observability.',
    'If the context is lightweight or truncated, inspect the target diff yourself with read-only commands before finalizing.',
    '</review_method>',
    '',
    '<structured_output_contract>',
    'Return only valid JSON with this exact shape:',
    '{"verdict":"approve|needs-attention","summary":"terse ship/no-ship assessment","findings":[{"severity":"critical|high|medium|low","title":"short title","body":"grounded explanation","file":"path","line_start":1,"line_end":1,"confidence":0.0,"recommendation":"concrete fix"}],"next_steps":["action"]}',
    'Use "needs-attention" if any material risk should block shipping. Use "approve" only if you cannot support a substantive finding.',
    '</structured_output_contract>',
    '',
    '<grounding_rules>',
    'Every finding must be defensible from repository context or read-only tool output. Do not invent files, lines, or runtime behavior.',
    'If a conclusion depends on inference, state that explicitly and keep confidence honest.',
    '</grounding_rules>',
    '',
    '<repository_context>',
    context.body,
    '</repository_context>',
  ].join('\n');
}

function postFlightWarnings(summary, request) {
  const warnings = [];
  if (
    (request.jobClass === 'review' || request.jobClass === 'debate') &&
    summary.filesTouched.length > 0
  ) {
    const label = request.jobClass === 'debate' ? 'debate' : 'review';
    warnings.push(
      `This was a read-only ${label}, but Cursor touched ${summary.filesTouched.length} file(s): ${summary.filesTouched.join(
        ', ',
      )}. Inspect your working tree; Cursor should not have written anything.`,
    );
  }
  return warnings;
}

function toolPhase(ev) {
  // `investigating` is the fallback, not an early return: returning it from the
  // first loop iteration made every event after the first read report the same
  // phase forever, so the phase never advanced past `investigating`.
  let phase = null;
  for (const tool of walkToolUses(ev)) {
    const name = String(tool.name ?? '').toLowerCase();
    if (/write|edit|patch|create|file/.test(name)) return 'editing';
    if (/test|lint|build|typecheck|check|verify/.test(name)) return 'verifying';
    phase = 'investigating';
  }
  return phase;
}

async function runCursorRequest(root, jobId, request, options = {}) {
  const logPath = rawLogPathFor(root, jobId);
  const progress = createProgressReporter(options.progressToStderr === true);
  ensureDir(jobsDir(root));
  ensureDir(logsDir(root));
  updateJob(root, jobId, {
    status: 'running',
    phase: 'starting',
    pid: process.pid,
    model: request.model,
  });

  progress(
    `${request.title} starting (model ${request.model}${request.readOnly ? ', read-only' : ''})`,
  );

  let lastPhase = 'starting';
  let lastChatId = null;
  const result = await runHeadless({
    prompt: request.prompt,
    model: request.model,
    resumeChatId: request.resumeChatId,
    resumeLatest: request.resumeLatest,
    readOnly: request.readOnly === true,
    force: request.force !== false,
    timeoutSec: request.timeoutSec,
    logPath,
    onSpawn: (pid) => {
      updateJob(root, jobId, { agentPid: pid });
    },
    onEvent: (ev) => {
      const chatId = chatIdFromEvent(ev);
      // Real cursor-agent stamps the chat id on EVERY streamed line, so without
      // this guard the job file is read, re-serialised and renamed once per
      // event for the whole run.
      if (typeof chatId === 'string' && chatId.length > 0 && chatId !== lastChatId) {
        lastChatId = chatId;
        updateJob(root, jobId, { cursorChatId: chatId });
        progress(`chat ${chatId}`);
      }
      const nextPhase = toolPhase(ev);
      if (nextPhase && nextPhase !== lastPhase) {
        lastPhase = nextPhase;
        updateJob(root, jobId, { phase: nextPhase });
        progress(nextPhase);
      }
    },
  });

  const summary = summariseEvents(result.events);
  const chatId = extractChatId(result.events);
  const warnings = postFlightWarnings(summary, request);
  if (result.killed) {
    warnings.push(
      `The run hit the ${request.timeoutSec}s timeout and was killed before finishing; output may be incomplete.`,
    );
  }

  const status = completionStatus(result.exitCode, summary, result.killed);
  progress(`${status} (exit ${result.exitCode})`);
  let resultText = summary.summary;
  if (request.structuredReview) {
    resultText = renderStructuredReview(parseStructuredReview(summary.summary), {
      label: request.kind === 'adversarial-review' ? 'Adversarial Review' : 'Review',
      targetLabel: request.targetLabel,
    });
  }
  if (warnings.length > 0) {
    resultText = `${resultText.trim()}\n\n[plugin post-flight]\n${warnings.join('\n\n')}\n`;
  }

  updateJob(root, jobId, {
    status,
    exitCode: result.exitCode,
    completedAt: nowIso(),
    finishedAt: nowIso(),
    phase: status === 'completed' ? 'done' : 'failed',
    summary: firstLine(summary.summary, `${request.title} finished.`),
    resultText,
    filesTouched: summary.filesTouched,
    ...(chatId ? { cursorChatId: chatId } : {}),
  });

  return { result, summary, status, chatId, warnings, resultText };
}

async function runDebateRequest(root, jobId, request, options = {}) {
  const logPath = rawLogPathFor(root, jobId);
  const progress = createProgressReporter(options.progressToStderr === true);
  ensureDir(jobsDir(root));
  ensureDir(logsDir(root));
  updateJob(root, jobId, {
    status: 'running',
    phase: 'starting debate',
    pid: process.pid,
    model: request.model,
  });

  const participants = request.debate?.participants;
  if (!Array.isArray(participants) || participants.length !== 2) {
    throw new Error('Debate jobs require exactly two model participants.');
  }

  const turns = [];
  const warnings = [];
  const filesTouched = [];
  const chatIds = [];
  let consensusReached = false;
  let exitCode = 0;
  let killed = false;

  for (let round = 1; round <= request.debate.maxRounds; round += 1) {
    const roundStart = turns.length;
    for (let index = 0; index < participants.length; index += 1) {
      const stored = readJob(root, jobId);
      if (stored?.status === 'cancelled') {
        warnings.push('The debate was cancelled before completion.');
        const resultText = renderDebateReport({ request, turns, consensusReached, warnings });
        updateJob(root, jobId, {
          status: 'cancelled',
          exitCode: 1,
          completedAt: nowIso(),
          finishedAt: nowIso(),
          phase: 'cancelled',
          summary: 'Cursor debate cancelled.',
          resultText,
          filesTouched: uniqueStrings(filesTouched),
        });
        return {
          result: { exitCode: 1, events: [], killed },
          summary: {
            summary: resultText,
            filesTouched: uniqueStrings(filesTouched),
            exitReason: 'cancelled',
            success: false,
          },
          status: 'cancelled',
          chatId: chatIds[chatIds.length - 1],
          warnings,
          resultText,
          turns,
          consensusReached,
        };
      }

      const participant = participants[index];
      const opponent = participants[index === 0 ? 1 : 0];
      updateJob(root, jobId, {
        phase: `round ${round}: ${participant.label}`,
        summary: `Round ${round}: ${participant.label}`,
      });
      progress(`round ${round}/${request.debate.maxRounds}: ${participant.label} thinking`);

      let lastChatId = null;
      const result = await runHeadless({
        prompt: buildDebateTurnPrompt({
          issue: request.debate.issue,
          round,
          maxRounds: request.debate.maxRounds,
          participant,
          opponent,
          transcript: turns,
        }),
        model: participant.model,
        // A debate is advisory: `/cursor:debate` promises the user a read-only
        // run, so it must not be able to touch the working tree.
        readOnly: true,
        timeoutSec: request.timeoutSec,
        logPath,
        onSpawn: (pid) => {
          updateJob(root, jobId, { agentPid: pid });
        },
        onEvent: (ev) => {
          const chatId = chatIdFromEvent(ev);
          if (typeof chatId === 'string' && chatId.length > 0 && chatId !== lastChatId) {
            lastChatId = chatId;
            updateJob(root, jobId, { cursorChatId: chatId });
          }
        },
      });

      const summary = summariseEvents(result.events);
      const chatId = extractChatId(result.events);
      const parsedResult = parseDebateTurn(summary.summary);
      const turnWarnings = postFlightWarnings(summary, request);
      warnings.push(...turnWarnings);
      if (result.killed) {
        warnings.push(
          `${participant.label} round ${round}: cursor-agent hit the ${request.timeoutSec}s timeout and was killed; output may be incomplete.`,
        );
      }
      if (result.exitCode !== 0 || !summary.success) {
        warnings.push(
          `${participant.label} round ${round}: cursor-agent exited with code ${result.exitCode} (${summary.exitReason}).`,
        );
      }

      filesTouched.push(...summary.filesTouched);
      if (chatId) chatIds.push(chatId);
      if (result.exitCode !== 0 && exitCode === 0) exitCode = result.exitCode;
      if (!summary.success && exitCode === 0) exitCode = 1;
      killed = killed || result.killed;

      turns.push({
        round,
        label: participant.label,
        model: participant.model,
        requestedModel: participant.requestedModel,
        stance: participant.stance,
        exitCode: result.exitCode,
        killed: result.killed,
        cursorChatId: chatId,
        rawText: summary.summary,
        parsed: parsedResult.parsed,
        parseError: parsedResult.parseError,
        filesTouched: summary.filesTouched,
      });

      updateJob(root, jobId, {
        phase: `round ${round}: ${participant.label} done`,
        summary: `${participant.label} round ${round}: ${firstLine(
          summary.summary,
          'Cursor debate turn finished.',
        )}`,
        filesTouched: uniqueStrings(filesTouched),
        ...(chatId ? { cursorChatId: chatId } : {}),
      });
    }

    const roundTurns = turns.slice(roundStart);
    if (
      roundTurns.length === participants.length &&
      roundTurns.every((turn) => turn.parsed?.consensus_ready === true)
    ) {
      consensusReached = true;
      break;
    }
  }

  const files = uniqueStrings(filesTouched);
  // Advisory warnings do not fail a debate that ran to completion.
  const status = exitCode === 0 && !killed ? 'completed' : 'failed';
  const resultText = renderDebateReport({ request, turns, consensusReached, warnings });
  progress(`${status}${consensusReached ? ' (consensus)' : ''} after ${turns.length} turn(s)`);
  const finalExitCode = status === 'completed' ? 0 : exitCode || 1;
  updateJob(root, jobId, {
    status,
    exitCode: finalExitCode,
    completedAt: nowIso(),
    finishedAt: nowIso(),
    phase: status === 'completed' ? 'done' : 'failed',
    summary: firstLine(resultText, 'Cursor debate finished.'),
    resultText,
    filesTouched: files,
    ...(chatIds.length > 0 ? { cursorChatId: chatIds[chatIds.length - 1] } : {}),
  });

  return {
    result: { exitCode: finalExitCode, events: [], killed },
    summary: {
      summary: resultText,
      filesTouched: files,
      exitReason: status,
      success: status === 'completed',
    },
    status,
    chatId: chatIds[chatIds.length - 1],
    warnings,
    resultText,
    turns,
    consensusReached,
  };
}

function createTrackedJob(root, request, status = 'running') {
  const jobId = newId(10);
  // `prompt` is already a top-level column; keeping a second copy inside
  // `request` doubles every job file (a review prompt carries up to 256 KiB of
  // diff) and `listJobs` re-parses every file on each status/result/cancel.
  const { prompt, ...storedRequest } = request;
  createJob({
    id: jobId,
    repoPath: root,
    prompt,
    model: request.model,
    status,
    kind: request.kind,
    kindLabel: request.kindLabel,
    jobClass: request.jobClass,
    title: request.title,
    phase: status === 'queued' ? 'queued' : 'starting',
    summary: request.initialSummary,
    request: storedRequest,
    background: status === 'queued',
  });
  return jobId;
}

function spawnWorker(root, jobId, subcommand) {
  const selfPath = fileURLToPath(import.meta.url);
  const logPath = rawLogPathFor(root, jobId);
  ensureDir(logsDir(root));
  const out = openSync(`${logPath}.stdout`, 'a');
  const err = openSync(`${logPath}.stderr`, 'a');
  const child = spawn(process.execPath, [selfPath, subcommand, '--cwd', root, '--job-id', jobId], {
    cwd: root,
    detached: true,
    stdio: ['ignore', out, err],
    env: process.env,
    windowsHide: true,
  });
  // A failed spawn emits 'error' asynchronously; with no listener that is an
  // uncaught exception for any in-process caller (the tests call main() directly).
  child.on('error', () => {});
  child.unref();
  // The child owns dup'd descriptors once spawn() has returned.
  closeSync(out);
  closeSync(err);
  // Never return a non-positive sentinel: it is persisted as `job.pid` and later
  // fed to process.kill(), where -1 broadcasts to every process this user owns.
  if (!Number.isInteger(child.pid) || child.pid <= 0) return null;
  return child.pid;
}

// A throw between `status: running` and the completion update would otherwise
// leave the record active forever: /cursor:status lists a phantom job that
// /cursor:result refuses and bare /cursor:cancel then reports as ambiguous.
async function executeRequest(root, jobId, request, options) {
  try {
    return request.jobClass === 'debate'
      ? await runDebateRequest(root, jobId, request, options)
      : await runCursorRequest(root, jobId, request, options);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    try {
      updateJob(root, jobId, {
        status: 'failed',
        exitCode: 1,
        completedAt: nowIso(),
        finishedAt: nowIso(),
        phase: 'failed',
        summary: `${request.title} failed: ${message}`,
        resultText: `${request.title} failed before it could produce a result.\n\n${message}\n`,
      });
    } catch {
      // The record write failed too (often the same disk/permission fault).
      // Losing the status update is bad; losing the real cause is worse.
    }
    throw err;
  }
}

async function runJobForeground(root, request, { json = false } = {}) {
  const jobId = createTrackedJob(root, request, 'running');
  // Progress goes to stderr so it never contaminates the stdout payload the
  // slash commands return verbatim, and is suppressed under --json.
  const execution = await executeRequest(root, jobId, request, { progressToStderr: !json });
  const job = readJob(root, jobId);
  const payload = { job, ...execution };
  output(json ? payload : renderStoredResult(job), json);
  return execution.result.exitCode;
}

async function runJobWorker(root, jobId) {
  const job = readJob(root, jobId);
  if (!job) throw new Error(`No stored job found for ${jobId}.`);
  if (!job.request || typeof job.request !== 'object') {
    throw new Error(`Stored job ${jobId} is missing its request payload.`);
  }
  // The detached worker's stderr is redirected to `<log>.stderr`, so the same
  // progress feed becomes the background job's trace file.
  // Records written before the prompt was de-duplicated still carry it inside
  // `request`; newer ones read it back from the top-level column.
  const request = { ...job.request, prompt: job.request.prompt ?? job.prompt };
  await executeRequest(root, jobId, request, { progressToStderr: true });
}

function queueJob(root, request, workerSubcommand, json = false) {
  const jobId = createTrackedJob(root, request, 'queued');
  const pid = spawnWorker(root, jobId, workerSubcommand);
  if (pid === null) {
    // Nothing is running, so do not report a queued job the user will wait on.
    updateJob(root, jobId, {
      status: 'failed',
      exitCode: 1,
      phase: 'failed',
      completedAt: nowIso(),
      finishedAt: nowIso(),
      summary: 'Background worker failed to start.',
    });
    throw new Error(
      `Could not start the background worker for job ${jobId}. Re-run without --background to see the failure.`,
    );
  }
  updateJob(root, jobId, { pid });
  const rendered = `${request.title} started in the background as ${jobId}. Check /cursor:status ${jobId} for progress.\n`;
  output(
    json
      ? {
          jobId,
          status: 'queued',
          title: request.title,
          summary: request.initialSummary,
        }
      : rendered,
    json,
  );
  return 0;
}

async function ensureGitForCommand(cwd) {
  if (!(await isGitRepo(cwd))) throw new Error('This command must run inside a Git repository.');
  return repoRoot(cwd);
}

function parseReviewFlags(argv) {
  const { positional, flags } = parseCommandArgv(argv, ['background', 'wait', 'json']);
  return {
    focusText: positional.join(' ').trim(),
    base: typeof flags.base === 'string' ? flags.base : undefined,
    scope:
      typeof flags.scope === 'string' && ['auto', 'working-tree', 'branch'].includes(flags.scope)
        ? flags.scope
        : 'auto',
    model: resolveModel(typeof flags.model === 'string' ? flags.model : undefined),
    background: Boolean(flags.background),
    wait: Boolean(flags.wait),
    timeoutSec: parseTimeout(flags.timeout),
    json: Boolean(flags.json),
  };
}

async function buildReviewRequest(root, flags, adversarial) {
  const context = await collectReviewContext(root, { scope: flags.scope, base: flags.base });
  if (context.error) throw new Error(context.error);
  if (context.isEmpty) {
    return { empty: true, label: context.label };
  }
  const kind = adversarial ? 'adversarial-review' : 'review';
  return {
    empty: false,
    kind,
    kindLabel: kind,
    jobClass: 'review',
    title: adversarial ? 'Cursor Adversarial Review' : 'Cursor Review',
    targetLabel: context.label,
    initialSummary: `${adversarial ? 'Adversarial review' : 'Review'} ${context.label}`,
    prompt: buildReviewPrompt({ context, adversarial, focusText: flags.focusText }),
    model: flags.model,
    // Review commands promise the user they will not change anything. Enforce it
    // at the CLI rather than trusting the prompt.
    readOnly: true,
    timeoutSec: flags.timeoutSec,
    structuredReview: adversarial,
  };
}

async function handleReview(argv, adversarial = false) {
  const flags = parseReviewFlags(argv);
  if (!adversarial && flags.focusText) {
    throw new Error(
      '`/cursor:review` does not support custom focus text. Use `/cursor:adversarial-review` for focused review instructions.',
    );
  }
  const root = await ensureGitForCommand(process.cwd());
  const request = await buildReviewRequest(root, flags, adversarial);
  if (request.empty) {
    output(
      `Nothing to review — ${request.label} has no changes. Try \`--base <ref>\` or \`--scope working-tree\` to compare another target.\n`,
    );
    return 0;
  }
  if (flags.background && !flags.wait) {
    return queueJob(root, request, 'review-worker', flags.json);
  }
  return runJobForeground(root, request, { json: flags.json });
}

function readStringFlag(flags, names) {
  for (const name of names) {
    const value = flags[name];
    if (typeof value === 'string' && value.trim().length > 0) return value.trim();
  }
  return undefined;
}

function hasAnyFlag(flags, names) {
  return names.some((name) => Object.prototype.hasOwnProperty.call(flags, name));
}

function parseDebateRounds(raw) {
  if (raw == null || raw === false) return DEFAULT_DEBATE_ROUNDS;
  if (raw === true || raw === '') {
    throw new Error(`--rounds must be an integer from 1 to ${MAX_DEBATE_ROUNDS}.`);
  }
  const rounds = typeof raw === 'number' ? raw : Number(raw);
  if (!Number.isInteger(rounds) || rounds < 1 || rounds > MAX_DEBATE_ROUNDS) {
    throw new Error(`--rounds must be an integer from 1 to ${MAX_DEBATE_ROUNDS}.`);
  }
  return rounds;
}

function parseDebateModelInputs(flags) {
  const hasCombined = hasAnyFlag(flags, ['models']);
  const hasModelA = hasAnyFlag(flags, ['model-a', 'modelA']);
  const hasModelB = hasAnyFlag(flags, ['model-b', 'modelB']);
  const combined = readStringFlag(flags, ['models']);
  const modelA = readStringFlag(flags, ['model-a', 'modelA']);
  const modelB = readStringFlag(flags, ['model-b', 'modelB']);
  if (hasCombined && !combined) {
    throw new Error('Pass a value to --models, for example --models gemini,composer.');
  }
  if (hasModelA && !modelA) {
    throw new Error('Pass a value to --model-a.');
  }
  if (hasModelB && !modelB) {
    throw new Error('Pass a value to --model-b.');
  }
  if (combined && (hasModelA || hasModelB)) {
    throw new Error('Use either --models a,b or --model-a/--model-b, not both.');
  }
  if (combined) {
    const models = combined
      .split(',')
      .map((model) => model.trim())
      .filter(Boolean);
    if (models.length !== 2) {
      throw new Error('--models must contain exactly two comma-separated model ids.');
    }
    return models;
  }
  if (modelA || modelB) {
    if (!modelA || !modelB) {
      throw new Error('Pass both --model-a <id> and --model-b <id>, or use --models a,b.');
    }
    return [modelA, modelB];
  }
  return DEFAULT_DEBATE_MODELS;
}

function parseDebateFlags(argv) {
  const { positional, flags } = parseCommandArgv(argv, ['background', 'wait', 'json']);
  const requestedModels = parseDebateModelInputs(flags);
  const resolvedModels = requestedModels.map((model) => resolveModel(model));
  if (resolvedModels[0] === resolvedModels[1]) {
    throw new Error('Choose two different Cursor models for the debate.');
  }
  return {
    issue: positional.join(' ').trim(),
    requestedModels,
    resolvedModels,
    rounds: parseDebateRounds(flags.rounds),
    background: Boolean(flags.background),
    wait: Boolean(flags.wait),
    timeoutSec: parseTimeout(flags.timeout),
    json: Boolean(flags.json),
  };
}

function buildDebateRequest(flags) {
  if (!flags.issue) {
    throw new Error(
      'Provide an issue or proposal to debate, e.g. `/cursor:debate --models gemini,composer should we add this API boundary?`.',
    );
  }
  const participants = [
    {
      label: 'Model A',
      requestedModel: flags.requestedModels[0],
      model: flags.resolvedModels[0],
      stance: 'for',
    },
    {
      label: 'Model B',
      requestedModel: flags.requestedModels[1],
      model: flags.resolvedModels[1],
      stance: 'against',
    },
  ];
  return {
    kind: 'debate',
    kindLabel: 'debate',
    jobClass: 'debate',
    title: 'Cursor Debate',
    initialSummary: `Debate: ${shorten(flags.issue)}`,
    prompt: flags.issue,
    model: flags.resolvedModels.join(','),
    readOnly: true,
    timeoutSec: flags.timeoutSec,
    debate: {
      issue: flags.issue,
      maxRounds: flags.rounds,
      participants,
    },
  };
}

async function handleDebate(argv) {
  const flags = parseDebateFlags(argv);
  const root = await repoRoot(process.cwd());
  const request = buildDebateRequest(flags);
  if (flags.background && !flags.wait) {
    return queueJob(root, request, 'debate-worker', flags.json);
  }
  return runJobForeground(root, request, { json: flags.json });
}

function parseTaskFlags(argv) {
  const { positional, flags } = parseCommandArgv(argv, [
    'background',
    'wait',
    'json',
    'fresh',
    'resume',
    'resume-last',
    'force',
  ]);
  const resumeValue = flags.resume;
  return {
    prompt: positional.join(' ').trim(),
    model: resolveModel(typeof flags.model === 'string' ? flags.model : undefined),
    background: Boolean(flags.background),
    wait: Boolean(flags.wait),
    json: Boolean(flags.json),
    fresh: Boolean(flags.fresh),
    resumeLast: Boolean(flags['resume-last'] || flags.resumeLast || resumeValue === true),
    resumeChatId: typeof resumeValue === 'string' ? resumeValue : undefined,
    force: 'force' in flags ? Boolean(flags.force) : true,
    timeoutSec: parseTimeout(flags.timeout),
  };
}

function latestResumableTask(root) {
  return sessionJobs(root).find(
    (job) => job.jobClass === 'task' && job.cursorChatId && !isActiveStatus(job.status),
  );
}

function buildTaskRequest(root, flags) {
  const latest = flags.resumeLast && !flags.resumeChatId ? latestResumableTask(root) : null;
  if (flags.resumeLast && !flags.resumeChatId && !latest) {
    throw new Error('No previous Cursor rescue thread was found for this repository.');
  }
  const prompt =
    flags.prompt || (flags.resumeLast || flags.resumeChatId ? DEFAULT_CONTINUE_PROMPT : '');
  if (!prompt) throw new Error('Provide a prompt or use --resume.');
  const resumeChatId = flags.resumeChatId ?? latest?.cursorChatId;
  return {
    kind: 'task',
    kindLabel: 'rescue',
    jobClass: 'task',
    title: resumeChatId ? 'Cursor Resume' : 'Cursor Rescue',
    initialSummary: shorten(prompt),
    prompt,
    model: flags.model,
    resumeChatId,
    resumeLatest: flags.resumeLast && !resumeChatId,
    force: flags.force,
    timeoutSec: flags.timeoutSec,
  };
}

async function handleTask(argv) {
  const flags = parseTaskFlags(argv);
  if (flags.fresh && (flags.resumeLast || flags.resumeChatId)) {
    throw new Error('Choose either --resume or --fresh.');
  }
  const root = await repoRoot(process.cwd());
  const request = buildTaskRequest(root, flags);
  if (flags.background && !flags.wait) {
    return queueJob(root, request, 'task-worker', flags.json);
  }
  return runJobForeground(root, request, { json: flags.json });
}

function handleTaskResumeCandidate(argv) {
  const { flags } = parseCommandArgv(argv, ['json']);
  const root = repoRoot(process.cwd());
  return root.then((repo) => {
    const candidate = latestResumableTask(repo);
    const payload = {
      available: Boolean(candidate),
      candidate: candidate
        ? {
            id: candidate.id,
            status: candidate.status,
            title: candidate.title ?? null,
            summary: candidate.summary ?? null,
            cursorChatId: candidate.cursorChatId,
            completedAt: candidate.completedAt ?? candidate.finishedAt ?? null,
          }
        : null,
    };
    output(
      flags.json
        ? payload
        : candidate
          ? `Resumable Cursor rescue found: ${candidate.id} (${candidate.status}).\n`
          : 'No resumable Cursor rescue found for this repository.\n',
      Boolean(flags.json),
    );
    return 0;
  });
}

async function handleStatus(argv) {
  const { positional, flags } = parseCommandArgv(argv, ['json', 'all', 'wait']);
  const root = await repoRoot(process.cwd());
  const reference = positional[0] ?? '';
  if (!reference) {
    if (flags.wait) throw new Error('`status --wait` requires a job id.');
    output(
      flags.json
        ? { jobs: sessionJobs(root).map(enrichJob) }
        : renderStatusReport(root, { all: Boolean(flags.all) }),
      Boolean(flags.json),
    );
    return 0;
  }

  const timeoutMs =
    typeof flags['timeout-ms'] === 'number'
      ? flags['timeout-ms']
      : typeof flags.timeoutMs === 'number'
        ? flags.timeoutMs
        : DEFAULT_STATUS_WAIT_TIMEOUT_MS;
  const pollMs =
    typeof flags['poll-interval-ms'] === 'number'
      ? flags['poll-interval-ms']
      : DEFAULT_STATUS_POLL_INTERVAL_MS;
  const deadline = Date.now() + timeoutMs;
  let job = matchJobReference(listJobs(root), reference);
  if (!job)
    throw new Error(`No job found for "${reference}". Run /cursor:status to list known jobs.`);
  while (flags.wait && isActiveStatus(job.status) && Date.now() < deadline) {
    await sleep(Math.min(pollMs, Math.max(0, deadline - Date.now())));
    job = readJob(root, job.id) ?? job;
  }
  output(flags.json ? { job: enrichJob(job) } : renderSingleJob(job), Boolean(flags.json));
  return 0;
}

async function handleResult(argv) {
  const { positional, flags } = parseCommandArgv(argv, ['json']);
  const root = await repoRoot(process.cwd());
  const reference = positional[0] ?? '';
  const jobs = reference ? listJobs(root) : finishedJobs(root);
  const job = matchJobReference(jobs, reference, (candidate) => !isActiveStatus(candidate.status));
  if (!job) {
    const active = matchJobReference(listJobs(root), reference, (candidate) =>
      isActiveStatus(candidate.status),
    );
    if (active)
      throw new Error(`Job ${active.id} is still ${active.status}. Check /cursor:status first.`);
    throw new Error(
      reference
        ? `No finished job found for "${reference}". Run /cursor:status to inspect active jobs.`
        : 'No finished Cursor jobs found for this repository yet.',
    );
  }
  output(flags.json ? { job } : renderStoredResult(job), Boolean(flags.json));
  return 0;
}

async function handleCancel(argv) {
  const { positional, flags } = parseCommandArgv(argv, ['json']);
  const root = await repoRoot(process.cwd());
  const reference = positional[0] ?? '';
  // Explicit ids search every session's jobs, matching status/result; the
  // no-argument form stays scoped to this session.
  const jobs = reference
    ? listJobs(root).filter((job) => isActiveStatus(job.status))
    : activeJobs(root);
  let target;
  if (reference) {
    target = matchJobReference(jobs, reference);
    if (!target) throw new Error(`No active job found for "${reference}".`);
  } else if (jobs.length === 1) {
    target = jobs[0];
  } else if (jobs.length > 1) {
    throw new Error('Multiple Cursor jobs are active. Pass a job id to /cursor:cancel.');
  } else {
    throw new Error('No active Cursor jobs to cancel.');
  }
  const cancelled = await cancelJob(root, target.id);
  const payload = { jobId: cancelled.id, status: cancelled.status, title: cancelled.title };
  output(flags.json ? payload : renderCancelReport(cancelled), Boolean(flags.json));
  return 0;
}

async function buildSetupPayload(cwd) {
  const node = { available: true, detail: process.version };
  const npm = await run('npm', ['--version'], { timeoutMs: 5_000 });
  const npmStatus = {
    available: npm.exitCode === 0,
    detail: npm.exitCode === 0 ? npm.stdout.trim() : npm.stderr.trim() || 'not found',
  };
  let bin = null;
  let cursor = { available: false, detail: 'cursor-agent not found' };
  try {
    bin = await resolveBin();
    const version = await run(bin, ['--version'], { timeoutMs: 5_000 });
    cursor = {
      available: version.exitCode === 0,
      detail: (version.stdout || version.stderr || bin).trim(),
    };
  } catch (err) {
    cursor = { available: false, detail: err instanceof Error ? err.message : String(err) };
  }
  const auth = await authStatus();
  const mcps = bin ? await listConfiguredMcps() : [];
  const models = bin ? await listModels() : [];
  return {
    ready: node.available && cursor.available && auth.loggedIn,
    node,
    npm: npmStatus,
    cursor,
    auth,
    pluginHome: pluginHome(),
    mcps,
    models,
    cwd,
  };
}

function renderSetupReport(report) {
  const lines = [
    '# Cursor Setup',
    '',
    `Status: ${report.ready ? 'ready' : 'needs attention'}`,
    '',
    'Checks:',
    `- node: ${report.node.detail}`,
    `- npm: ${report.npm.detail}`,
    `- cursor-agent: ${report.cursor.detail}`,
    `- auth: ${report.auth.loggedIn ? 'logged in' : report.auth.detail || 'not logged in'}`,
    `- plugin home: ${report.pluginHome}`,
    '',
  ];
  if (report.models.length > 0) {
    lines.push('Models:');
    for (const model of report.models.slice(0, 20)) lines.push(`- ${model}`);
    lines.push('');
  }
  lines.push('Configured Cursor MCPs:');
  if (report.mcps.length === 0) lines.push('- (none configured)');
  else {
    for (const mcp of report.mcps)
      lines.push(`- ${mcp.loaded ? 'ok' : 'pending'} ${mcp.name} — ${mcp.status}`);
  }
  if (!report.ready) {
    lines.push('', 'Next steps:');
    if (!report.cursor.available)
      lines.push('- Install Cursor CLI from https://cursor.com/install.');
    if (report.cursor.available && !report.auth.loggedIn) lines.push('- Run `cursor-agent login`.');
  }
  return `${lines.join('\n').trimEnd()}\n`;
}

async function handleSetup(argv) {
  const { flags } = parseCommandArgv(argv, ['json', 'print-models']);
  const payload = await buildSetupPayload(process.cwd());
  if (flags['print-models'] || flags.printModels) {
    output(
      payload.models.length
        ? payload.models
            .map((m) => `- ${m}`)
            .join('\n')
            .concat('\n')
        : 'No models found.\n',
    );
    return payload.models.length ? 0 : 1;
  }
  output(flags.json ? payload : renderSetupReport(payload), Boolean(flags.json));
  return payload.ready ? 0 : 1;
}

async function handleWorker(argv) {
  const { flags } = parseCommandArgv(argv, []);
  const cwd = typeof flags.cwd === 'string' ? flags.cwd : process.cwd();
  const jobId = typeof flags['job-id'] === 'string' ? flags['job-id'] : flags.jobId;
  if (!jobId) throw new Error('Missing required --job-id.');
  const root = await repoRoot(cwd);
  await runJobWorker(root, jobId);
  return 0;
}

function printUsage() {
  output(
    [
      'Usage:',
      '  node scripts/cursor-companion.mjs setup [--json] [--print-models]',
      '  node scripts/cursor-companion.mjs review [--wait|--background] [--base <ref>] [--scope auto|working-tree|branch] [--model <id>]',
      '  node scripts/cursor-companion.mjs adversarial-review [--wait|--background] [--base <ref>] [--scope auto|working-tree|branch] [--model <id>] [focus...]',
      '  node scripts/cursor-companion.mjs debate [--models a,b|--model-a <id> --model-b <id>] [--rounds <1..5>] [--background|--wait] [issue...]',
      '  node scripts/cursor-companion.mjs task [--background] [--resume|--fresh] [--model <id>] [prompt]',
      '  node scripts/cursor-companion.mjs status [job-id] [--wait] [--all]',
      '  node scripts/cursor-companion.mjs result [job-id]',
      '  node scripts/cursor-companion.mjs cancel [job-id]',
      '',
    ].join('\n'),
  );
}

/**
 * @param {string[]} rawArgv
 * @returns {Promise<number>}
 */
export async function main(rawArgv) {
  const [subcommand, ...argv] = rawArgv;
  switch (subcommand) {
    case undefined:
    case 'help':
    case '--help':
      printUsage();
      return 0;
    case 'setup':
      return handleSetup(argv);
    case 'review':
      return handleReview(argv, false);
    case 'adversarial-review':
      return handleReview(argv, true);
    case 'debate':
      return handleDebate(argv);
    case 'task':
    case 'rescue':
      return handleTask(argv);
    case 'task-worker':
    case 'review-worker':
    case 'debate-worker':
      return handleWorker(argv);
    case 'task-resume-candidate':
      return handleTaskResumeCandidate(argv);
    case 'status':
      return handleStatus(argv);
    case 'result':
      return handleResult(argv);
    case 'cancel':
      return handleCancel(argv);
    default:
      throw new Error(`Unknown subcommand: ${subcommand}`);
  }
}

import { invokedAsScript as __isScript } from './lib/invoked.mjs';
const invokedAsScript = __isScript(import.meta.url);

if (invokedAsScript) {
  main(process.argv.slice(2))
    .then((code) => process.exit(code))
    .catch((err) => {
      process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
      process.exit(1);
    });
}
