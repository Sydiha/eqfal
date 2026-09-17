import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = resolve(__dirname, '..', '..');
const read = (path: string) => readFileSync(resolve(root, path), 'utf8');

describe('document capability granularity contract', () => {
  it('adds exact idempotent capabilities and backfills upload holders without deleting legacy grants', () => {
    const migration = read('server/migrations/044_document_capability_granularity.sql');
    expect(migration.match(/\('document\.edit'\)/g)).toHaveLength(2);
    expect(migration.match(/\('document\.submit'\)/g)).toHaveLength(2);
    expect(migration).toContain("WHERE rc.capability_id = 'document.upload'");
    expect(migration.match(/ON CONFLICT \(.*?\) DO NOTHING/g)).toHaveLength(2);
    expect(migration).not.toMatch(/DELETE|UPDATE/i);
  });

  it('has no upload fallback in edit or submit runtime authorization', () => {
    const router = read('server/src/modules/documents/document.router.ts');
    expect(router).toMatch(/'\/documents\/:id\/submit-review'[\s\S]*?requireCapability\(SUBMIT_CAPABILITY\)/);
    expect(router).toMatch(/'\/documents\/:id\/intake'[\s\S]*?requireCapability\(EDIT_CAPABILITY\)/);
    const client = read('client/src/components/Documents.tsx');
    expect(client).toContain("canEdit&&selected.status==='uploaded'");
    expect(client).toContain("canSubmit&&selected.status==='uploaded'");
    const app = read('client/src/App.tsx');
    expect(app).toContain("canEdit={c.includes('document.edit')}");
    expect(app).toContain("canSubmit={c.includes('document.submit')}");
  });
});
