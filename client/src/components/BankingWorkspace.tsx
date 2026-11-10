import { useEffect, useMemo, useState } from 'react';
import { Stack, Tabs } from '@mantine/core';
import { useTranslation } from 'react-i18next';
import { Banking } from './Banking';
import { BankTransactionsView } from './BankTransactionsView';
import { SettlementPanel } from './SettlementPanel';
import { CustodyPanel } from './CustodyPanel';
import { BankStatementReconciliation } from './BankStatementReconciliation';
import './banking-workspace.css';
import './BankingApproved.css';
import { readQueryParameter, writeQueryParameters } from '../navigation/queryState';
import { canOpenDestination, destinationsFor, type DeepDestination } from '../navigation/pageDestinations';

type Props = {
  capabilities?: readonly string[];
  canView: boolean;
  canImport: boolean;
  canDeleteImport?: boolean;
  canManage: boolean;
  canMatch: boolean;
  canReconcile: boolean;
  canCreateManual?: boolean;
  canSettle: boolean;
  canViewCustody: boolean;
  canManageCustody: boolean;
  canCloseCustody: boolean;
  canManageStatements?: boolean;
  canConfirmStatements?: boolean;
  canManageReconciliationSettings?: boolean;
  onUnauthorized: () => void;
};

type BankingSection = 'transactions' | 'import' | 'accounts' | 'settlements' | 'custody' | 'reconciliation';
type CoreSection = 'import' | 'accounts';
const bankingSections = ['transactions', 'import', 'accounts', 'settlements', 'custody', 'reconciliation'] as const;
const bankingDestinations = destinationsFor('banks');
const legacyCapabilities = (props: Props): readonly string[] => props.capabilities ?? ['bank.view', ...(props.canImport ? ['bank.import'] : []), ...(props.canSettle ? ['payment.settle'] : []), ...(props.canViewCustody ? ['custody.view'] : [])];
const readSection = (capabilities: readonly string[]): BankingSection => {
  const available = bankingDestinations.filter(destination => canOpenDestination(destination, capabilities));
  const requested = readQueryParameter('section', { allowedValues: bankingSections }) as BankingSection | null;
  return requested && available.some(destination => destination.query?.section === requested)
    ? requested
    : (available[0]?.query?.section as BankingSection | undefined) ?? 'transactions';
};

const copy = {
  ar: {
    transactions: 'الحركات البنكية',
    import: 'الاستيراد',
    accounts: 'الحسابات',
    settlements: 'التسويات',
    custody: 'العهد والسلف',
    reconciliation: 'مطابقة الرصيد',
    titles: {
      transactions: 'مطابقة الحركات البنكية',
      import: 'استيراد الكشوف البنكية',
      accounts: 'الحسابات البنكية',
      settlements: 'التسويات',
      custody: 'العهد والسلف',
      reconciliation: 'مطابقة رصيد الكشف مع رصيد الدفتر',
    } as Record<BankingSection, string>,
    descriptions: {
      transactions: 'مراجعة ومطابقة حركات كشف الحساب البنكي مع قيود إقفال للتأكد من اكتمال التسويات البنكية',
      import: 'استيراد كشوف الحسابات البنكية ومراجعة الدفعات المستوردة',
      accounts: 'إدارة الحسابات البنكية المستخدمة في الاستيراد والمطابقة والتسويات',
      settlements: 'تسوية المستندات والالتزامات بالمدفوعات البنكية',
      custody: 'متابعة العهد والسلف وإغلاقها',
      reconciliation: 'إدخال رصيد الكشف الختامي ومقارنته برصيد حساب الدفتر المربوط مع البنود المعلقة المثبتة',
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
    reconciliation: 'Balance reconciliation',
    titles: {
      transactions: 'Bank transaction reconciliation',
      import: 'Bank statement import',
      accounts: 'Bank accounts',
      settlements: 'Settlements',
      custody: 'Custody & advances',
      reconciliation: 'Statement balance versus ledger balance',
    } as Record<BankingSection, string>,
    descriptions: {
      transactions: 'Review and match bank statement transactions against ledger entries to confirm bank settlements are complete',
      import: 'Import bank statements and review imported batches',
      accounts: 'Manage the bank accounts used for import, matching, and settlements',
      settlements: 'Settle documents and obligations against bank payments',
      custody: 'Track and close custody and advances',
      reconciliation: 'Enter the statement ending balance and compare it with the linked ledger account, with evidenced outstanding items',
    } as Record<BankingSection, string>,
    tabsLabel: 'Banking sections',
    locale: 'en-US',
  },
};

export function BankingWorkspace(props: Props) {
  const { i18n, t } = useTranslation();
  const s = i18n.language === 'ar' ? copy.ar : copy.en;
  const capabilities = useMemo(() => legacyCapabilities(props), [props.capabilities, props.canImport, props.canSettle, props.canViewCustody]);
  const [section, setSection] = useState<BankingSection>(() => readSection(capabilities));
  const coreSection: CoreSection | null = section === 'import' || section === 'accounts' ? section : null;
  useEffect(() => {
    const restore = () => setSection(readSection(capabilities));
    window.addEventListener('popstate', restore);
    return () => window.removeEventListener('popstate', restore);
  }, [capabilities]);
  const changeSection = (value: string | null) => {
    const destination = bankingDestinations.find(item => item.query?.section === value) as DeepDestination | undefined;
    if (!value || !destination || !canOpenDestination(destination, capabilities)) return;
    setSection(value as BankingSection);
    writeQueryParameters({ section: value });
  };

  const today = new Date().toLocaleDateString(s.locale, { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });

  return <Stack gap="md" className="banking-workspace banking-approved">
    <Tabs value={section} onChange={changeSection} variant="unstyled" className="banking-workspace__tabs banking-approved__tabs">
      <span className="banking-approved__arrow" aria-hidden="true"><svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="m9 6 6 6-6 6"/></svg></span>
      <Tabs.List aria-label={s.tabsLabel} onFocus={event => event.target.scrollIntoView?.({ block: 'nearest', inline: 'nearest' })}>
        {bankingDestinations.filter(destination => canOpenDestination(destination, capabilities)).map(destination => <Tabs.Tab key={destination.id} value={destination.query!.section}><i aria-hidden="true"/>{t(destination.labelKey)}</Tabs.Tab>)}
      </Tabs.List>
      <span className="banking-approved__arrow" aria-hidden="true"><svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="m15 6-6 6 6 6"/></svg></span>
    </Tabs>

    <header className="banking-approved__header">
      <h1>{s.titles[section]}</h1>
      <div><p>{s.descriptions[section]}</p><time>{today}</time></div>
    </header>

    {section === 'transactions' && <BankTransactionsView canView={props.canView} canMatch={props.canMatch} canReconcile={props.canReconcile} canCreateManual={props.canCreateManual} onUnauthorized={props.onUnauthorized}/>} 

    {coreSection && <div className={`banking-core banking-core--${coreSection}`}>
      <Banking
        canView={props.canView}
        canImport={props.canImport}
        canDeleteImport={props.canDeleteImport}
        canManage={props.canManage}
        canMatch={props.canMatch}
        canReconcile={props.canReconcile}
        onUnauthorized={props.onUnauthorized}
      />
    </div>}

    {section === 'settlements' && <div className="banking-feature-pane"><SettlementPanel canView={props.canView} canSettle={props.canSettle} onUnauthorized={props.onUnauthorized}/></div>}
    {section === 'reconciliation' && <div className="banking-feature-pane"><BankStatementReconciliation canView={props.canView} canManageStatements={props.canManageStatements === true} canConfirmStatements={props.canConfirmStatements === true} canManageSettings={props.canManageReconciliationSettings === true} canManageLinks={props.canManage} onUnauthorized={props.onUnauthorized}/></div>}
    {section === 'custody' && <div className="banking-feature-pane"><CustodyPanel canView={props.canViewCustody} canManage={props.canManageCustody} canClose={props.canCloseCustody} onUnauthorized={props.onUnauthorized}/></div>}
  </Stack>;
}
