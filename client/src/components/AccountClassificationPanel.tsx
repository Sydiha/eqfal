import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { AccountResponse, CashFlowCategory, CashRole, StatementCategory } from './accounting-contracts';

interface Props{
  canView:boolean;
  canManage:boolean;
  onUnauthorized:()=>void;
  autoOpen?:boolean;
}

const ALL_CATEGORIES:readonly StatementCategory[]=['unmapped','current_asset','non_current_asset','current_liability','non_current_liability','equity','revenue','cost_of_sales','operating_expense','finance_income','finance_expense','other_income','other_expense'];
const COMPATIBLE:Record<AccountResponse['account_type'],readonly StatementCategory[]>={
  asset:['unmapped','current_asset','non_current_asset'],
  liability:['unmapped','current_liability','non_current_liability'],
  equity:['unmapped','equity'],
  revenue:['unmapped','revenue','finance_income','other_income'],
  expense:['unmapped','cost_of_sales','operating_expense','finance_expense','other_expense'],
};
const CASH_ROLES:readonly CashRole[]=['non_cash','cash','cash_equivalent'];
const CASH_FLOW_CATEGORIES:readonly CashFlowCategory[]=['unmapped','operating','investing','financing'];
type Draft={statement_category:StatementCategory;is_contra:boolean;cash_role:CashRole;cash_flow_category:CashFlowCategory};

async function request(url:string,options:RequestInit,onUnauthorized:()=>void){
  const response=await fetch(url,{credentials:'same-origin',...options});
  if(response.status===401)onUnauthorized();
  if(!response.ok)throw new Error(String(response.status));
  return response;
}

export function AccountClassificationPanel({canView,canManage,onUnauthorized,autoOpen=false}:Props){
  const {t}=useTranslation();
  const label=(group:string,key:string)=>t(`accountMapping.${group}.${key}`);
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
      <button type="button" onClick={open}>{t('accountMapping.open')}</button>
    </section>;
  }

  return <section className="panel ac-mapping" aria-label={t('accountMapping.title')}>
    <div className="ac-mapping__header">
      <h2>{t('accountMapping.title')}</h2>
      <label className="ac-mapping__filter">
        <span className="ac-mapping__prefix">{t('accountMapping.filterPrefix')}</span>
        <select
          aria-label={t('accountMapping.filterLabel')}
          value={filter}
          onChange={event=>{
            const value=event.target.value as StatementCategory|'all';
            setFilter(value);
            void load(value);
          }}
        >
          <option value="all">{t('accountMapping.all')}</option>
          {ALL_CATEGORIES.map(category=><option key={category} value={category}>{label('category',category)}</option>)}
        </select>
      </label>
    </div>
    <p className="ac-mapping__note"><span aria-hidden="true">ⓘ</span> {t('accountMapping.note')}</p>
    {loading&&<p role="status">{t('accountMapping.loading')}</p>}
    {error&&<p role="alert">{t('accountMapping.error')}</p>}
    {!loading&&!error&&accounts.length===0&&<p role="status">{t('accountMapping.empty')}</p>}
    {!loading&&accounts.length>0&&<div className="table-wrap ac-mapping__table">
      <table>
        <thead><tr>
          <th>{t('accountMapping.cols.code')}</th>
          <th>{t('accountMapping.cols.name')}</th>
          <th>{t('accountMapping.cols.type')}</th>
          <th>{t('accountMapping.cols.category')}</th>
          <th>{t('accountMapping.cols.cashRole')}</th>
          <th>{t('accountMapping.cols.cashFlow')}</th>
          <th>{t('accountMapping.cols.contra')}</th>
          {canManage&&<th>{t('accountMapping.cols.action')}</th>}
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
              <td>{label('types',account.account_type)}</td>
              <td>
                {canManage?
                  <select
                    aria-label={t('accountMapping.aria.category',{code:account.code})}
                    value={draft.statement_category}
                    onChange={event=>changeCategory(account,event.target.value as StatementCategory)}
                  >
                    {COMPATIBLE[account.account_type].map(category=>
                      <option key={category} value={category}>{label('category',category)}</option>
                    )}
                  </select>:
                  label('category',draft.statement_category)}
              </td>
              <td>
                {canManage?<select aria-label={t('accountMapping.aria.cashRole',{code:account.code})} value={draft.cash_role}
                  onChange={event=>changeCashRole(account,event.target.value as CashRole)}>
                  {(account.account_type==='asset'?CASH_ROLES:['non_cash'] as readonly CashRole[]).map(role=>
                    <option key={role} value={role}>{label('cashRole',role)}</option>)}
                </select>:label('cashRole',draft.cash_role)}
              </td>
              <td>
                {canManage?<select aria-label={t('accountMapping.aria.cashFlow',{code:account.code})} value={draft.cash_flow_category}
                  onChange={event=>changeCashFlowCategory(account,event.target.value as CashFlowCategory)}>
                  {CASH_FLOW_CATEGORIES.map(category=><option key={category} value={category}>{label('cashFlow',category)}</option>)}
                </select>:label('cashFlow',draft.cash_flow_category)}
              </td>
              <td>
                {canManage?
                  <input
                    type="checkbox"
                    aria-label={t('accountMapping.aria.contra',{code:account.code})}
                    checked={draft.is_contra}
                    disabled={account.account_type!=='asset'}
                    onChange={event=>changeContra(account,event.target.checked)}
                  />:
                  draft.is_contra?t('accountMapping.yes'):t('accountMapping.no')}
              </td>
              {canManage&&<td>
                <button type="button" className="ac-mapping__save" aria-label={t('accountMapping.aria.save',{code:account.code})} disabled={saving===account.id} onClick={()=>void save(account)}>
                  {t('accountMapping.save')}
                </button>
              </td>}
            </tr>;
          })}
        </tbody>
      </table>
    </div>}
    {!loading&&accounts.length>0&&<div className="ac-mapping__footer">
      <span>{t('accountMapping.footerCount',{count:accounts.length})}</span>
      <span>{t('accountMapping.footerNote')}</span>
    </div>}
  </section>;
}
