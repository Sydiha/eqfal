import { useEffect, useState } from 'react';
import { Stack, Tabs } from '@mantine/core';
import { useTranslation } from 'react-i18next';
import { Banking } from './Banking';
import { BankTransactionsView } from './BankTransactionsView';
import { SettlementPanel } from './SettlementPanel';
import { CustodyPanel } from './CustodyPanel';
import './banking-workspace.css';
import './BankingApproved.css';
import { readQueryParameter, writeQueryParameters } from '../navigation/queryState';

type Props = {
  canView: boolean;
  canImport: boolean;
  canManage: boolean;
  canMatch: boolean;
  canReconcile: boolean;
  canSettle: boolean;
  canViewCustody: boolean;
  canManageCustody: boolean;
  canCloseCustody: boolean;
  onUnauthorized: () => void;
};

type BankingSection = 'transactions' | 'import' | 'accounts' | 'settlements' | 'custody';
type CoreSection = 'import' | 'accounts';
const bankingSections = ['transactions', 'import', 'accounts', 'settlements', 'custody'] as const;
const readSection = (): BankingSection => (readQueryParameter('section', { allowedValues: bankingSections }) as BankingSection | null) ?? 'transactions';

const copy = {
  ar: {
    transactions: 'الحركات البنكية',
    import: 'الاستيراد',
    accounts: 'الحسابات',
    settlements: 'التسويات',
    custody: 'العهد والسلف',
    titles: {
      transactions: 'مطابقة الحركات البنكية',
      import: 'استيراد الكشوف البنكية',
      accounts: 'الحسابات البنكية',
      settlements: 'التسويات',
      custody: 'العهد والسلف',
    } as Record<BankingSection, string>,
    descriptions: {
      transactions: 'مراجعة ومطابقة حركات كشف الحساب البنكي مع قيود إقفال للتأكد من اكتمال التسويات البنكية',
      import: 'استيراد كشوف الحسابات البنكية ومراجعة الدفعات المستوردة',
      accounts: 'إدارة الحسابات البنكية المستخدمة في الاستيراد والمطابقة والتسويات',
      settlements: 'تسوية المستندات والالتزامات بالمدفوعات البنكية',
      custody: 'متابعة العهد والسلف وإغلاقها',
    } as Record<BankingSection, string>,
    tabsLabel: 'أقسام البنوك',
    locale: 'ar-SA-u-ca-gregory',
  },
  en: {
    transactions: 'Transactions',
    import: 'Import',
    accounts: 'Accounts',
    settlements: 'Settlements',
    custody: 'Custody & advances',
    titles: {
      transactions: 'Bank transaction reconciliation',
      import: 'Bank statement import',
      accounts: 'Bank accounts',
      settlements: 'Settlements',
      custody: 'Custody & advances',
    } as Record<BankingSection, string>,
    descriptions: {
      transactions: 'Review and match bank statement transactions against ledger entries to confirm bank settlements are complete',
      import: 'Import bank statements and review imported batches',
      accounts: 'Manage the bank accounts used for import, matching, and settlements',
      settlements: 'Settle documents and obligations against bank payments',
      custody: 'Track and close custody and advances',
    } as Record<BankingSection, string>,
    tabsLabel: 'Banking sections',
    locale: 'en-US',
  },
};

export function BankingWorkspace(props: Props) {
  const { i18n } = useTranslation();
  const s = i18n.language === 'ar' ? copy.ar : copy.en;
  const [section, setSection] = useState<BankingSection>(readSection);
  const coreSection: CoreSection | null = section === 'import' || section === 'accounts' ? section : null;
  useEffect(() => {
    const restore = () => setSection(readSection());
    window.addEventListener('popstate', restore);
    return () => window.removeEventListener('popstate', restore);
  }, []);
  const changeSection = (value: string | null) => {
    if (!value || !bankingSections.includes(value as BankingSection)) return;
    setSection(value as BankingSection);
    writeQueryParameters({ section: value });
  };

  const today = new Date().toLocaleDateString(s.locale, { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });

  return <Stack gap="md" className="banking-workspace banking-approved">
    <Tabs value={section} onChange={changeSection} variant="unstyled" className="banking-workspace__tabs banking-approved__tabs">
      <span className="banking-approved__arrow" aria-hidden="true"><svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="m9 6 6 6-6 6"/></svg></span>
      <Tabs.List aria-label={s.tabsLabel}>
        <Tabs.Tab value="transactions"><i aria-hidden="true"/>{s.transactions}</Tabs.Tab>
        {props.canImport && <Tabs.Tab value="import"><i aria-hidden="true"/>{s.import}</Tabs.Tab>}
        <Tabs.Tab value="accounts"><i aria-hidden="true"/>{s.accounts}</Tabs.Tab>
        {props.canSettle && <Tabs.Tab value="settlements"><i aria-hidden="true"/>{s.settlements}</Tabs.Tab>}
        {props.canViewCustody && <Tabs.Tab value="custody"><i aria-hidden="true"/>{s.custody}</Tabs.Tab>}
      </Tabs.List>
      <span className="banking-approved__arrow" aria-hidden="true"><svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="m15 6-6 6 6 6"/></svg></span>
    </Tabs>

    <header className="banking-approved__header">
      <h1>{s.titles[section]}</h1>
      <div><p>{s.descriptions[section]}</p><time>{today}</time></div>
    </header>

    {section === 'transactions' && <BankTransactionsView canView={props.canView} canMatch={props.canMatch} canReconcile={props.canReconcile} onUnauthorized={props.onUnauthorized}/>} 

    {coreSection && <div className={`banking-core banking-core--${coreSection}`}>
      <Banking
        canView={props.canView}
        canImport={props.canImport}
        canManage={props.canManage}
        canMatch={props.canMatch}
        canReconcile={props.canReconcile}
        onUnauthorized={props.onUnauthorized}
      />
    </div>}

    {section === 'settlements' && <div className="banking-feature-pane"><SettlementPanel canView={props.canView} canSettle={props.canSettle} onUnauthorized={props.onUnauthorized}/></div>}
    {section === 'custody' && <div className="banking-feature-pane"><CustodyPanel canView={props.canViewCustody} canManage={props.canManageCustody} canClose={props.canCloseCustody} onUnauthorized={props.onUnauthorized}/></div>}
  </Stack>;
}
