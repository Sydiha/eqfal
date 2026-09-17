import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = resolve(__dirname, '..', '..');
const read = (path: string) => readFileSync(resolve(root, path), 'utf8');

describe('Wave A completion frontend capability cleanup', () => {
  it('uses granular A2 capabilities in cross-workspace frontend entry points', () => {
    const app = read('client/src/App.tsx');
    expect(app).toContain("canManageCounterparties={Boolean(documentEntry)&&c.includes('counterparty.create')}");
    expect(app).toContain("<Sales canView={c.includes('document.view')&&c.includes('obligation.view')} canManage={c.includes('obligation.create')}");
    expect(app).toContain("<Purchases canView={c.includes('document.view')&&c.includes('obligation.view')} canManage={c.includes('obligation.create')}");
    expect(app).not.toContain("canManageCounterparties={Boolean(documentEntry)&&c.includes('obligation.manage')}");
    expect(app).not.toContain("canManage={c.includes('obligation.manage')}");
  });

  it('has no legacy annual package manage fallback in the frontend component', () => {
    const annualClosing = read('client/src/components/AnnualClosing.tsx');
    expect(annualClosing).not.toContain('canManagePackage');
    expect(annualClosing).toContain('canCreatePackage&&');
    expect(annualClosing).toContain('canCreatePackageSnapshot&&');
  });
});
