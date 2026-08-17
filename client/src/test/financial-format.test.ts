import { describe, expect, it } from 'vitest';
import { financialStatusColor, formatFinancialAmount } from '../financial-format';

describe('financial display helpers',()=>{
  it('formats monetary values with stable two-decimal grouping and currency',()=>{
    expect(formatFinancialAmount('1234.5','SAR','en')).toBe('1,234.50 SAR');
    expect(formatFinancialAmount('-500','SAR','ar')).toBe('-500.00 SAR');
    expect(formatFinancialAmount(null,'SAR','en')).toBe('—');
  });

  it('maps financial workflow states to consistent semantic colors',()=>{
    expect(financialStatusColor('reconciled')).toBe('green');
    expect(financialStatusColor('matched')).toBe('blue');
    expect(financialStatusColor('mapping_required')).toBe('orange');
    expect(financialStatusColor('invalid')).toBe('red');
    expect(financialStatusColor('unmatched')).toBe('gray');
  });
});
