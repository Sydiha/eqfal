import { describe, expect, it } from 'vitest';
import { grantImpact, needsExplicitConfirmation, newlyGranted, roleChangeImpact } from '../components/accessRisk';

const sensitivity = { 'invoice.approve': 'sensitive', 'fiscal_year.close': 'critical', 'accounting.journal.post': 'critical' } as const;
const all = ['invoice.view', 'invoice.approve', 'fiscal_year.close', 'accounting.journal.post'];

describe('accessRisk', () => {
  it('counts only newly granted capabilities (revocations and unchanged ones are ignored)', () => {
    expect(newlyGranted(['invoice.view', 'invoice.approve'], ['invoice.approve', 'fiscal_year.close'])).toEqual(['fiscal_year.close']);
    expect(grantImpact([], sensitivity)).toEqual({ risk: 'normal', flagged: [] });
    expect(grantImpact(['invoice.view'], sensitivity).risk).toBe('normal');
  });

  it('ranks critical above sensitive and lists critical first', () => {
    const impact = grantImpact(['invoice.approve', 'fiscal_year.close'], sensitivity);
    expect(impact.risk).toBe('critical');
    expect(impact.flagged.map((f) => f.id)).toEqual(['fiscal_year.close', 'invoice.approve']);
    expect(grantImpact(['invoice.approve'], sensitivity).risk).toBe('sensitive');
  });

  it('treats moving onto Full Access as the strongest risk unless the member already has it', () => {
    const viewer = { id: 'v', is_full_access: false, capabilities: ['invoice.view'] };
    const full = { id: 'f', is_full_access: true, capabilities: [] };
    const toFull = roleChangeImpact(viewer, full, all, sensitivity);
    expect(toFull.risk).toBe('full_access');
    expect(toFull.granted.sort()).toEqual(['accounting.journal.post', 'fiscal_year.close', 'invoice.approve']);
    expect(roleChangeImpact(full, { id: 'f2', is_full_access: true, capabilities: [] }, all, sensitivity).risk).toBe('normal');
    expect(roleChangeImpact(full, viewer, all, sensitivity).risk).toBe('normal'); // a downgrade grants nothing
  });

  it('requires an explicit tick only for critical and Full Access', () => {
    expect(needsExplicitConfirmation('normal')).toBe(false);
    expect(needsExplicitConfirmation('sensitive')).toBe(false);
    expect(needsExplicitConfirmation('critical')).toBe(true);
    expect(needsExplicitConfirmation('full_access')).toBe(true);
  });
});
