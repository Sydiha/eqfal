import { Router } from 'express';
import { checkHealth } from './health.service';

export const healthRouter = Router();

healthRouter.get('/health', async (_req, res) => {
  const report = await checkHealth();
  res.json(report);
});
