import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import i18n from '../i18n';
import ar from '../i18n/locales/ar';
import en from '../i18n/locales/en';
import { AccountClassificationPanel } from '../components/AccountClassificationPanel';

const CATEGORIES=['unmapped','current_asset','non_current_asset','current_liability','non_current_liability','equity','revenue','cost_of_sales','operating_expense','finance_income','finance_expense','other_income','other_expense'];
const CASH_ROLES=['non_cash','cash','cash_equivalent'];
const CASH_FLOWS=['unmapped','operating','investing','financing'];
const TYPES=['asset','liability','equity','revenue','expense'];
const ARABIC=/[؀-ۿ]/;
const LATIN=/[A-Za-z]/;

const account={id:'11111111-1111-4111-8111-111111111111',code:'1000',name:'Cash',account_type:'asset' as const,parent_account_id:null,is_active:true,statement_category:'current_asset' as const,is_contra:false,cash_role:'cash' as const,cash_flow_category:'operating' as const};

const mapping=(lang:'ar'|'en')=>(lang==='ar'?ar:en) as unknown as {accountMapping:Record<string,Record<string,string>|string>};

describe('Financial statement mapping localization',()=>{
  it.each(['ar','en'] as const)('%s defines a label for every enum value',lang=>{
    const m=mapping(lang).accountMapping as Record<string,Record<string,string>>;
    expect(Object.keys(m.category!).sort()).toEqual([...CATEGORIES].sort());
    expect(Object.keys(m.cashRole!).sort()).toEqual([...CASH_ROLES].sort());
    expect(Object.keys(m.cashFlow!).sort()).toEqual([...CASH_FLOWS].sort());
    expect(Object.keys(m.types!).sort()).toEqual([...TYPES].sort());
  });

  it('Arabic option labels are Arabic only and English labels are English only',()=>{
    for(const group of ['category','cashRole','cashFlow','types']){
      for(const [k,v] of Object.entries(mapping('ar').accountMapping[group] as Record<string,string>)){
        expect(v,`ar ${group}.${k}`).toMatch(ARABIC);expect(v,`ar ${group}.${k}`).not.toMatch(LATIN);
      }
      for(const [k,v] of Object.entries(mapping('en').accountMapping[group] as Record<string,string>)){
        expect(v,`en ${group}.${k}`).toMatch(LATIN);expect(v,`en ${group}.${k}`).not.toMatch(ARABIC);
      }
    }
  });

  describe('rendered panel',()=>{
    beforeEach(()=>{
      vi.stubGlobal('fetch',vi.fn(async()=>new Response(JSON.stringify({accounts:[account]}))));
    });
    afterEach(async()=>{await i18n.changeLanguage('ar');});

    it('shows Arabic only in Arabic, English only in English, and keeps option values and selections when switching without remount',async()=>{
      await i18n.changeLanguage('ar');
      const {container}=render(<AccountClassificationPanel canView canManage autoOpen onUnauthorized={vi.fn()}/>);
      await screen.findByRole('cell',{name:'Cash'});
      const panel=container.querySelector('.ac-mapping') as HTMLElement;

      const texts=()=>[...panel.querySelectorAll('option,th,h2,p,button,.ac-mapping__prefix,.ac-mapping__footer span')].map(e=>e.textContent??'').join('|');
      expect(texts()).not.toMatch(LATIN);
      expect(within(panel).getByLabelText('نشاط التدفقات النقدية 1000')).toBeInTheDocument();

      const cashRole=within(panel).getByLabelText('دور النقد 1000') as HTMLSelectElement;
      fireEvent.change(cashRole,{target:{value:'cash_equivalent'}});
      const values=()=>[...panel.querySelectorAll('select')].map(s=>[...s.options].map(o=>o.value).join(','));
      const valuesAr=values();

      await act(async()=>{await i18n.changeLanguage('en');});
      expect(container.querySelector('.ac-mapping')).toBe(panel);
      expect(texts()).not.toMatch(ARABIC);
      const cashRoleEn=within(panel).getByLabelText('Cash role 1000') as HTMLSelectElement;
      expect(cashRoleEn).toBe(cashRole);
      expect(cashRoleEn.value).toBe('cash_equivalent');
      expect(cashRoleEn.selectedOptions[0]!.textContent).toBe('Cash equivalent');
      expect(values()).toEqual(valuesAr);
      expect(within(panel).getByLabelText('Statement category 1000')).toHaveValue('current_asset');

      await act(async()=>{await i18n.changeLanguage('ar');});
      expect(within(panel).getByLabelText('دور النقد 1000')).toHaveValue('cash_equivalent');
      expect(cashRole.selectedOptions[0]!.textContent).toBe('ما يعادل النقد');
    });

    it('localizes read-only values and the contra flag',async()=>{
      await i18n.changeLanguage('ar');
      render(<AccountClassificationPanel canView canManage={false} autoOpen onUnauthorized={vi.fn()}/>);
      await screen.findByRole('cell',{name:'Cash'});
      const row=screen.getByRole('row',{name:/1000/});
      expect(within(row).getByText('أصل متداول')).toBeInTheDocument();
      expect(within(screen.getByRole('row',{name:/1000/})).getByText('نقد')).toBeInTheDocument();
      expect(within(screen.getByRole('row',{name:/1000/})).getByText('تشغيلي')).toBeInTheDocument();
      expect(within(screen.getByRole('row',{name:/1000/})).getByText('لا')).toBeInTheDocument();
      await act(async()=>{await i18n.changeLanguage('en');});
      expect(within(screen.getByRole('row',{name:/1000/})).getByText('Current asset')).toBeInTheDocument();
      expect(within(screen.getByRole('row',{name:/1000/})).getByText('Operating')).toBeInTheDocument();
      expect(within(screen.getByRole('row',{name:/1000/})).getByText('No')).toBeInTheDocument();
    });
  });
});
