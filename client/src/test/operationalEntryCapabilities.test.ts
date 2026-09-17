import { describe, expect, it } from 'vitest';
import { canStartOperationalDocumentEntry } from '../components/operationalEntryCapabilities';

describe('operational entry capability contract', () => {
  it('requires the complete document entry and operational discovery capability set', () => {
    expect(canStartOperationalDocumentEntry([
      'document.view',
      'document.upload',
      'document.edit',
      'obligation.view',
    ])).toBe(true);

    for (const missing of ['document.view', 'document.upload', 'document.edit', 'obligation.view']) {
      const capabilities = ['document.view', 'document.upload', 'document.edit', 'obligation.view'].filter(
        capability => capability !== missing,
      );
      expect(canStartOperationalDocumentEntry(capabilities)).toBe(false);
    }
  });
});
