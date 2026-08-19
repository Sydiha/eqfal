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
import { monthlyCloseRouter } from './modules/monthly-close/monthly-close.router';
import { vatRouter } from './modules/vat/vat.router';
import { vatReportRouter } from './modules/vat/vat-report.router';
import { accountingRouter } from './modules/accounting/accounting.router';
import logger from './shared/logger';

const app = express();

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
app.use('/api', obligationRouter);
app.use('/api', monthlyCloseRouter);
app.use('/api', vatRouter);
app.use('/api', vatReportRouter);
app.use('/api', accountingRouter);

// 404
app.use((_req: Request, res: Response) => {
  res.status(404).json({ error: 'Not found' });
});

// Central error boundary: log server-side details, return a generic response.
app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
  logger.error({ err }, 'Unhandled request error');
  res.status(500).json({ error: 'Internal server error' });
});

export default app;
