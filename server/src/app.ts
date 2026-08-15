import express, { Request, Response, NextFunction } from 'express';
import { healthRouter } from './modules/health/health.router';
import { authRouter } from './modules/auth/auth.router';
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

// 404
app.use((_req: Request, res: Response) => {
  res.status(404).json({ error: 'Not found' });
});

export default app;
