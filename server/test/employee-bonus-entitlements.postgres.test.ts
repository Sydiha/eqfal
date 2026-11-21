import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startHarness } from './helpers/http-pg';

const postgres = process.env['DATABASE_URL'] ? describe : describe.skip;

postgres('bonus entitlement calculations', () => {
  let harness: Awaited<ReturnType<typeof startHarness>>;
  beforeAll(async () => { harness = await startHarness(); });
  afterAll(async () => { await harness?.close(); });

  it('calculates each method exactly and freezes approved inputs', async () => {
    const owner = await harness.user('bonus-owner');
    const company = await harness.company('bonus entitlement', owner.id);
    const [employee] = await harness.q<{ id: string }>(
      "INSERT INTO employees(company_id,employee_number,display_name,created_by) VALUES($1,'1','Employee',$2) RETURNING id",
      [company, owner.id],
    );
    const cases = [
      ['basic_multiplier', null, '3', '3000.03'],
      ['total_multiplier', null, '2', '2500.02'],
      ['percentage', 'basic', '12.5', '125.00'],
      ['percentage', 'total', '12.5', '156.25'],
      ['fixed', null, '45.25', '45.25'],
      ['fixed', null, '0', '0.00'],
    ] as const;
    for (const [method, basis, value, expected] of cases) {
      const [bonus] = await harness.q<{ id: string; amount: string }>(
        `INSERT INTO employee_bonus_entitlements(
          company_id,employee_id,request_key,frequency,period_start,period_end,
          eligibility_condition,recognition_condition,calculation_method,percentage_basis,
          calculation_value,basic_salary,applicable_allowances,created_by,award_code
        ) VALUES ($1,$2,$3,'quarterly','2026-01-01','2026-03-31','Eligibility','Condition',$4,$5,$6,1000.01,250,$7,$8)
        RETURNING id,amount::text`,
        [company, employee!.id, randomUUID(), method, basis, value, owner.id, `award-${method}-${basis??value.replace('.', '-')}`],
      );
      expect(bonus!.amount).toBe(expected);
      await harness.q('UPDATE employee_bonus_entitlements SET approved_by=$2,approved_at=now() WHERE id=$1', [bonus!.id, owner.id]);
      await expect(harness.q('UPDATE employee_bonus_entitlements SET basic_salary=2000 WHERE id=$1', [bonus!.id]))
        .rejects.toMatchObject({ code: '55000' });
    }
  });
  it('blocks a closed recognition date and posts a documented open date once', async () => {
    const owner = await harness.user('bonus-recognizer');
    const company = await harness.company('bonus recognition', owner.id);
    await owner.client.login();
    await harness.fiscalYear(company, 'Closed', '2024-01-01', '2024-12-31', 'closed');
    const openYear = await harness.fiscalYear(company, 'Open', '2025-01-01', '2025-12-31');
    const expense = await harness.account(company, 'BONUS-EXP', 'expense');
    const liability = await harness.account(company, 'BONUS-DUE', 'liability');
    const [employee] = await harness.q<{ id: string }>(
      "INSERT INTO employees(company_id,employee_number,display_name,created_by) VALUES($1,'1','Employee',$2) RETURNING id",
      [company, owner.id],
    );
    const approver = await harness.user('recognition-approval-actor');
    await harness.member(company,approver.id,['employee.view','employee_cost.salary.view','employee_cost.approve','accounting.journal.post']);
    await approver.client.login();
    const [bonus] = await harness.q<{ id: string }>(`
      INSERT INTO employee_bonus_entitlements(company_id,employee_id,request_key,frequency,period_start,period_end,
        eligibility_condition,recognition_condition,calculation_method,calculation_value,basic_salary,
        applicable_allowances,created_by,approved_by,approved_at)
      VALUES ($1,$2,$3,'annual','2024-01-01','2024-12-31','Employee eligible','Targets verified',
        'fixed',100,0,0,$4,$5,now()) RETURNING id
    `, [company, employee!.id, randomUUID(), owner.id, approver.id]);
    const url = `/employee-bonuses/${bonus!.id}/recognition`;
    const body = {
      fulfilled_on: '2024-12-31', accounting_date: '2024-12-31', evidence: 'Signed results',
      expense_account_id: expense, liability_account_id: liability,
    };
    expect((await owner.client.req('POST', url, body)).status).toBe(403);
    expect((await approver.client.req('POST', url, body)).status).toBe(403);
    const recognizer = await harness.user('independent-recognizer');
    await harness.member(company,recognizer.id,['employee.view','employee_cost.salary.view','employee_cost.approve','accounting.journal.post']);
    await recognizer.client.login();
    expect((await recognizer.client.req('POST', url, body)).status).toBe(409);
    const revised = { ...body, accounting_date: '2025-01-01', date_reason: 'Finance approved treatment in the open period' };
    const responses = await Promise.all([recognizer.client.req('POST', url, revised), recognizer.client.req('POST', url, revised)]);
    expect(responses.map(response => response.status).sort()).toEqual([200, 201]);
    expect(responses[0]!.json.journal_id).toBe(responses[1]!.json.journal_id);
    expect(await harness.count("SELECT COUNT(*) n FROM journal_entries WHERE company_id=$1 AND source_id=$2 AND status='posted'", [company, bonus!.id])).toBe(1);

    // Fixture journals isolate the database balance invariant from settlement posting.
    const fixtures = await Promise.all([1, 2, 3].map(() =>
      harness.postedJournal(company, openYear, '2025-01-02', owner.id, [
        [liability, '60', '0'], [expense, '0', '60'],
      ]),
    ));
    const keys = [randomUUID(), randomUUID()];
    const insertBalance = (kind: string, journal: string, requestKey = randomUUID(), amount = '60') =>
      harness.q(`INSERT INTO employee_bonus_balance_entries(
        company_id,entitlement_id,journal_id,idempotency_key,kind,amount,created_by
      ) VALUES ($1,$2,$3,$4,$5,$6,$7)`, [company, bonus!.id, journal, requestKey, kind, amount, owner.id]);
    const settlements = await Promise.allSettled([
      insertBalance('payroll', fixtures[0]!, keys[0]!),
      insertBalance('bank', fixtures[1]!, keys[1]!),
    ]);
    expect(settlements.filter(result => result.status === 'fulfilled')).toHaveLength(1);
    expect(settlements.find(result => result.status === 'rejected')).toMatchObject({ reason: { code: '23514' } });
    const winningKey = keys[settlements.findIndex(result => result.status === 'fulfilled')]!;
    await expect(insertBalance('bank', fixtures[2]!, winningKey, '1')).rejects.toMatchObject({ code: '23505' });
    await expect(insertBalance('bank', fixtures[2]!, randomUUID(), '41')).rejects.toMatchObject({ code: '23514' });
    await insertBalance('bank', fixtures[2]!, randomUUID(), '40');
  });
  it('creates an employee batch, enforces independent approval, and caps scheduled installments', async () => {
    const creator=await harness.user('bonus-draft-creator');
    const approver=await harness.user('bonus-draft-approver');
    const owner=await harness.user('bonus-draft-owner');
    const company=await harness.company('bonus drafts',owner.id);
    const common=['employee.view','employee_cost.salary.view','employee_cost.view'];
    await harness.member(company,creator.id,[...common,'employee_cost.create','employee_cost.approve']);
    await harness.member(company,approver.id,[...common,'employee_cost.approve','employee_cost.payment.allocate']);
    await creator.client.login();
    await approver.client.login();
    const employees=await harness.q<{id:string}>(`
      INSERT INTO employees(company_id,employee_number,display_name,created_by)
      VALUES($1,'B1','First employee',$2),($1,'B2','Second employee',$2) RETURNING id
    `,[company,owner.id]);
    const draftBody={
      request_key:randomUUID(),frequency:'quarterly',period_start:'2026-01-01',period_end:'2026-03-31',
      eligibility_condition:'Employment',recognition_condition:'Targets confirmed',
      employees:employees.map(({id},index)=>({employee_id:id,method:'fixed',value:index?'0':'100',basic_salary:'0',allowances:'0'})),
    };
    const created=await creator.client.req('POST','/employee-bonuses',draftBody);
    expect((await creator.client.req('POST','/employee-bonuses',{...draftBody,request_key:randomUUID()})).status).toBe(409);
    expect((await creator.client.req('POST','/employee-bonuses',{...draftBody,request_key:randomUUID(),award_code:'retention'})).status).toBe(201);
    expect(created.status,JSON.stringify(created.json)).toBe(201);
    expect(created.json.bonuses.map((b:{amount:string})=>b.amount)).toEqual(['100.00','0.00']);
    const path=`/employee-bonuses/${created.json.bonuses[0].id}`;
    expect((await creator.client.req('POST',`${path}/approval`,{})).status).toBe(403);
    expect((await approver.client.req('POST',`${path}/approval`,{})).status).toBe(200);
    const schedule={request_key:randomUUID(),due_on:'2026-04-01',amount:'60',channel:'bank'};
    const pay=(body:typeof schedule)=>approver.client.req('POST',`${path}/schedule`,body);
    expect((await pay(schedule)).status).toBe(201);
    expect((await pay(schedule)).status).toBe(200);
    expect((await pay({...schedule,request_key:randomUUID()})).status).toBe(409);
    const balances=await approver.client.req('GET','/employee-bonuses');
    expect(balances.status).toBe(200);
    expect(balances.json.bonuses.find((b:{id:string})=>b.id===created.json.bonuses[0].id).schedule).toEqual([expect.objectContaining({amount:'60.00',channel:'bank'})]);
  });
});
