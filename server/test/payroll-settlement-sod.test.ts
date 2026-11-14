import { describe,expect,it } from 'vitest';
import { readFileSync } from 'node:fs';
import { approvedSodExceptionIsUnexpired } from '../src/modules/payroll/payroll-settlement';

describe('payroll settlement SoD exception expiry',()=>{
  it('registers explicit approval authority without role grants or policy activation',()=>{
    const migration=readFileSync('migrations/123_payroll_settlement_sod_exceptions.sql','utf8');
    expect(migration).toMatch(/INSERT INTO capabilities\(id, implicit_full_access\)[\s\S]*'payroll\.settlement\.exception\.approve', FALSE/);
    expect(migration).not.toMatch(/INSERT\s+INTO\s+role_capabilities/i);
    expect(migration).not.toMatch(/UPDATE\s+roles\s+SET\s+authorization_policy_version\s*=\s*1/i);
    expect(migration).toContain('REFERENCES payroll_settlement_sod_exceptions(id, company_id)');
    expect(migration).toContain('guard_payroll_settlement_sod_exception_use');
  });

  it('rejects absent, wrong-state, and expired approvals; accepts a live approval',()=>{
    const now='2026-11-14T12:00:00.000Z';
    expect(approvedSodExceptionIsUnexpired('pending','2026-11-15T12:00:00.000Z',now)).toBe(false);
    expect(approvedSodExceptionIsUnexpired('approved',null,now)).toBe(false);
    expect(approvedSodExceptionIsUnexpired('approved','2026-11-14T11:59:59.999Z',now)).toBe(false);
    expect(approvedSodExceptionIsUnexpired('approved','2026-11-14T12:00:00.001Z',now)).toBe(true);
  });
});
