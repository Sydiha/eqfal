import { useState } from 'react';
import { Badge, Group, Stack, Tabs, Text, Title } from '@mantine/core';
import { useTranslation } from 'react-i18next';
import { Banking } from './Banking';
import { BankTransactionsView } from './BankTransactionsView';
import { SettlementPanel } from './SettlementPanel';
import { CustodyPanel } from './CustodyPanel';
import './banking-workspace.css';

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

const copy = {
  ar: {
    eyebrow: 'BANKING WORKSPACE',
    title: 'مساحة عمل البنوك',
    description: 'الحركات البنكية والمطابقة والاستيراد والتسويات والعهد في مساحة تشغيل واحدة منظمة.',
    transactions: 'الحركات البنكية',
    import: 'الاستيراد',
    accounts: 'الحسابات',
    settlements: 'التسويات',
    custody: 'العهد والسلف',
    primary: 'العمل اليومي',
    secondary: 'الإدارة والمتابعة',
  },
  en: {
    eyebrow: 'BANKING WORKSPACE',
    title: 'Banking workspace',
    description: 'Bank transactions, matching, imports, settlements, and custody in one focused operating workspace.',
    transactions: 'Transactions',
    import: 'Import',
    accounts: 'Accounts',
    settlements: 'Settlements',
    custody: 'Custody & advances',
    primary: 'Daily work',
    secondary: 'Administration',
  },
};

export function BankingWorkspace(props: Props) {
  const { i18n } = useTranslation();
  const s = i18n.language === 'ar' ? copy.ar : copy.en;
  const [section, setSection] = useState<BankingSection>('transactions');
  const coreSection: CoreSection | null = section === 'import' || section === 'accounts' ? section : null;

  return <Stack gap="lg" className="banking-workspace">
    <section className="banking-workspace__hero">
      <div>
        <Text className="banking-workspace__eyebrow">{s.eyebrow}</Text>
        <Title order={1}>{s.title}</Title>
        <Text c="dimmed" maw={760}>{s.description}</Text>
      </div>
      <Group gap="xs" className="banking-workspace__hero-badges">
        <Badge variant="light" size="lg">{s.primary}</Badge>
        <Badge variant="outline" size="lg">{s.secondary}</Badge>
      </Group>
    </section>

    <Tabs value={section} onChange={(value) => value && setSection(value as BankingSection)} variant="pills" className="banking-workspace__tabs">
      <Tabs.List grow>
        <Tabs.Tab value="transactions">{s.transactions}</Tabs.Tab>
        {props.canImport && <Tabs.Tab value="import">{s.import}</Tabs.Tab>}
        <Tabs.Tab value="accounts">{s.accounts}</Tabs.Tab>
        {props.canSettle && <Tabs.Tab value="settlements">{s.settlements}</Tabs.Tab>}
        {props.canViewCustody && <Tabs.Tab value="custody">{s.custody}</Tabs.Tab>}
      </Tabs.List>
    </Tabs>

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
