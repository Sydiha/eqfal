import { FormEvent, useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Dialog } from './Dialog';
import { StatusBadge, WorkspaceState } from './SharedUI';
import './PartnerTransactions.css';

// In-year partner financial transactions: transactions list, per-partner ledger, and the accountant's account mappings.
// Presentation only: every accounting rule (mapping validation, balanced journal, closed periods, idempotency) is enforced by the server.

export type PartnerOption = { id: string; name: string; is_active: boolean };
type TxType = 'capital_contribution' | 'current_deposit' | 'current_withdrawal' | 'loan_received' | 'loan_repayment';
type TxStatus = 'draft' | 'posted' | 'reversed';
type AccountClass = 'capital' | 'current' | 'loan';
type Tx = {
  id: string; partner_id: string; partner_name?: string; transaction_type: TxType; transaction_date: string; amount: string; channel: 'bank' | 'cash';
  bank_account_id: string | null; bank_transaction_id: string | null; document_id: string | null; reference: string | null; description: string | null;
  status: TxStatus; journal_entry_id: string | null; reversal_date: string | null; reversal_reason: string | null; version: number;
};
type BankAccount = { id: string; display_name: string; currency_code: string; is_active: boolean };
type BankTx = { id: string; bank_account_id: string; transaction_date: string; amount: string; description: string | null };
type AccountOption = { id: string; code: string; name: string; account_type: string };
type PartnerMapping = { partner_id: string; partner_name: string; mapping_key: AccountClass; account_id: string; account_code: string; account_name: string; valid: boolean };
type CashMapping = { bank_account_id: string | null; bank_account_name: string | null; account_id: string; account_code: string; account_name: string; valid: boolean };
type Mappings = { partner_mappings: PartnerMapping[]; cash_mappings: CashMapping[]; bank_accounts: BankAccount[]; accounts?: AccountOption[] };
type ClassSummary = { opening_balance: string; increases: string; decreases: string; closing_balance: string };
type Movement = { date: string; kind: 'opening_balance' | 'transaction' | 'reversal'; account_class: AccountClass; transaction_type: TxType | null; effect: string; running_balance: string; reference: string | null; description: string | null };
type Ledger = { classes: Record<AccountClass, ClassSummary>; movements: Movement[]; draft_transactions_excluded: number };
type Balances = { as_of: string; partners: Array<{ partner_id: string; partner_name: string; capital: string; current: string; loan: string }> };

export type PartnerTransactionsProps = {
  partners: PartnerOption[];
  selectedPartnerId: string | null;
  capabilities: string[];
  onUnauthorized: () => void;
};

const TYPES: TxType[] = ['capital_contribution', 'current_deposit', 'current_withdrawal', 'loan_received', 'loan_repayment'];
const CLASSES: AccountClass[] = ['capital', 'current', 'loan'];
const INFLOW: TxType[] = ['capital_contribution', 'current_deposit', 'loan_received'];
const todayIso = () => new Date().toISOString().slice(0, 10);

class ApiError extends Error { constructor(public status: number, public code: string | null) { super(code ?? String(status)); } }
async function api<T>(url: string, options: RequestInit, onUnauthorized: () => void): Promise<T> {
  const response = await fetch(url, { credentials: 'same-origin', ...options });
  if (response.status === 401) onUnauthorized();
  if (response.status === 204) return undefined as T;
  const json = await response.json().catch(() => null);
  if (!response.ok) throw new ApiError(response.status, json && typeof json.code === 'string' ? json.code : null);
  return json as T;
}
const jsonInit = (method: string, body: unknown): RequestInit => ({ method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
const isNegative = (v: string) => v.startsWith('-');

export function PartnerTransactions({ partners, selectedPartnerId, capabilities, onUnauthorized }: PartnerTransactionsProps) {
  const { t } = useTranslation();
  const can = (c: string) => capabilities.includes(c);
  const canView = can('partner.transaction.view');
  const canCreate = can('partner.transaction.create');
  const canPost = can('partner.transaction.post');
  const canReverse = can('partner.transaction.reverse');
  const canMap = can('partner.account_mapping.manage');

  const [tab, setTab] = useState<'transactions' | 'ledger' | 'mappings'>('transactions');
  const [txs, setTxs] = useState<Tx[]>([]);
  const [statusFilter, setStatusFilter] = useState('');
  const [balances, setBalances] = useState<Balances | null>(null);
  const [mappings, setMappings] = useState<Mappings | null>(null);
  const [loading, setLoading] = useState(canView);
  const [error, setError] = useState<string | null>(null);
  const [form, setForm] = useState<Tx | null | undefined>(undefined);
  const [reverseTarget, setReverseTarget] = useState<Tx | null>(null);
  const [busy, setBusy] = useState(false);

  const message = useCallback((e: unknown) => {
    const code = e instanceof ApiError ? e.code : null;
    return code && t(`partnerTx.errors.${code}`, { defaultValue: '' }) ? t(`partnerTx.errors.${code}`) : t('partnerTx.errors.generic');
  }, [t]);

  const load = useCallback(async () => {
    if (!canView) return;
    setLoading(true);
    setError(null);
    try {
      const query = statusFilter ? `?status=${statusFilter}` : '';
      const [list, bal, map] = await Promise.all([
        api<{ transactions: Tx[] }>(`/api/partners/transactions${query}`, {}, onUnauthorized),
        api<Balances>(`/api/partners/balances?as_of=${todayIso()}`, {}, onUnauthorized),
        api<Mappings>('/api/partners/account-mappings', {}, onUnauthorized),
      ]);
      setTxs(list.transactions);
      setBalances(bal);
      setMappings(map);
    } catch (e) {
      setError(message(e));
    } finally {
      setLoading(false);
    }
  }, [canView, statusFilter, onUnauthorized, message]);

  useEffect(() => { void load(); }, [load]);

  // run: errors propagate (dialogs show them in place). act: errors land in the page banner.
  const run = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    try { await fn(); await load(); } finally { setBusy(false); }
  };
  const act = async (fn: () => Promise<unknown>) => { try { await run(fn); } catch (e) { setError(message(e)); } };
  const post = (tx: Tx) => act(() => api(`/api/partners/transactions/${tx.id}/post`, jsonInit('POST', {}), onUnauthorized));
  const remove = (tx: Tx) => act(() => api(`/api/partners/transactions/${tx.id}?version=${tx.version}`, { method: 'DELETE' }, onUnauthorized));

  if (!canView) return null;

  const typeLabel = (type: TxType | null) => (type ? t(`partnerTx.types.${type}`) : t('partnerTx.openingBalance'));
  const money = (v: string) => <span className={`ptx-num${isNegative(v) ? ' is-negative' : ''}`} dir="ltr">{v}</span>;

  return <section className="pt-card ptx" aria-labelledby="ptx-title" data-testid="partner-transactions">
    <div className="pt-card__head">
      <h3 id="ptx-title">{t('partnerTx.title')}</h3>
      {canCreate && tab === 'transactions' && <button className="pt-primary" onClick={() => setForm(null)}>{t('partnerTx.create')}</button>}
    </div>
    <p className="pt-muted">{t('partnerTx.description')}</p>
    {error && <WorkspaceState tone="error">{error}</WorkspaceState>}
    <div role="tablist" className="ptx-tabs" aria-label={t('partnerTx.title')}>
      {(['transactions', 'ledger', 'mappings'] as const).map((id) => (
        <button key={id} role="tab" type="button" aria-selected={tab === id} className={tab === id ? 'is-active' : undefined} onClick={() => setTab(id)}>{t(`partnerTx.tabs.${id}`)}</button>
      ))}
    </div>
    {loading ? <WorkspaceState>{t('partnerTx.loading')}</WorkspaceState> : <>
      {tab === 'transactions' && <>
        {balances && balances.partners.length > 0 && <div className="ptx-table" data-testid="partner-balances">
          <table>
            <caption>{t('partnerTx.balancesCaption', { date: balances.as_of })}</caption>
            <thead><tr><th>{t('partners.name')}</th>{CLASSES.map((c) => <th key={c}>{t(`partnerTx.classes.${c}`)}</th>)}</tr></thead>
            <tbody>{balances.partners.map((p) => <tr key={p.partner_id}><td>{p.partner_name}</td>{CLASSES.map((c) => <td key={c}>{money(p[c])}</td>)}</tr>)}</tbody>
          </table>
        </div>}
        <p className="pt-muted">{t('partnerTx.signNote')}</p>
        <label className="ptx-filter">{t('partnerTx.statusColumn')}
          <select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)}>
            <option value="">{t('partnerTx.allStatuses')}</option>
            {(['draft', 'posted', 'reversed'] as TxStatus[]).map((s) => <option key={s} value={s}>{t(`partnerTx.status.${s}`)}</option>)}
          </select>
        </label>
        <div className="ptx-table">
          <table>
            <thead><tr><th>{t('partnerTx.date')}</th><th>{t('partners.name')}</th><th>{t('partnerTx.type')}</th><th>{t('partnerTx.amount')}</th><th>{t('partnerTx.channel')}</th><th>{t('partnerTx.statusColumn')}</th><th>{t('partners.actions')}</th></tr></thead>
            <tbody>
              {txs.length === 0 ? <tr><td colSpan={7} className="ptx-empty">{t('partnerTx.empty')}</td></tr> : txs.map((tx) => <tr key={tx.id}>
                <td dir="ltr">{tx.transaction_date}</td>
                <td>{tx.partner_name}</td>
                <td>{typeLabel(tx.transaction_type)}</td>
                <td>{money(tx.amount)}</td>
                <td>{t(`partnerTx.channels.${tx.channel}`)}{tx.bank_transaction_id && <span className="pt-note">{t('partnerTx.linkedBank')}</span>}</td>
                <td><StatusBadge status={tx.status === 'posted' ? 'open' : 'closed'}>{t(`partnerTx.status.${tx.status}`)}</StatusBadge>{tx.status === 'reversed' && tx.reversal_date && <span className="pt-note" dir="ltr">{tx.reversal_date}</span>}</td>
                <td><div className="pt-actions">
                  {tx.status === 'draft' && canCreate && <button className="pt-ghost" disabled={busy} onClick={() => setForm(tx)}>{t('partners.edit')}</button>}
                  {tx.status === 'draft' && canPost && <button className="pt-primary" disabled={busy} onClick={() => void post(tx)}>{t('partnerTx.post')}</button>}
                  {tx.status === 'draft' && canCreate && <button className="pt-ghost" disabled={busy} onClick={() => { if (window.confirm(t('partnerTx.deleteConfirm'))) void remove(tx); }}>{t('partnerTx.delete')}</button>}
                  {tx.status === 'posted' && canReverse && <button className="pt-ghost" disabled={busy} onClick={() => setReverseTarget(tx)}>{t('partnerTx.reverse')}</button>}
                </div></td>
              </tr>)}
            </tbody>
          </table>
        </div>
      </>}
      {tab === 'ledger' && <LedgerTab partners={partners} initial={selectedPartnerId} onUnauthorized={onUnauthorized} message={message} typeLabel={typeLabel} money={money} />}
      {tab === 'mappings' && <MappingsTab mappings={mappings} partners={partners} canMap={canMap} onUnauthorized={onUnauthorized} message={message} onChanged={(m) => setMappings(m)} />}
    </>}
    {form !== undefined && <TxForm tx={form} partners={partners} bankAccounts={mappings?.bank_accounts ?? []} initialPartner={selectedPartnerId} busy={busy}
      onClose={() => setForm(undefined)} onUnauthorized={onUnauthorized} message={message}
      onSave={async (payload) => { await run(() => api(form ? `/api/partners/transactions/${form.id}` : '/api/partners/transactions', jsonInit(form ? 'PATCH' : 'POST', form ? { ...payload, version: form.version } : payload), onUnauthorized)); setForm(undefined); }} />}
    {reverseTarget && <ReverseDialog tx={reverseTarget} busy={busy} message={message} onClose={() => setReverseTarget(null)}
      onConfirm={async (date, reason) => { await run(() => api(`/api/partners/transactions/${reverseTarget.id}/reverse`, jsonInit('POST', { reversal_date: date, reason }), onUnauthorized)); setReverseTarget(null); }} />}
  </section>;
}

function TxForm({ tx, partners, bankAccounts, initialPartner, busy, onClose, onSave, onUnauthorized, message }: {
  tx: Tx | null; partners: PartnerOption[]; bankAccounts: BankAccount[]; initialPartner: string | null; busy: boolean; onClose: () => void;
  onSave: (payload: Record<string, unknown>) => Promise<void>; onUnauthorized: () => void; message: (e: unknown) => string;
}) {
  const { t } = useTranslation();
  const [type, setType] = useState<TxType>(tx?.transaction_type ?? 'current_withdrawal');
  const [date, setDate] = useState(tx?.transaction_date ?? todayIso());
  const [amount, setAmount] = useState(tx?.amount ?? '');
  const [channel, setChannel] = useState<'bank' | 'cash'>(tx?.channel ?? 'cash');
  const [bankAccountId, setBankAccountId] = useState(tx?.bank_account_id ?? '');
  const [bankTxId, setBankTxId] = useState(tx?.bank_transaction_id ?? '');
  const [bankTxs, setBankTxs] = useState<BankTx[]>([]);
  const [problem, setProblem] = useState<string | null>(null);

  useEffect(() => {
    if (channel !== 'bank' || !bankAccountId) { setBankTxs([]); return; }
    let cancelled = false;
    api<{ transactions: BankTx[] }>('/api/bank-transactions', {}, onUnauthorized).then((r) => { if (!cancelled) setBankTxs(r.transactions); }).catch(() => { if (!cancelled) setBankTxs([]); });
    return () => { cancelled = true; };
  }, [channel, bankAccountId, onUnauthorized]);

  // Display-only candidates: same account, date and amount, and the direction that matches the type. The server re-validates everything.
  const candidates = useMemo(() => bankTxs.filter((b) => b.bank_account_id === bankAccountId && b.transaction_date.slice(0, 10) === date
    && Number(b.amount.replace('-', '')) === Number(amount) && isNegative(b.amount) === !INFLOW.includes(type)), [bankTxs, bankAccountId, date, amount, type]);

  const submit = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (busy) return;
    const form = new FormData(e.currentTarget);
    const text = (name: string) => String(form.get(name) ?? '').trim() || null;
    const partnerId = String(form.get('partner_id') ?? '');
    if (!partnerId || !/^(?:0|[1-9]\d{0,15})(?:\.\d{1,2})?$/.test(amount) || Number(amount) <= 0 || (channel === 'bank' && !bankAccountId)) { setProblem(t('partnerTx.errors.PARTNER_TRANSACTION_INVALID')); return; }
    setProblem(null);
    try {
      await onSave({
        partner_id: partnerId, transaction_type: type, transaction_date: date, amount, channel, bank_account_id: channel === 'bank' ? bankAccountId : null,
        bank_transaction_id: channel === 'bank' && bankTxId ? bankTxId : null, reference: text('reference'), description: text('description'),
        ...(tx?.document_id ? { document_id: tx.document_id } : {}),
      });
    } catch (err) { setProblem(message(err)); }
  };

  return <Dialog title={t(tx ? 'partnerTx.editTitle' : 'partnerTx.create')} busy={busy} onClose={onClose}>
    <form className="pt-form" onSubmit={(e) => void submit(e)}>
      {problem && <p className="pt-alert" role="alert">{problem}</p>}
      <label>{t('partners.name')}
        <select name="partner_id" required defaultValue={tx?.partner_id ?? initialPartner ?? ''}>
          <option value="" disabled>{t('partnerTx.choosePartner')}</option>
          {partners.filter((p) => p.is_active || p.id === tx?.partner_id).map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
        </select>
      </label>
      <label>{t('partnerTx.type')}
        <select value={type} onChange={(e) => setType(e.target.value as TxType)}>
          {TYPES.map((x) => <option key={x} value={x}>{t(`partnerTx.types.${x}`)}</option>)}
        </select>
        <span className="pt-note">{t(`partnerTx.typeHelp.${type}`)}</span>
      </label>
      <div className="pt-date-fields">
        <label>{t('partnerTx.date')}<input type="date" value={date} required onChange={(e) => setDate(e.target.value)} /></label>
        <label>{t('partnerTx.amount')}<input inputMode="decimal" dir="ltr" value={amount} required placeholder="0.00" onChange={(e) => setAmount(e.target.value.trim())} /></label>
      </div>
      <label>{t('partnerTx.channel')}
        <select value={channel} onChange={(e) => { setChannel(e.target.value as 'bank' | 'cash'); setBankTxId(''); }}>
          <option value="cash">{t('partnerTx.channels.cash')}</option>
          <option value="bank">{t('partnerTx.channels.bank')}</option>
        </select>
      </label>
      {channel === 'bank' && <>
        <label>{t('partnerTx.bankAccount')}
          <select value={bankAccountId} required onChange={(e) => { setBankAccountId(e.target.value); setBankTxId(''); }}>
            <option value="" disabled>{t('partnerTx.chooseBank')}</option>
            {bankAccounts.filter((b) => b.is_active || b.id === tx?.bank_account_id).map((b) => <option key={b.id} value={b.id}>{b.display_name} ({b.currency_code})</option>)}
          </select>
        </label>
        <label>{t('partnerTx.bankTransaction')}
          <select value={bankTxId} onChange={(e) => setBankTxId(e.target.value)}>
            <option value="">{t('partnerTx.noBankTransaction')}</option>
            {candidates.map((b) => <option key={b.id} value={b.id}>{b.transaction_date.slice(0, 10)} · {b.amount}{b.description ? ` · ${b.description}` : ''}</option>)}
            {bankTxId && !candidates.some((b) => b.id === bankTxId) && <option value={bankTxId}>{t('partnerTx.linkedBank')}</option>}
          </select>
          <span className="pt-note">{t('partnerTx.bankTransactionHelp')}</span>
        </label>
      </>}
      <label>{t('partnerTx.reference')}<input name="reference" maxLength={200} defaultValue={tx?.reference ?? ''} /></label>
      <label>{t('partners.note')}<textarea name="description" maxLength={1000} defaultValue={tx?.description ?? ''} /></label>
      <div className="modal-actions">
        <button type="button" className="pt-ghost" disabled={busy} onClick={onClose}>{t('common.cancel')}</button>
        <button className="pt-primary" type="submit" disabled={busy}>{busy ? t('partners.saving') : t('common.save')}</button>
      </div>
    </form>
  </Dialog>;
}

function ReverseDialog({ tx, busy, message, onClose, onConfirm }: { tx: Tx; busy: boolean; message: (e: unknown) => string; onClose: () => void; onConfirm: (date: string, reason: string) => Promise<void> }) {
  const { t } = useTranslation();
  const [problem, setProblem] = useState<string | null>(null);
  const [date, setDate] = useState(todayIso() < tx.transaction_date ? tx.transaction_date : todayIso());
  const [reason, setReason] = useState('');
  return <Dialog title={t('partnerTx.reverseTitle')} busy={busy} onClose={onClose}>
    <form className="pt-form" onSubmit={(e) => { e.preventDefault(); if (!busy && reason.trim()) onConfirm(date, reason.trim()).catch((err) => setProblem(message(err))); }}>
      {problem && <p className="pt-alert" role="alert">{problem}</p>}
      <p className="pt-close-text">{t('partnerTx.reverseText', { type: t(`partnerTx.types.${tx.transaction_type}`), amount: tx.amount, date: tx.transaction_date })}</p>
      <label>{t('partnerTx.reversalDate')}<input type="date" min={tx.transaction_date} value={date} required onChange={(e) => setDate(e.target.value)} /></label>
      <label>{t('partners.reason')}<textarea required maxLength={500} value={reason} onChange={(e) => setReason(e.target.value)} /></label>
      <div className="modal-actions">
        <button type="button" className="pt-ghost" disabled={busy} onClick={onClose}>{t('common.cancel')}</button>
        <button className="pt-primary" type="submit" disabled={busy || !reason.trim()}>{t('partnerTx.reverse')}</button>
      </div>
    </form>
  </Dialog>;
}

function LedgerTab({ partners, initial, onUnauthorized, message, typeLabel, money }: {
  partners: PartnerOption[]; initial: string | null; onUnauthorized: () => void; message: (e: unknown) => string;
  typeLabel: (t: TxType | null) => string; money: (v: string) => JSX.Element;
}) {
  const { t } = useTranslation();
  const year = new Date().getFullYear();
  const [partnerId, setPartnerId] = useState(initial ?? partners[0]?.id ?? '');
  const [from, setFrom] = useState(`${year}-01-01`);
  const [to, setTo] = useState(`${year}-12-31`);
  const [ledger, setLedger] = useState<Ledger | null>(null);
  const [state, setState] = useState<'idle' | 'loading' | 'error'>('idle');
  const [problem, setProblem] = useState<string | null>(null);
  const valid = Boolean(partnerId) && from !== '' && to !== '' && to >= from;

  useEffect(() => {
    if (!valid) { setLedger(null); return; }
    let cancelled = false;
    setState('loading');
    api<Ledger & Record<string, unknown>>(`/api/partners/${partnerId}/ledger?from=${from}&to=${to}`, {}, onUnauthorized)
      .then((r) => { if (!cancelled) { setLedger(r); setState('idle'); setProblem(null); } })
      .catch((e) => { if (!cancelled) { setState('error'); setProblem(message(e)); } });
    return () => { cancelled = true; };
  }, [partnerId, from, to, valid, onUnauthorized, message]);

  return <div className="ptx-ledger">
    <div className="pt-date-fields ptx-ledger__filters">
      <label>{t('partners.name')}
        <select value={partnerId} onChange={(e) => setPartnerId(e.target.value)}>
          {partners.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
        </select>
      </label>
      <label>{t('partnerTx.from')}<input type="date" value={from} onChange={(e) => setFrom(e.target.value)} /></label>
      <label>{t('partnerTx.to')}<input type="date" value={to} min={from} onChange={(e) => setTo(e.target.value)} /></label>
    </div>
    {!valid && <WorkspaceState>{t('partnerTx.ledgerChoose')}</WorkspaceState>}
    {state === 'error' && <WorkspaceState tone="error">{problem}</WorkspaceState>}
    {state === 'loading' && <WorkspaceState>{t('partnerTx.loading')}</WorkspaceState>}
    {ledger && state === 'idle' && valid && <>
      <div className="ptx-class-cards">
        {CLASSES.map((c) => <dl key={c} className="ptx-class-card" data-testid={`ledger-class-${c}`}>
          <dt>{t(`partnerTx.classes.${c}`)}</dt>
          <dd><span>{t('partnerTx.opening')}</span>{money(ledger.classes[c].opening_balance)}</dd>
          <dd><span>{t('partnerTx.increases')}</span>{money(ledger.classes[c].increases)}</dd>
          <dd><span>{t('partnerTx.decreases')}</span>{money(ledger.classes[c].decreases)}</dd>
          <dd className="is-total"><span>{t('partnerTx.closing')}</span>{money(ledger.classes[c].closing_balance)}</dd>
        </dl>)}
      </div>
      <p className="pt-muted">{t('partnerTx.signNote')}</p>
      {ledger.draft_transactions_excluded > 0 && <p className="pt-note">{t('partnerTx.draftsExcluded', { count: ledger.draft_transactions_excluded })}</p>}
      <div className="ptx-table">
        <table>
          <thead><tr><th>{t('partnerTx.date')}</th><th>{t('partnerTx.type')}</th><th>{t('partnerTx.account')}</th><th>{t('partnerTx.movement')}</th><th>{t('partnerTx.runningBalance')}</th><th>{t('partnerTx.reference')}</th></tr></thead>
          <tbody>
            {ledger.movements.length === 0 ? <tr><td colSpan={6} className="ptx-empty">{t('partnerTx.noMovements')}</td></tr> : ledger.movements.map((m, i) => <tr key={`${m.date}-${i}`}>
              <td dir="ltr">{m.date}</td>
              <td>{m.kind === 'reversal' ? `${t('partnerTx.reversalOf')} ${typeLabel(m.transaction_type)}` : typeLabel(m.transaction_type)}</td>
              <td>{t(`partnerTx.classes.${m.account_class}`)}</td>
              <td>{money(m.effect)}</td>
              <td>{money(m.running_balance)}</td>
              <td>{m.reference ?? m.description ?? ''}</td>
            </tr>)}
          </tbody>
        </table>
      </div>
    </>}
  </div>;
}

function MappingsTab({ mappings, partners, canMap, onUnauthorized, message, onChanged }: {
  mappings: Mappings | null; partners: PartnerOption[]; canMap: boolean; onUnauthorized: () => void; message: (e: unknown) => string; onChanged: (m: Mappings) => void;
}) {
  const { t } = useTranslation();
  const [problem, setProblem] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  if (!mappings) return <WorkspaceState>{t('partnerTx.loading')}</WorkspaceState>;
  const accounts = mappings.accounts ?? [];
  const typesFor = (key: AccountClass | 'cash') => (key === 'capital' ? ['equity'] : key === 'loan' ? ['liability'] : key === 'current' ? ['equity', 'liability'] : ['asset']);
  const optionsFor = (key: AccountClass | 'cash') => accounts.filter((a) => typesFor(key).includes(a.account_type));
  const current = (partnerId: string, key: AccountClass) => mappings.partner_mappings.find((m) => m.partner_id === partnerId && m.mapping_key === key);
  const cash = (bankId: string | null) => mappings.cash_mappings.find((m) => m.bank_account_id === bankId);

  const change = async (url: string, accountId: string) => {
    setSaving(true);
    setProblem(null);
    try {
      const next = accountId
        ? await api<Mappings>(url, jsonInit('PUT', { account_id: accountId }), onUnauthorized)
        : await api<Mappings>(url, { method: 'DELETE' }, onUnauthorized);
      onChanged(next);
    } catch (e) { setProblem(message(e)); } finally { setSaving(false); }
  };
  const picker = (label: string, value: { account_id: string; valid: boolean } | undefined, key: AccountClass | 'cash', url: string) => (
    <label className="ptx-map-row">
      <span>{label}</span>
      {canMap
        ? <select value={value?.account_id ?? ''} disabled={saving} onChange={(e) => void change(url, e.target.value)}>
          <option value="">{t('partnerTx.notMapped')}</option>
          {optionsFor(key).map((a) => <option key={a.id} value={a.id}>{a.code} — {a.name}</option>)}
          {value && !optionsFor(key).some((a) => a.id === value.account_id) && <option value={value.account_id}>{value.account_id.slice(0, 8)}</option>}
        </select>
        : <span>{value ? 'OK' : t('partnerTx.notMapped')}</span>}
      {value && !value.valid && <span className="pt-note is-warning">{t('partnerTx.mappingInvalid')}</span>}
    </label>
  );

  return <div className="ptx-mappings">
    <p className="pt-muted">{t('partnerTx.mappingsHelp')}</p>
    {problem && <WorkspaceState tone="error">{problem}</WorkspaceState>}
    {partners.map((p) => <fieldset key={p.id} className="ptx-map-group">
      <legend>{p.name}</legend>
      {CLASSES.map((c) => <div key={c}>{picker(t(`partnerTx.mapKeys.${c}`), current(p.id, c), c, `/api/partners/${p.id}/account-mappings/${c}`)}</div>)}
    </fieldset>)}
    <fieldset className="ptx-map-group">
      <legend>{t('partnerTx.cashAccounts')}</legend>
      <div>{picker(t('partnerTx.channels.cash'), cash(null), 'cash', '/api/partners/cash-account-mappings/cash')}</div>
      {mappings.bank_accounts.map((b) => <div key={b.id}>{picker(`${b.display_name} (${b.currency_code})`, cash(b.id), 'cash', `/api/partners/cash-account-mappings/${b.id}`)}</div>)}
    </fieldset>
  </div>;
}
