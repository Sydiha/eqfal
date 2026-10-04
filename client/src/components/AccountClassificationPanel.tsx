import { useEffect, useState } from 'react';
import { AccountResponse, CashFlowCategory, CashRole, StatementCategory } from './accounting-contracts';

interface Props{
  canView:boolean;
  canManage:boolean;
  onUnauthorized:()=>void;
  autoOpen?:boolean;
}

const CATEGORY_LABELS:Record<StatementCategory,string>={
  unmapped:'Unmapped / غير مصنف',
  current_asset:'Current asset / أصل متداول',
  non_current_asset:'Non-current asset / أصل غير متداول',
  current_liability:'Current liability / التزام متداول',
  non_current_liability:'Non-current liability / التزام غير متداول',
  equity:'Equity / حقوق الملكية',
  revenue:'Revenue / الإيرادات',
  cost_of_sales:'Cost of sales / تكلفة المبيعات',
  operating_expense:'Operating expense / مصروف تشغيلي',
  finance_income:'Finance income / دخل تمويلي',
  finance_expense:'Finance expense / مصروف تمويلي',
  other_income:'Other income / دخل آخر',
  other_expense:'Other expense / مصروف آخر',
};
const COMPATIBLE:Record<AccountResponse['account_type'],readonly StatementCategory[]>={
  asset:['unmapped','current_asset','non_current_asset'],
  liability:['unmapped','current_liability','non_current_liability'],
  equity:['unmapped','equity'],
  revenue:['unmapped','revenue','finance_income','other_income'],
  expense:['unmapped','cost_of_sales','operating_expense','finance_expense','other_expense'],
};
const ALL_CATEGORIES=Object.keys(CATEGORY_LABELS) as StatementCategory[];
const shortLabel=(label:string)=>label.split(' / ')[0]!;
const TYPE_LABELS:Record<AccountResponse['account_type'],string>={asset:'أصل',liability:'التزام',equity:'حقوق ملكية',revenue:'إيراد',expense:'مصروف'};
const CASH_ROLE_LABELS:Record<CashRole,string>={
  non_cash:'Non-cash / غير نقدي',
  cash:'Cash / نقد',
  cash_equivalent:'Cash equivalent / ما يعادل النقد',
};
const CASH_FLOW_LABELS:Record<CashFlowCategory,string>={
  unmapped:'Unmapped / غير مصنف',
  operating:'Operating / تشغيلي',
  investing:'Investing / استثماري',
  financing:'Financing / تمويلي',
};
const CASH_FLOW_CATEGORIES=Object.keys(CASH_FLOW_LABELS) as CashFlowCategory[];
type Draft={statement_category:StatementCategory;is_contra:boolean;cash_role:CashRole;cash_flow_category:CashFlowCategory};

async function request(url:string,options:RequestInit,onUnauthorized:()=>void){
  const response=await fetch(url,{credentials:'same-origin',...options});
  if(response.status===401)onUnauthorized();
  if(!response.ok)throw new Error(String(response.status));
  return response;
}

export function AccountClassificationPanel({canView,canManage,onUnauthorized,autoOpen=false}:Props){
  const [opened,setOpened]=useState(autoOpen);
  const [filter,setFilter]=useState<StatementCategory|'all'>(autoOpen?'all':'unmapped');
  const [accounts,setAccounts]=useState<AccountResponse[]>([]);
  const [drafts,setDrafts]=useState<Record<string,Draft>>({});
  const [loading,setLoading]=useState(false);
  const [error,setError]=useState(false);
  const [saving,setSaving]=useState<string|null>(null);

  const load=async(nextFilter:StatementCategory|'all'=filter)=>{
    if(!canView)return;
    setLoading(true);setError(false);
    try{
      const query=nextFilter==='all'?'':`?statement_category=${encodeURIComponent(nextFilter)}`;
      const response=await request(`/api/account-classifications${query}`,{},onUnauthorized);
      const payload=await response.json() as {accounts?:AccountResponse[]};
      const rows=Array.isArray(payload.accounts)?payload.accounts:[];
      setAccounts(rows);
      setDrafts(Object.fromEntries(rows.map(account=>[
        account.id,
        {
          statement_category:account.statement_category??'unmapped',
          is_contra:Boolean(account.is_contra),
          cash_role:account.cash_role??'non_cash',
          cash_flow_category:account.cash_flow_category??'unmapped',
        },
      ])));
    }catch{
      setError(true);
    }finally{
      setLoading(false);
    }
  };

  const open=()=>{
    setOpened(true);
    void load('unmapped');
  };

  const changeCategory=(account:AccountResponse,value:StatementCategory)=>{
    setDrafts(current=>({
      ...current,
      [account.id]:{
        statement_category:value,
        is_contra:current[account.id]?.is_contra??Boolean(account.is_contra),
        cash_role:current[account.id]?.cash_role??account.cash_role??'non_cash',
        cash_flow_category:current[account.id]?.cash_flow_category??account.cash_flow_category??'unmapped',
      },
    }));
  };

  const changeContra=(account:AccountResponse,value:boolean)=>{
    setDrafts(current=>({
      ...current,
      [account.id]:{
        statement_category:current[account.id]?.statement_category??account.statement_category??'unmapped',
        is_contra:value,
        cash_role:current[account.id]?.cash_role??account.cash_role??'non_cash',
        cash_flow_category:current[account.id]?.cash_flow_category??account.cash_flow_category??'unmapped',
      },
    }));
  };

  const changeCashRole=(account:AccountResponse,value:CashRole)=>{
    setDrafts(current=>({...current,[account.id]:{
      statement_category:current[account.id]?.statement_category??account.statement_category??'unmapped',
      is_contra:current[account.id]?.is_contra??Boolean(account.is_contra),
      cash_role:value,
      cash_flow_category:current[account.id]?.cash_flow_category??account.cash_flow_category??'unmapped',
    }}));
  };

  const changeCashFlowCategory=(account:AccountResponse,value:CashFlowCategory)=>{
    setDrafts(current=>({...current,[account.id]:{
      statement_category:current[account.id]?.statement_category??account.statement_category??'unmapped',
      is_contra:current[account.id]?.is_contra??Boolean(account.is_contra),
      cash_role:current[account.id]?.cash_role??account.cash_role??'non_cash',
      cash_flow_category:value,
    }}));
  };

  const save=async(account:AccountResponse)=>{
    const draft=drafts[account.id];
    if(!draft)return;
    setSaving(account.id);setError(false);
    try{
      const response=await request(
        `/api/accounts/${account.id}/classification`,
        {
          method:'PATCH',
          headers:{'content-type':'application/json'},
          body:JSON.stringify(draft),
        },
        onUnauthorized,
      );
      const updated=await response.json() as AccountResponse;
      setAccounts(current=>current.map(row=>row.id===account.id?updated:row));
      setDrafts(current=>({
        ...current,
        [account.id]:{
          statement_category:updated.statement_category??'unmapped',
          is_contra:Boolean(updated.is_contra),
          cash_role:updated.cash_role??'non_cash',
          cash_flow_category:updated.cash_flow_category??'unmapped',
        },
      }));
      if(filter!=='all'&&updated.statement_category!==filter){
        setAccounts(current=>current.filter(row=>row.id!==account.id));
      }
    }catch{
      setError(true);
    }finally{
      setSaving(null);
    }
  };

  useEffect(()=>{
    if(autoOpen&&canView)void load('all');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  },[autoOpen,canView]);

  if(!canView)return null;
  if(!opened){
    return <section className="panel">
      <button type="button" onClick={open}>Financial statement mapping / تصنيف القوائم المالية</button>
    </section>;
  }

  return <section className="panel ac-mapping" aria-label="Financial statement mapping">
    <div className="ac-mapping__header">
      <h2>تصنيف القوائم المالية <small lang="en" dir="ltr">Financial statement mapping</small></h2>
      <label className="ac-mapping__filter">
        <span className="ac-mapping__prefix">التصنيف</span>
        <select
          aria-label="Classification filter"
          value={filter}
          onChange={event=>{
            const value=event.target.value as StatementCategory|'all';
            setFilter(value);
            void load(value);
          }}
        >
          <option value="all">All / الكل</option>
          {ALL_CATEGORIES.map(category=><option key={category} value={category}>{CATEGORY_LABELS[category]}</option>)}
        </select>
      </label>
    </div>
    <p className="ac-mapping__note"><span aria-hidden="true">ⓘ</span> التصنيف للعرض والتقارير فقط ولا يغيّر نوع الحساب أو القيود المرحّلة. <span className="ac-mapping__sr">Presentation/reporting mapping only. Account type and posted ledger entries are unchanged.</span></p>
    {loading&&<p role="status">Loading / جاري التحميل</p>}
    {error&&<p role="alert">Unable to load or update classification. / تعذر تحميل أو تحديث التصنيف.</p>}
    {!loading&&!error&&accounts.length===0&&<p role="status">No accounts in this classification. / لا توجد حسابات ضمن هذا التصنيف.</p>}
    {!loading&&accounts.length>0&&<div className="table-wrap ac-mapping__table">
      <table>
        <thead><tr>
          <th>الرمز</th>
          <th>اسم الحساب</th>
          <th>نوع الحساب<small lang="en">Account type</small></th>
          <th>فئة القائمة المالية<small lang="en">Statement category</small></th>
          <th>دور النقد<small lang="en">Cash role</small></th>
          <th>نشاط التدفقات النقدية<small lang="en">Cash-flow activity</small></th>
          <th>حساب مقابل<small lang="en">Contra</small></th>
          {canManage&&<th>الإجراء</th>}
        </tr></thead>
        <tbody>
          {accounts.map(account=>{
            const draft=drafts[account.id]??{
              statement_category:account.statement_category??'unmapped',
              is_contra:Boolean(account.is_contra),
              cash_role:account.cash_role??'non_cash',
              cash_flow_category:account.cash_flow_category??'unmapped',
            };
            return <tr key={account.id}>
              <td className="ac-mapping__code">{account.code}</td>
              <td className="ac-mapping__name">{account.name}</td>
              <td>{TYPE_LABELS[account.account_type]}</td>
              <td>
                {canManage?
                  <select
                    aria-label={`Statement category ${account.code}`}
                    value={draft.statement_category}
                    onChange={event=>changeCategory(account,event.target.value as StatementCategory)}
                  >
                    {COMPATIBLE[account.account_type].map(category=>
                      <option key={category} value={category} title={CATEGORY_LABELS[category]}>{shortLabel(CATEGORY_LABELS[category])}</option>
                    )}
                  </select>:
                  CATEGORY_LABELS[draft.statement_category]}
              </td>
              <td>
                {canManage?<select aria-label={`Cash role ${account.code}`} value={draft.cash_role}
                  onChange={event=>changeCashRole(account,event.target.value as CashRole)}>
                  {(account.account_type==='asset'?Object.keys(CASH_ROLE_LABELS):['non_cash']).map(role=>
                    <option key={role} value={role} title={CASH_ROLE_LABELS[role as CashRole]}>{shortLabel(CASH_ROLE_LABELS[role as CashRole])}</option>)}
                </select>:CASH_ROLE_LABELS[draft.cash_role]}
              </td>
              <td>
                {canManage?<select aria-label={`Cash-flow activity ${account.code}`} value={draft.cash_flow_category}
                  onChange={event=>changeCashFlowCategory(account,event.target.value as CashFlowCategory)}>
                  {CASH_FLOW_CATEGORIES.map(category=><option key={category} value={category} title={CASH_FLOW_LABELS[category]}>{shortLabel(CASH_FLOW_LABELS[category])}</option>)}
                </select>:CASH_FLOW_LABELS[draft.cash_flow_category]}
              </td>
              <td>
                {canManage?
                  <input
                    type="checkbox"
                    aria-label={`Contra account ${account.code}`}
                    checked={draft.is_contra}
                    disabled={account.account_type!=='asset'}
                    onChange={event=>changeContra(account,event.target.checked)}
                  />:
                  draft.is_contra?'Yes / نعم':'No / لا'}
              </td>
              {canManage&&<td>
                <button type="button" className="ac-mapping__save" aria-label={`Save / حفظ ${account.code}`} disabled={saving===account.id} onClick={()=>void save(account)}>
                  حفظ
                </button>
              </td>}
            </tr>;
          })}
        </tbody>
      </table>
    </div>}
    {!loading&&accounts.length>0&&<div className="ac-mapping__footer">
      <span>عرض 1–{accounts.length} من {accounts.length} حسابات</span>
      <span>نوع الحساب للقراءة فقط • حفظ التصنيف لكل صف</span>
    </div>}
  </section>;
}
