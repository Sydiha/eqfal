import {readFileSync} from 'node:fs';
import {describe,expect,it} from 'vitest';
import {buildStraightLineSchedule} from '../src/modules/fixed-assets/fixed-assets.router';
const migration=readFileSync(new URL('../migrations/024_fixed_assets_foundation.sql',import.meta.url),'utf8');
describe('Fixed Assets Foundation V1 migration',()=>{
 it('creates tenant-scoped category, register, schedule and disposal tables',()=>{for(const table of ['asset_categories','fixed_assets','asset_depreciation_entries','asset_disposals'])expect(migration).toMatch(new RegExp(`CREATE TABLE ${table}`));expect(migration.match(/company_id UUID NOT NULL/g)?.length).toBeGreaterThanOrEqual(4);});
 it('installs the four backend capabilities and fixed state constraints',()=>{for(const capability of ['asset.view','asset.manage','asset.approve','asset.dispose'])expect(migration).toContain(`('${capability}')`);expect(migration).toContain("status IN ('draft','active','fully_depreciated','disposed','cancelled')");expect(migration).toContain("depreciation_method='straight_line'");});
 it('prevents duplicate document assets, depreciation periods and disposals',()=>{expect(migration).toMatch(/fixed_assets_full_document_uidx[\s\S]*source_document_id/i);expect(migration).toContain('UNIQUE(company_id,asset_id,period_start)');expect(migration).toContain('UNIQUE(company_id,asset_id)');});
 it('uses composite tenant foreign keys for sensitive relationships',()=>{for(const relation of ['asset_category_id,company_id','source_document_id,company_id','asset_id,company_id','source_sale_document_id,company_id'])expect(migration).toContain(`FOREIGN KEY(${relation})`);});
});
describe('decimal-safe straight-line schedule',()=>{
 it('calculates equal monthly depreciation and preserves residual value',()=>{const rows=buildStraightLineSchedule('1200.00','120.00','0.00',12,'2026-02-01');expect(rows).toHaveLength(12);expect(rows[0]).toMatchObject({periodStart:'2026-02-01',periodEnd:'2026-02-28',amount:'90.00'});expect(rows.at(-1)?.closingNbv).toBe('120.00');});
 it('reduces remaining depreciation for an opening accumulated balance',()=>{const rows=buildStraightLineSchedule('1200.00','0.00','300.00',12,'2026-01-01');expect(rows).toHaveLength(9);expect(rows[0]).toMatchObject({openingNbv:'900.00',accumulated:'400.00'});expect(rows.at(-1)?.closingNbv).toBe('0.00');});
 it('absorbs the final cent remainder without falling below residual value',()=>{const rows=buildStraightLineSchedule('100.00','10.00','0.00',7,'2026-01-01');expect(rows.map(x=>x.amount)).toEqual(['12.85','12.85','12.85','12.85','12.85','12.85','12.90']);expect(rows.at(-1)?.closingNbv).toBe('10.00');});
});
