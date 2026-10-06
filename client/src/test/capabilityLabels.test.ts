import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { capabilityLabel } from '../labels/capabilityLabels';
import { auditActionLabel } from '../labels/auditLabels';

const IDS = readFileSync(resolve(__dirname, 'fixtures/capability-ids.txt'), 'utf8').trim().split('\n');

describe('capability labels', () => {
  it('covers every known capability with natural Arabic (no Latin text) and a non-fallback English label', () => {
    expect(IDS.length).toBe(127);
    for (const id of IDS) {
      expect(capabilityLabel(id, 'ar'), id).not.toMatch(/[A-Za-z]/);
      expect(capabilityLabel(id, 'en'), id).not.toBe(id.replace(/[._]+/g, ' '));
    }
  });
  it('uses explicit natural Arabic for access administration and avoids duplicated words', () => {
    expect(capabilityLabel('access.manage', 'ar')).toBe('إدارة الصلاحيات');
    expect(capabilityLabel('access.membership.create', 'ar')).toBe('إنشاء عضوية مستخدم');
    expect(capabilityLabel('access.membership.role.assign', 'ar')).toBe('تعيين دور للعضو');
    expect(capabilityLabel('access.membership.status.edit', 'ar')).toBe('تعديل حالة العضوية');
    expect(capabilityLabel('access.role.capability.grant', 'ar')).toBe('منح صلاحيات للدور');
    expect(capabilityLabel('access.role.capability.revoke', 'ar')).toBe('سحب صلاحيات من الدور');
    for (const id of IDS) { const words = capabilityLabel(id, 'ar').split(' '); words.forEach((w, i) => expect(w, id).not.toBe(words[i - 1])); }
  });
  it('falls back readably for unknown capabilities', () => {
    expect(capabilityLabel('new_area.do_thing', 'en')).toBe('new area do thing');
  });
});

describe('audit action labels', () => {
  it('unknown actions are Arabic-only in Arabic and readable English otherwise', () => {
    expect(auditActionLabel('x.y_z', 'ar')).not.toMatch(/[A-Za-z]/);
    expect(auditActionLabel('x.y_z', 'en')).toBe('X y z');
  });
});
