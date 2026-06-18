import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export function makeTempHome() {
  const dir = mkdtempSync(join(tmpdir(), 'cursor-plugin-cc-test-'));
  return {
    dir,
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

export const STUB_BIN = new URL('./fixtures/cursor-agent-stub.mjs', import.meta.url).pathname;
export const HAPPY_FIXTURE = new URL('./fixtures/cursor-events/happy-path.ndjson', import.meta.url)
  .pathname;
export const FAILURE_FIXTURE = new URL('./fixtures/cursor-events/failure.ndjson', import.meta.url)
  .pathname;
export const REVIEW_HAPPY_FIXTURE = new URL(
  './fixtures/cursor-events/review-happy.ndjson',
  import.meta.url,
).pathname;
export const REVIEW_VIOLATION_FIXTURE = new URL(
  './fixtures/cursor-events/review-violation.ndjson',
  import.meta.url,
).pathname;
export const ADVERSARIAL_JSON_FIXTURE = new URL(
  './fixtures/cursor-events/adversarial-json.ndjson',
  import.meta.url,
).pathname;
export const DEBATE_CONSENSUS_FIXTURE = new URL(
  './fixtures/cursor-events/debate-consensus.ndjson',
  import.meta.url,
).pathname;
export const DEBATE_NON_JSON_FIXTURE = new URL(
  './fixtures/cursor-events/debate-non-json.ndjson',
  import.meta.url,
).pathname;
