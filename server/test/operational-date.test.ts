import{describe,expect,it}from'vitest';
import{OPERATIONAL_TIME_ZONE,operationalDate}from'../src/operational-date';

describe('operationalDate',()=>{
 it('uses the Riyadh business day instead of UTC around local midnight',()=>{
  expect(OPERATIONAL_TIME_ZONE).toBe('Asia/Riyadh');
  expect(operationalDate(new Date('2026-08-24T20:59:59.999Z'))).toBe('2026-08-24');
  expect(operationalDate(new Date('2026-08-24T21:00:00.000Z'))).toBe('2026-08-25');
 });

 it('does not advance merely because UTC crosses midnight while Riyadh is already on the same business day',()=>{
  expect(operationalDate(new Date('2026-08-24T23:59:59.999Z'))).toBe('2026-08-25');
  expect(operationalDate(new Date('2026-08-25T00:00:00.000Z'))).toBe('2026-08-25');
 });
});
