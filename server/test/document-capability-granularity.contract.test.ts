import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const migration = readFileSync(new URL('../migrations/044_document_capability_granularity.sql', import.meta.url), 'utf8');
const router = readFileSync(new URL('../src/modules/documents/document.router.ts', import.meta.url), 'utf8');

describe('Documents capability granularity contract', () => {
  it('idempotently backfills both exact capabilities from legacy upload grants', () => {
    expect(migration).toContain("('document.edit')");
    expect(migration).toContain("('document.submit')");
    expect(migration).toContain("WHERE rc.capability_id = 'document.upload'");
    expect(migration.match(/ON CONFLICT/g)).toHaveLength(2);
    expect(migration).not.toMatch(/DELETE|UPDATE/i);
  });

  it('uses upload only for uploads and has no edit or submit fallback', () => {
    expect(router).toContain('requireCapability(UPLOAD_CAPABILITY)');
    expect(router).toContain('requireCapability(EDIT_CAPABILITY)');
    expect(router).toContain('requireCapability(SUBMIT_CAPABILITY)');
    expect(router.match(/requireCapability\(UPLOAD_CAPABILITY\)/g)).toHaveLength(1);
    expect(router.match(/requireCapability\(EDIT_CAPABILITY\)/g)).toHaveLength(1);
    expect(router.match(/requireCapability\(SUBMIT_CAPABILITY\)/g)).toHaveLength(1);
  });
});
