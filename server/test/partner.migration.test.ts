import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
const sql=readFileSync(new URL('../migrations/016_partners_registry.sql',import.meta.url),'utf8');
const source=readFileSync(new URL('../src/modules/partners/partner.router.ts',import.meta.url),'utf8');
describe('Phase 4A partner integrity',()=>{
 it('adds capabilities without role grants',()=>{expect(sql).toContain("('partner.view'), ('partner.manage')");expect(sql).not.toMatch(/role_capabilities/i)});
 it('keeps partners independent from users and ownership balances',()=>{const table=sql.split('CREATE TABLE partners')[1]!.split('CREATE TABLE partner_ownership')[0]!;expect(table).not.toMatch(/\buser_id\b/);expect(table).not.toContain('ownership_percentage');expect(table).not.toContain('capital_balance');expect(table).toContain('created_by_user_id')});
 it('contains required history fields and versions',()=>{for(const field of ['ownership_percentage','effective_from','effective_to','verification_status','source_document_id','note','version'])expect(sql).toContain(field);expect((sql.match(/version INTEGER NOT NULL DEFAULT 1/g)??[]).length).toBe(2)});
 it('enforces company scoped relationships',()=>{expect(sql).toMatch(/FOREIGN KEY \(partner_id, company_id\)[\s\S]*partners\(id, company_id\)/);expect(sql).toMatch(/FOREIGN KEY \(source_document_id, company_id\)[\s\S]*documents\(id, company_id\)/)});
 it('enforces verification percentage and date rules',()=>{expect(sql).toContain("verification_status IN ('unconfirmed','confirmed')");expect(sql).toMatch(/ownership_percentage > 0 AND ownership_percentage <= 100/);expect(sql).toMatch(/effective_to >= effective_from/);expect(sql).toMatch(/verification_status = 'unconfirmed'[\s\S]*ownership_percentage IS NOT NULL AND effective_from IS NOT NULL/)});
 it('preserves unknown values and never defaults them',()=>{expect(sql).not.toMatch(/ownership_percentage[^\n]*DEFAULT/);expect(sql).not.toMatch(/effective_from[^\n]*DEFAULT/)});
 it('enforces backend capabilities and safe tenant queries',()=>{expect(source).toContain("requireCapability('partner.view')");expect(source).toContain("requireCapability('partner.manage')");expect((source.match(/company_id=\$2/g)??[]).length).toBeGreaterThan(3)});
 it('uses transactions, locks, and optimistic versions',()=>{expect(source).toContain('pg_advisory_xact_lock');expect(source).toContain('FOR UPDATE');expect(source).toContain('version=version+1');expect(source).toContain('before.version!==version')});
 it('rejects overlaps and validates same-company documents',()=>{expect(source).toContain('daterange(effective_from');expect(source).toMatch(/documents WHERE id=\$1 AND company_id=\$2/)});
 it('records every required audit action',()=>{for(const action of ['partner.create','partner.update','partner.disable','partner_ownership.create','partner_ownership.update','partner_ownership.confirm'])expect(source).toContain(action)});
 it('has no hard delete endpoint',()=>expect(source).not.toMatch(/partnerRouter\.delete/i));
});
