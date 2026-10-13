/** Pure decision logic for the invoice workspace. The server remains the only authority; this only decides what to offer and why something is unavailable. */
export type InvoiceCaps = {
  canView: boolean; canCreate: boolean; canEdit: boolean; canSubmit: boolean;
  /** invoice.cancel (draft and submitted invoices only; approved invoices are corrected by credit/debit notes). */
  canCancel?: boolean;
  /** invoice.adjust: register / edit / cancel a draft external credit or debit note. invoice.adjust_approve (plus obligation.confirm and accounting.journal.create) approves it. */
  canAdjust?: boolean; canAdjustApprove?: boolean;
  /** invoice.recurring: create / edit / pause / resume / end recurring schedules and run due ones. Generated invoices are drafts only. */
  canRecurring?: boolean;
  /** invoice.approve. The server also requires obligation.confirm and accounting.journal.create, and forbids self-approval. */
  canApprove?: boolean; canConfirmObligation?: boolean; canCreateJournal?: boolean;
  /** accounting.journal.post */
  canPostJournal?: boolean;
  /** obligation.settlement.create (the existing settlement authorization; no invoice-specific capability). */
  canCreateSettlement?: boolean;
  canViewAccounting?: boolean; canViewObligations?: boolean; canViewVat?: boolean; canViewDocuments?: boolean;
  currentUserId?: string;
};

export type WorkflowInvoice = {
  status: 'draft' | 'submitted' | 'approved' | 'cancelled';
  created_by_user_id?: string | null;
  obligation?: { id: string; is_cancelled: boolean } | null;
  journal?: { id: string; status: string } | null;
};

export type NextAction = {
  kind: 'submit' | 'approve' | 'post' | 'none';
  enabled: boolean;
  /** Translation key suffix under invoiceWorkspace.reasons explaining why the action is unavailable, or what happens next when kind is none. */
  reason: string | null;
};

export function nextAction(invoice: WorkflowInvoice, caps: InvoiceCaps): NextAction {
  const obligationCancelled = invoice.obligation?.is_cancelled === true;
  if (invoice.status === 'cancelled' || obligationCancelled) return { kind: 'none', enabled: false, reason: 'cancelled' };
  if (invoice.status === 'draft') return caps.canSubmit ? { kind: 'submit', enabled: true, reason: null } : { kind: 'submit', enabled: false, reason: 'noSubmit' };
  if (invoice.status === 'submitted') {
    if (!caps.canApprove) return { kind: 'approve', enabled: false, reason: 'noApprove' };
    if (!caps.canConfirmObligation || !caps.canCreateJournal) return { kind: 'approve', enabled: false, reason: 'approveCapabilities' };
    if (caps.currentUserId && invoice.created_by_user_id && invoice.created_by_user_id === caps.currentUserId) return { kind: 'approve', enabled: false, reason: 'selfApproval' };
    return { kind: 'approve', enabled: true, reason: null };
  }
  // approved
  if (!invoice.journal) return { kind: 'post', enabled: false, reason: 'noJournal' };
  if (invoice.journal.status === 'posted') return { kind: 'none', enabled: false, reason: 'posted' };
  if (!caps.canPostJournal) return { kind: 'post', enabled: false, reason: 'noPost' };
  return { kind: 'post', enabled: true, reason: null };
}

export type SettlementAction = { enabled: boolean; reason: string | null };

/**
 * Whether the contextual "Record collection/payment" action is offered. Settlement stays a separate controlled step after
 * approval and posting; the server re-checks everything. The outstanding amount comes from the server read model.
 */
export function settlementAction(invoice: WorkflowInvoice & { outstanding_amount?: string | null }, caps: InvoiceCaps): SettlementAction {
  if (invoice.status === 'cancelled' || invoice.obligation?.is_cancelled === true) return { enabled: false, reason: 'cancelled' };
  if (invoice.status !== 'approved' || !invoice.obligation) return { enabled: false, reason: 'settleNotApproved' };
  if (!invoice.journal || invoice.journal.status !== 'posted') return { enabled: false, reason: 'settleNotPosted' };
  if (invoice.outstanding_amount != null && Number(invoice.outstanding_amount) <= 0) return { enabled: false, reason: 'settleFullySettled' };
  if (!caps.canCreateSettlement) return { enabled: false, reason: 'noSettle' };
  if (!caps.canViewObligations) return { enabled: false, reason: 'noViewObligations' };
  return { enabled: true, reason: null };
}

/** Sums decimal strings exactly (integer cents), so a page subtotal never drifts the way floating point does. */
export function sumDecimalStrings(values: ReadonlyArray<string | null | undefined>): string {
  let cents = 0n;
  for (const value of values) {
    const match = /^(-?)(\d+)(?:\.(\d{1,2})\d*)?$/.exec((value ?? '').trim());
    if (!match) continue;
    const amount = BigInt(match[2]!) * 100n + BigInt((match[3] ?? '').padEnd(2, '0') || '0');
    cents += match[1] ? -amount : amount;
  }
  const negative = cents < 0n;
  const abs = negative ? -cents : cents;
  return `${negative ? '-' : ''}${abs / 100n}.${String(abs % 100n).padStart(2, '0')}`;
}

export const PAGE_SIZE = 25;
export const INVOICE_STATUSES = ['draft', 'submitted', 'approved', 'cancelled'] as const;
