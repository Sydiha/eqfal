import { describe, it, expect } from 'vitest';
import request from 'supertest';
import app from '../src/app';

describe('Health endpoint smoke test', () => {
  it('GET /api/health → 200 with status ok', async () => {
    const res = await request(app).get('/api/health');
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ok');
    expect(res.body.timestamp).toBeDefined();
    expect(res.body.services.database.status).toMatch(/^(connected|disconnected)$/);
  });

  it('GET /unknown-route → 404', async () => {
    const res = await request(app).get('/unknown-route');
    expect(res.status).toBe(404);
  });
});
