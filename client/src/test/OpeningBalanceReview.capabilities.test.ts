import {readFileSync} from 'node:fs';
import {describe,expect,it} from 'vitest';

const app=readFileSync('src/App.tsx','utf8');
const component=readFileSync('src/components/OpeningBalanceReview.tsx','utf8');

describe('Opening Balance frontend capability contract',()=>{
 it('maps each action capability to an independent component flag',()=>{
  for(const [prop,capability] of [['canCreate','opening_balance.item.create'],['canEdit','opening_balance.item.edit'],['canDelete','opening_balance.item.delete'],['canSubmit','opening_balance.submit'],['canReview','opening_balance.review'],['canApprove','opening_balance.approve']])expect(app).toContain(`${prop}={c.includes('${capability}')}`);
  expect(app).not.toContain("opening_balance.manage");
  expect(component).not.toContain('canManage');
 });
});
