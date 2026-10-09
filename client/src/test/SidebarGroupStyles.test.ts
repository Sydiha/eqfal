import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const css = readFileSync(resolve(__dirname, '../shell-corrective.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
const rule = (selector: string) => css.split('}').map(block => block.trim()).find(block => block.startsWith(`${selector} {`)) ?? '';

describe('sidebar group header styles', () => {
  it('uses the readable #8fa8bf label color on the navy sidebar', () => {
    expect(rule('.eqfal-nav-group__label')).toContain('color: #8fa8bf');
  });

  it('overrides the global button hover so group headers never turn white or gray-bordered', () => {
    const hover = rule('.eqfal-nav-group__toggle:hover');
    expect(hover).toContain('border-color: transparent');
    expect(hover).toMatch(/background: rgba\(255, 255, 255, \.055\)/);
    expect(hover).not.toMatch(/#f8fafc|#94a3b8/i);
  });
});
