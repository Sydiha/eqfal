// Test helper for C4-P2b-1: accepts every acceptable incomplete-evidence issue of a review through the real API
// (GET /exceptions for identity and fingerprint, POST /exceptions with a reason and, for totals, the displayed difference).
export const ACCEPT_REASON = 'Evidence will follow; accepted for this test';

type Req = { req: (method: string, url: string, body?: unknown) => Promise<{ status: number; json: any }> };

export async function acceptAllIncomplete(client: Req, fiscalYearId: string, reason = ACCEPT_REASON) {
  const list = await client.req('GET', `/opening-balances/${fiscalYearId}/exceptions`);
  if (list.status !== 200) return list;
  const entries = (list.json.issues as any[])
    .filter((i) => i.acceptable && i.acceptance !== 'accepted_unverified')
    .map((i) => ({
      issue_key: i.issue_key, evidence_fingerprint: i.evidence_fingerprint, reason,
      ...(i.code === 'OB_SUBLEDGER_TOTAL_DIFFERENCE' ? { acknowledged_difference: i.detail.difference } : {}),
    }));
  if (!entries.length) return list;
  return client.req('POST', `/opening-balances/${fiscalYearId}/exceptions`, entries);
}
