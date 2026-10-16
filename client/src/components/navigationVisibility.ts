export type NavigationPage =
  | 'home'
  | 'fiscalYears'
  | 'monthlyClose'
  | 'annualClosing'
  | 'vat'
  | 'documents'
  | 'banks'
  | 'partners'
  | 'obligations'
  | 'accounting'
  | 'openingBalances'
  | 'periodicAdjustments'
  | 'sales'
  | 'purchases'
  | 'assets'
  | 'companyProfile'
  | 'access'
  | 'companies'
  | 'sourceAuthority'
  | 'auditLog'
  | 'account';

const has = (capabilities: readonly string[], capability: string) => capabilities.includes(capability);

export function canShowNavigationPage(page: NavigationPage, capabilities: readonly string[]): boolean {
  switch (page) {
    case 'home':
    case 'account':
      return true;
    case 'sales':
      // Invoice access is independent of the legacy document/obligation access.
      return (has(capabilities, 'document.view') && has(capabilities, 'obligation.view')) || has(capabilities, 'invoice.view') || has(capabilities, 'invoice.create');
    case 'purchases':
      // Invoice access is independent of the legacy document/obligation access.
      return (has(capabilities, 'document.view') && has(capabilities, 'obligation.view')) || has(capabilities, 'invoice.view') || has(capabilities, 'invoice.create');
    case 'documents':
      return has(capabilities, 'document.view');
    case 'banks':
      return has(capabilities, 'bank.view');
    case 'obligations':
      return has(capabilities, 'obligation.view');
    case 'assets':
      return has(capabilities, 'asset.view');
    case 'partners':
      return has(capabilities, 'partner.view');
    case 'accounting':
      return has(capabilities, 'accounting.view');
    case 'annualClosing':
      return has(capabilities, 'annual_close.view');
    case 'openingBalances':
      return has(capabilities, 'opening_balance.view');
    case 'periodicAdjustments':
      return has(capabilities, 'periodic_adjustment.view');
    case 'vat':
      return has(capabilities, 'vat.view');
    case 'monthlyClose':
      return has(capabilities, 'monthly_close.view');
    case 'fiscalYears':
      return has(capabilities, 'fiscal_year.view');
    case 'access':
      return has(capabilities, 'access.view');
    case 'sourceAuthority':
      return has(capabilities, 'source_authority.view');
    case 'companies':
      return has(capabilities, 'company.view');
    case 'auditLog':
      return has(capabilities, 'audit.view');
    case 'companyProfile':
      return has(capabilities, 'company_accounting_profile.view');
  }
}
