import { describe, expect, it } from 'vitest';
import { canShowNavigationPage } from '../components/navigationVisibility';

describe('navigation visibility', () => {
  it('exposes annual closing only to its viewers or explicit Zakat reviewer administrators', () => {
    expect(canShowNavigationPage('annualClosing', ['annual_close.view'])).toBe(true);
    expect(canShowNavigationPage('annualClosing', ['zakat.reviewer.manage'])).toBe(true);
    expect(canShowNavigationPage('annualClosing', ['tax_workpaper.view'])).toBe(false);
  });
});
