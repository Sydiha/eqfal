import { describe, expect, it } from 'vitest';
import i18n from '../i18n';
import { roleDisplayName } from '../labels/displayLabels';

describe('centralized display labels', () => {
  it('localizes built-in roles in both languages and preserves custom role names', () => {
    expect(roleDisplayName('Accountant', i18n.getFixedT('ar'))).toBe('محاسب');
    expect(roleDisplayName('accountant', i18n.getFixedT('ar'))).toBe('محاسب');
    expect(roleDisplayName('Accountant', i18n.getFixedT('en'))).toBe('Accountant');
    expect(roleDisplayName('Custom finance role', i18n.getFixedT('ar'))).toBe('Custom finance role');
  });
});
