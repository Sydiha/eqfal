import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const router = readFileSync(new URL('../src/modules/annual-closing/annual-closing.router.ts', import.meta.url), 'utf8');
const service = readFileSync(new URL('../src/modules/annual-closing/annual-closing.service.ts', import.meta.url), 'utf8');
const migration = readFileSync(new URL('../migrations/032_annual_closing_view.sql', import.meta.url), 'utf8');

describe('Phase 7A annual closing contract', () => {
  it('adds only the annual view capability and protects the read-only endpoint', () => {
    expect(migration).toContain("'annual_close.view'"); expect(migration).not.toMatch(/annual_close\.(close|reopen|approve|finalize)/);
    expect(router).toContain("get('/annual-closing/:fiscalYearId'"); expect(router).toContain("requireCapability('annual_close.view')");
    expect(router).not.toMatch(/annualClosingRouter\.(post|put|patch|delete)/);
  });
  it('validates tenant-owned fiscal-year scope without cross-company leakage', () => {
    expect(service).toContain('WHERE id=$1 AND company_id=$2'); expect(router).toContain("res.status(404).json({ error: 'Not found' })");
  });
  it('keeps every source query company scoped and the endpoint mutation-free', () => {
    expect(service.match(/company_id=\$1/g)?.length).toBeGreaterThan(15);
    expect(service).not.toMatch(/\b(INSERT|UPDATE|DELETE)\b/); expect(router).not.toMatch(/audit/i);
  });
  it('implements canonical blocker semantics and year-end obligation balances', () => {
    for (const term of ["j.status='draft'", "status='posted'", "r.status <> 'filed'", "reconciliation_status<>'reconciled'", "verification_status='unconfirmed'", "status='pending'", "status<>'approved'"]) expect(service).toContain(term);
    expect(service).toContain("o.direction='receivable'"); expect(service).toContain("o.direction='payable'");
    expect(service).toContain('open_receivable_balance'); expect(service).toContain('open_payable_balance');
  });
  it('surfaces VAT boundary review, ownership gaps, and governed tax readiness conservatively', () => {
    expect(service).toContain('boundary_review_periods'); expect(service).toContain('ownership_gaps_needing_review');
    expect(service).toContain('calculation_performed:false'); expect(service).toContain("workpaper_status:workpaper?.workflow_status??'not_started'");
    expect(service).toContain("status='blocked'"); expect(service).toContain("status='ready'");
  });
});
