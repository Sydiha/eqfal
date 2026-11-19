import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { ZAKAT_ENGINE_VERSION, ZAKAT_REFERENCE_SUITE_DIGEST, currentB9Facts } from '../src/modules/zakat-calculation/zakat-approval-binding';
import { decisionStatus, validGateFacts, type GateDecision } from '../src/modules/zakat-worksheets/zakat-finalization';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const engineSources = [
  'server/src/modules/zakat-calculation/zakat-approval-binding.ts',
  'server/src/modules/zakat-calculation/calculation-input.ts',
  'server/src/modules/zakat-calculation/zakat-base-composition.ts',
  'server/src/modules/zakat-calculation/zakat-base-engine.ts',
  'server/src/modules/zakat-calculation/zakat-calculation.ts',
  'server/src/modules/zakat-worksheets/zakat-finalization.ts',
  'server/src/modules/zakat-worksheets/zakat-worksheet.service.ts',
  'server/src/modules/zakat-worksheets/zakat-worksheet.router.ts',
  'server/src/modules/zakat-worksheets/zakat-worksheet.rules.ts',
  'server/src/modules/zakat-worksheets/zakat-worksheet.preview.ts',
  'server/src/modules/accounting/financial-statements.ts',
];
const digest = (files: string[]) => {
  const hash = createHash('sha256');
  for (const file of [...files].sort()) {
    let source = readFileSync(resolve(root, file));
    if (file.endsWith('/zakat-approval-binding.ts')) {
      // Exclude only the two digest values to avoid a self-referential hash.
      source = Buffer.from(source.toString()
        .replace(/(export const ZAKAT_ENGINE_VERSION = ')sha256:[0-9a-f]{64}(';)/, '$1<engine-version>$2')
        .replace(/(export const ZAKAT_REFERENCE_SUITE_DIGEST = ')sha256:[0-9a-f]{64}(';)/, '$1<suite-digest>$2'));
    }
    hash.update(file).update('\0').update(source).update('\0');
  }
  return `sha256:${hash.digest('hex')}`;
};

describe('B9 immutable calculation and reference binding', () => {
  it('covers the complete numerical reference suite and every trusted calculation source', () => {
    expect(ZAKAT_ENGINE_VERSION).toBe(digest(engineSources));
    expect(ZAKAT_REFERENCE_SUITE_DIGEST).toBe(digest(['server/test/zakat-reference-cases.test.ts']));
  });

  it('rejects absent, empty, extra, and replayed binding values', () => {
    const facts = currentB9Facts();
    expect(validGateFacts('B9', facts)).toBe(true);
    for (const invalid of [
      {},
      { ...facts, engineVersion: '' },
      { ...facts, referenceSuiteDigest: '' },
      { ...facts, engineVersion: `sha256:${'0'.repeat(64)}` },
      { ...facts, referenceSuiteDigest: `sha256:${'0'.repeat(64)}` },
      { ...facts, reviewedBy: 'caller' },
    ]) expect(validGateFacts('B9', invalid)).toBe(false);
  });

  it('marks legacy and outdated approved B9 decisions stale even when other evidence is current', () => {
    const facts = currentB9Facts();
    const approved = {
      gate: 'B9', facts, engine_version: facts.engineVersion, reference_suite_digest: facts.referenceSuiteDigest,
      source_fingerprint: 'source', evidence_current: true, reviewer_active: true,
      reviewed_by: 'reviewer', approved_at: '2025-01-01', ended_at: null, stale_at: null,
    } as GateDecision;
    expect(decisionStatus(approved, 'source')).toBe('verified');
    expect(decisionStatus({ ...approved, engine_version: null }, 'source')).toBe('stale');
    expect(decisionStatus({ ...approved, reference_suite_digest: null }, 'source')).toBe('stale');
    expect(decisionStatus({ ...approved, engine_version: `sha256:${'0'.repeat(64)}` }, 'source')).toBe('stale');
    expect(decisionStatus({ ...approved, reference_suite_digest: `sha256:${'0'.repeat(64)}` }, 'source')).toBe('stale');
    expect(decisionStatus({ ...approved, stale_at: '2025-01-02', evidence_current: true }, 'source')).toBe('stale');
  });
});
