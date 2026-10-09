import express, { Request, Response, NextFunction } from 'express';
import { healthRouter } from './modules/health/health.router';
import { authRouter } from './modules/auth/auth.router';
import { fiscalYearRouter } from './modules/fiscal-years/fiscal-year.router';
import { documentRouter } from './modules/documents/document.router';
import { bankRouter } from './modules/banking/bank.router';
import { bankImportResumeRouter } from './modules/banking/bank-import-resume.router';
import { bankReconciliationRouter } from './modules/banking/bank-reconciliation.router';
import { documentSettlementRouter } from './modules/banking/document-settlement.router';
import { custodyRouter } from './modules/banking/custody.router';
import { partnerRouter } from './modules/partners/partner.router';
import { obligationRouter } from './modules/obligations/obligation.router';
import { obligationAgingRouter } from './modules/obligations/obligation-aging';
import { monthlyCloseRouter } from './modules/monthly-close/monthly-close.router';
import { vatRouter } from './modules/vat/vat.router';
import { vatReportRouter } from './modules/vat/vat-report.router';
import { vatAdjustmentsRouter } from './modules/vat/vat-adjustments.router';
import { vatReturnsRouter } from './modules/vat/vat-returns.router';
import { accountingRouter } from './modules/accounting/accounting.router';
import { salesRouter } from './modules/sales/sales.router';
import { purchasesRouter } from './modules/purchases/purchases.router';
import { fixedAssetsRouter } from './modules/fixed-assets/fixed-assets.router';
import { assetPolicyRouter } from './modules/fixed-assets/asset-policy.router';
import { assetEstimateChangeRouter } from './modules/fixed-assets/asset-estimate-change.router';
import { companyRouter } from './modules/companies/company.router';
import { companyAccountingProfileRouter } from './modules/company-accounting-profile/company-accounting-profile.router';
import { openingBalancesRouter } from './modules/opening-balances/opening-balances.router';
import { periodicAdjustmentsRouter } from './modules/periodic-adjustments/periodic-adjustments.router';
import { annualClosingRouter } from './modules/annual-closing/annual-closing.router';
import { taxWorkpaperRouter } from './modules/tax-working-papers/tax-working-paper.router';
import { accessAdministrationRouter } from './modules/memberships/access-administration.router';
import { homeAlertsRouter } from './modules/home-alerts/home-alerts.router';
import { managerFinancialSnapshotRouter } from './modules/manager-financial-snapshot/manager-financial-snapshot.router';
import { whtReviewRouter } from './modules/wht-reviews/wht-review.router';
import { auditLogRouter } from './modules/audit-log/audit-log.router';
import { invoiceRouter } from './modules/invoices/invoice.router';
import logger from './shared/logger';
import config from './config';
import { securityHeaders } from './shared/security-headers';
import { frontendRouter } from './shared/frontend-static';

const app = express();

// Client IP (used by login rate limiting) honours X-Forwarded-For only for the proxies named in TRUST_PROXY.
app.set('trust proxy', config.trustProxy);
app.disable('x-powered-by');
app.use(securityHeaders(config.env === 'production'));

app.use(express.json({ limit: '64kb' }));

// Structured request logging. Never log bodies/cookies/auth tokens.
app.use((req: Request, _res: Response, next: NextFunction) => {
  logger.info({ method: req.method, url: req.url }, 'request');
  next();
});

// Module routers
app.use('/api', healthRouter);
app.use('/api', authRouter);
app.use('/api', fiscalYearRouter);
app.use('/api', documentRouter);
app.use('/api', bankRouter);
app.use('/api', bankImportResumeRouter);
app.use('/api', bankReconciliationRouter);
app.use('/api', documentSettlementRouter);
app.use('/api', custodyRouter);
app.use('/api', partnerRouter);
app.use('/api', obligationAgingRouter);
app.use('/api', obligationRouter);
app.use('/api', monthlyCloseRouter);
app.use('/api', vatRouter);
app.use('/api', vatReportRouter);
app.use('/api', vatAdjustmentsRouter);
app.use('/api', vatReturnsRouter);
app.use('/api', accountingRouter);
app.use('/api', salesRouter);
app.use('/api', purchasesRouter);
app.use('/api', fixedAssetsRouter);
app.use('/api', assetPolicyRouter);
app.use('/api', assetEstimateChangeRouter);
app.use('/api', companyAccountingProfileRouter);
app.use('/api', openingBalancesRouter);
app.use('/api', periodicAdjustmentsRouter);
app.use('/api', annualClosingRouter);
app.use('/api', taxWorkpaperRouter);
app.use('/api', accessAdministrationRouter);
app.use('/api', companyRouter);
app.use('/api', homeAlertsRouter);
app.use('/api', managerFinancialSnapshotRouter);
app.use('/api', whtReviewRouter);
app.use('/api', auditLogRouter);
app.use('/api', invoiceRouter);

// Production only: serve the built React app (client/dist) and SPA routes from the same origin as the API.
// Development keeps the Vite dev server + proxy and is unaffected.
if (config.env === 'production') app.use(frontendRouter(config.frontendDistDir));

// 404
app.use((_req: Request, res: Response) => {
  res.status(404).json({ error: 'Not found' });
});

// Central error boundary: log server-side details, return a generic response.
app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
  // Client errors raised by body parsing (malformed JSON, oversized body): fixed messages, never the parser's text.
  const status = (err as { status?: unknown } | null)?.status;
  if (status === 400 || status === 413) {
    res.status(status).json({ error: status === 413 ? 'Payload too large' : 'Invalid request body' });
    return;
  }
  logger.error({ err }, 'Unhandled request error');
  res.status(500).json({ error: 'Internal server error' });
});

export default app;
