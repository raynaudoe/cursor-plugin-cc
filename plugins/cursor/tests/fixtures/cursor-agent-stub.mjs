#!/usr/bin/env node
// Test stub for `cursor-agent`. Emits a fixture NDJSON stream chosen by
// the CURSOR_AGENT_STUB_FIXTURE env var, then exits.
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';

const argv = process.argv.slice(2);
if (process.env.CURSOR_AGENT_STUB_ARGV_LOG) {
  if (process.env.CURSOR_AGENT_STUB_ARGV_LOG_MODE === 'append') {
    appendFileSync(process.env.CURSOR_AGENT_STUB_ARGV_LOG, `${JSON.stringify(argv)}\n`, 'utf8');
  } else {
    writeFileSync(process.env.CURSOR_AGENT_STUB_ARGV_LOG, JSON.stringify(argv, null, 2), 'utf8');
  }
}

if (argv.includes('--version')) {
  process.stdout.write('cursor-agent-stub 1.0.0\n');
  process.exit(0);
}

if (argv[0] === 'status') {
  process.stdout.write('logged in as test@example.com\n');
  process.exit(0);
}

if (argv.includes('--list-models') || argv[0] === 'models') {
  process.stdout.write(['auto', 'composer-2.5-fast', 'composer-2.5', 'gpt-5.3-codex'].join('\n'));
  process.stdout.write('\n');
  process.exit(0);
}

if (argv[0] === 'mcp' && argv[1] === 'list') {
  process.stdout.write('chrome-devtools: loaded\n');
  process.exit(0);
}

const fixture = process.env.CURSOR_AGENT_STUB_FIXTURE;
if (!fixture) {
  process.stderr.write('stub: CURSOR_AGENT_STUB_FIXTURE not set\n');
  process.exit(2);
}

let content;
try {
  content = readFileSync(fixture, 'utf8');
} catch (err) {
  process.stderr.write(`stub: failed to read fixture ${fixture}: ${err.message}\n`);
  process.exit(2);
}

const lines = content.split('\n').filter((l) => l.length > 0);
let failure = false;
for (const line of lines) {
  process.stdout.write(line + '\n');
  try {
    const parsed = JSON.parse(line);
    if (parsed && parsed.type === 'result' && parsed.is_error === true) {
      failure = true;
    }
  } catch {
    /* noop */
  }
}

if (process.env.CURSOR_AGENT_STUB_HANG === '1') {
  // Simulate cursor-agent not self-exiting after `result`.
  setInterval(() => {}, 1_000);
} else {
  process.exit(failure ? 1 : 0);
}
