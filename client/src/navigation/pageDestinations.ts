import type { NavigationPage } from '../components/navigationVisibility';
import { canShowNavigationPage } from '../components/navigationVisibility';

export type DeepDestination = {
  id: string;
  page: NavigationPage;
  labelKey: string;
  breadcrumbKeys?: readonly string[];
  query?: Readonly<Record<string, string>>;
  requiredCapabilities?: readonly string[];
  requiresSystemAdmin?: boolean;
};

/** Static destinations are shared by the search index and the page controls that expose them. */
export const PAGE_DESTINATIONS = [
  { id: 'accounting.accounts', page: 'accounting', labelKey: 'accounting.tabs.accounts', query: { accountingTab: 'accounts' } },
  { id: 'accounting.journals', page: 'accounting', labelKey: 'accounting.tabs.journals', query: { accountingTab: 'journals' } },
  { id: 'accounting.sources', page: 'accounting', labelKey: 'accounting.tabs.sources', query: { accountingTab: 'sources' } },
  { id: 'accounting.trial', page: 'accounting', labelKey: 'accounting.tabs.trial', query: { accountingTab: 'trial' } },
  { id: 'accounting.ledger', page: 'accounting', labelKey: 'accounting.tabs.ledger', query: { accountingTab: 'ledger' } },
  { id: 'accounting.financialPosition', page: 'accounting', labelKey: 'accounting.tabs.financialPosition', query: { accountingTab: 'financialPosition' } },
  { id: 'accounting.profitOrLoss', page: 'accounting', labelKey: 'accounting.tabs.profitOrLoss', query: { accountingTab: 'profitOrLoss' } },
  { id: 'accounting.changesInEquity', page: 'accounting', labelKey: 'accounting.tabs.changesInEquity', query: { accountingTab: 'changesInEquity' } },
  { id: 'accounting.cashFlow', page: 'accounting', labelKey: 'accounting.tabs.cashFlow', query: { accountingTab: 'cashFlow' } },

  { id: 'banks.transactions', page: 'banks', labelKey: 'globalNav.banking.transactions', query: { section: 'transactions' } },
  { id: 'banks.import', page: 'banks', labelKey: 'globalNav.banking.import', query: { section: 'import' }, requiredCapabilities: ['bank.import'] },
  { id: 'banks.accounts', page: 'banks', labelKey: 'globalNav.banking.accounts', query: { section: 'accounts' } },
  { id: 'banks.settlements', page: 'banks', labelKey: 'globalNav.banking.settlements', query: { section: 'settlements' }, requiredCapabilities: ['payment.settle'] },
  { id: 'banks.reconciliation', page: 'banks', labelKey: 'globalNav.banking.reconciliation', query: { section: 'reconciliation' } },
  { id: 'banks.custody', page: 'banks', labelKey: 'globalNav.banking.custody', query: { section: 'custody' }, requiredCapabilities: ['custody.view'] },

  { id: 'assets.policy', page: 'assets', labelKey: 'assets.policyGovernance', query: { assetView: 'policy' } },
  { id: 'assets.categories', page: 'assets', labelKey: 'assets.categoryAccounting', query: { assetView: 'categories' }, requiredCapabilities: ['asset.policy.manage'] },

  { id: 'documents.all', page: 'documents', labelKey: 'documents.v3.allDocuments', query: { docBucket: 'all' } },
  { id: 'documents.uploaded', page: 'documents', labelKey: 'documents.statuses.uploaded', query: { docBucket: 'uploaded' } },
  { id: 'documents.needsReview', page: 'documents', labelKey: 'documents.statuses.needs_review', query: { docBucket: 'needs_review' } },
  { id: 'documents.approved', page: 'documents', labelKey: 'documents.statuses.approved', query: { docBucket: 'approved' } },
  { id: 'documents.issues', page: 'documents', labelKey: 'documents.v3.bucketIssues', query: { docBucket: 'issues' } },

  { id: 'annualClosing.readiness', page: 'annualClosing', labelKey: 'annualClosing.tabs.readiness', query: { annualCloseTab: 'readiness' } },
  { id: 'annualClosing.package', page: 'annualClosing', labelKey: 'annualClosing.tabs.package', query: { annualCloseTab: 'package' }, requiredCapabilities: ['annual_close.package.view'] },
  { id: 'annualClosing.wht', page: 'annualClosing', labelKey: 'annualClosing.tabs.wht', query: { annualCloseTab: 'wht' }, requiredCapabilities: ['wht_review.view'] },

  { id: 'obligations.register', page: 'obligations', labelKey: 'globalNav.obligations.register', query: { obligationsView: 'register' } },
  { id: 'obligations.aging', page: 'obligations', labelKey: 'globalNav.obligations.aging', query: { obligationsView: 'aging', agingSide: 'receivables' } },
  { id: 'obligations.aging.receivables', page: 'obligations', labelKey: 'globalNav.obligations.receivables', breadcrumbKeys: ['globalNav.obligations.aging'], query: { obligationsView: 'aging', agingSide: 'receivables' } },
  { id: 'obligations.aging.payables', page: 'obligations', labelKey: 'globalNav.obligations.payables', breadcrumbKeys: ['globalNav.obligations.aging'], query: { obligationsView: 'aging', agingSide: 'payables' } },
  { id: 'obligations.personalPayments', page: 'obligations', labelKey: 'globalNav.obligations.personalPayments', query: { obligationsView: 'personal', personalPaymentsTab: 'payments' }, requiredCapabilities: ['personal_payment.view'] },
  { id: 'obligations.personalPayments.payables', page: 'obligations', labelKey: 'globalNav.personalPayments.payables', breadcrumbKeys: ['globalNav.obligations.personalPayments'], query: { obligationsView: 'personal', personalPaymentsTab: 'payables' }, requiredCapabilities: ['personal_payment.view'] },
  { id: 'obligations.personalPayments.payers', page: 'obligations', labelKey: 'globalNav.personalPayments.payers', breadcrumbKeys: ['globalNav.obligations.personalPayments'], query: { obligationsView: 'personal', personalPaymentsTab: 'payers' }, requiredCapabilities: ['personal_payment.view'] },

  { id: 'openingBalances.items', page: 'openingBalances', labelKey: 'globalNav.openingBalances.items', query: { openingBalanceTab: 'items' } },
  { id: 'openingBalances.reconciliation', page: 'openingBalances', labelKey: 'globalNav.openingBalances.reconciliation', query: { openingBalanceTab: 'recon' } },
  { id: 'openingBalances.review', page: 'openingBalances', labelKey: 'globalNav.openingBalances.review', query: { openingBalanceTab: 'review' } },

  { id: 'access.members', page: 'access', labelKey: 'access.membersTab', query: { accessTab: 'members' }, requiredCapabilities: ['access.view'] },
  { id: 'access.roles', page: 'access', labelKey: 'access.rolesTab', query: { accessTab: 'roles' }, requiredCapabilities: ['access.view'] },
  { id: 'access.global.users', page: 'access', labelKey: 'systemAdmin.usersTab', breadcrumbKeys: ['systemAdmin.tab'], query: { accessTab: 'global', systemAdminView: 'users' }, requiresSystemAdmin: true },
  { id: 'access.global.companies', page: 'access', labelKey: 'systemAdmin.companiesTab', breadcrumbKeys: ['systemAdmin.tab'], query: { accessTab: 'global', systemAdminView: 'companies' }, requiresSystemAdmin: true },
] as const satisfies readonly DeepDestination[];

export function destinationsFor(page: NavigationPage): readonly DeepDestination[] {
  return PAGE_DESTINATIONS.filter(destination => destination.page === page);
}

export function canOpenDestination(destination: DeepDestination, capabilities: readonly string[], isSystemAdmin = false): boolean {
  return canShowNavigationPage(destination.page, capabilities) &&
    (destination.requiredCapabilities ?? []).every(capability => capabilities.includes(capability)) &&
    (!destination.requiresSystemAdmin || isSystemAdmin);
}

export function destinationQuery(destination: DeepDestination): Record<string, string> {
  return { ...(destination.query ?? {}) };
}
