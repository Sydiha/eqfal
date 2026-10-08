import { describe, expect, it } from 'vitest';
import app from '../src/app';
import { requireSameOrigin } from '../src/modules/auth/origin.middleware';

type Layer = {
  route?: { path: string | string[]; methods: Record<string, boolean>; stack: Array<{ handle: unknown }> };
  name?: string;
  handle?: { stack?: Layer[] };
  regexp?: RegExp;
};

const MUTATING = ['post', 'put', 'patch', 'delete'];

/** Walks the real Express router tree (including nested routers) and lists every state-changing route. */
function collect(stack: Layer[], found: Array<{ method: string; path: string; guarded: boolean }> = []) {
  for (const layer of stack) {
    if (layer.route) {
      const handlers = layer.route.stack.map((entry) => entry.handle);
      for (const method of MUTATING.filter((m) => layer.route!.methods[m])) {
        found.push({ method: method.toUpperCase(), path: String(layer.route.path), guarded: handlers.includes(requireSameOrigin) });
      }
    } else if (layer.name === 'router' && layer.handle?.stack) {
      collect(layer.handle.stack, found);
    }
  }
  return found;
}

describe('CSRF middleware coverage guard', () => {
  const routes = collect((app as unknown as { _router: { stack: Layer[] } })._router.stack);

  it('discovers the registered state-changing routes (guards against a vacuous run)', () => {
    expect(routes.length).toBeGreaterThan(100);
    expect(routes.some((r) => r.method === 'POST' && r.path === '/auth/login')).toBe(true);
    expect(routes.some((r) => r.method === 'DELETE' && r.path === '/tax-working-papers/:fiscalYearId/adjustments/:id')).toBe(true);
  });

  it('every POST/PUT/PATCH/DELETE route runs requireSameOrigin', () => {
    const unguarded = routes.filter((r) => !r.guarded).map((r) => `${r.method} ${r.path}`);
    expect(unguarded).toEqual([]);
  });
});
