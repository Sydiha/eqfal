import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const css = readFileSync(resolve(__dirname, '../shell-corrective.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
const rule = (selector: string) => css.split('}').map(block => block.trim()).find(block => block.startsWith(`${selector} {`)) ?? '';

describe('sidebar group header styles', () => {
  it('uses a readable 14px / 600 #c3d3e3 label that the chevron inherits', () => {
    const label = rule('.eqfal-nav-group__label');
    expect(label).toContain('color: #c3d3e3');
    expect(label).toContain('font-size: 14px');
    expect(label).toContain('font-weight: 600');
    expect(rule('.eqfal-nav-group__chevron')).toMatch(/width: 18px;\s*height: 18px/);
  });

  it('overrides the global button hover so group headers never turn white or gray-bordered', () => {
    const hover = rule('.eqfal-nav-group__toggle:hover');
    expect(hover).toContain('border-color: transparent');
    expect(hover).toMatch(/background: rgba\(255, 255, 255, \.055\)/);
    expect(hover).not.toMatch(/#f8fafc|#94a3b8/i);
  });
});
