import { ReactNode, useEffect, useMemo, useState } from 'react';
import { Alert, Badge, Button, Group, Loader, Stack, Text, TextInput } from '@mantine/core';
import { useTranslation } from 'react-i18next';
import { Dialog } from './Dialog';
import { clearQueryParameters, readQueryParameter, writeQueryParameters } from '../navigation/queryState';
import { ExportButtons } from './ExportButtons';
import { useActiveCompanyName } from '../context/CompanyContext';
import { bankReconciliationExport, generatedStamp } from '../export/reportExport';
import { DataWorkspace, DetailPane, WorkspaceState, WorkspaceToolbar } from './SharedUI';

type ReconciliationStatus = 'unmatched' | 'matched' | 'reconciled';
type Transaction = {
  id: string;
  transaction_date: string;
  description: string | null;
  bank_reference: string | null;
  amount: string;
  running_balance: string | null;
  currency_code: string;
  reconciliation_status: ReconciliationStatus;
};
type Match = { id: string; document_id: string; note: string | null };
type LinkedObligation = {
  id: string;
  direction: 'receivable' | 'payable';
  counterparty: string;
  original_amount: string;
  settled_amount: string;
  remaining_amount: string;
  state: 'open' | 'partial' | 'settled' | 'cancelled';
};
type CandidateDocument = {
  id: string;
  status: 'needs_review' | 'approved';
  document_type: string | null;
  counterparty_name: string | null;
  document_date: string | null;
  reference_number: string | null;
  total_amount: string | null;
  original_filename: string;
  linked_obligation: LinkedObligation | null;
};
type CandidateResponse = { transaction: { id: string; reconciliation_status: ReconciliationStatus }; match: Match | null; documents: CandidateDocument[] };

type Props = { canView: boolean; canMatch: boolean; canReconcile: boolean; onUnauthorized: () => void };

async function api<T>(url: string, init?: RequestInit, onUnauthorized?: () => void): Promise<T> {
  const response = await fetch(url, init);
  if (response.status === 401) { onUnauthorized?.(); throw new Error('unauthorized'); }
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(typeof body.error === 'string' ? body.error : `HTTP ${response.status}`);
  return body as T;
}

function displayDate(value: string) {
  const raw = value.slice(0, 10);
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(raw);
  return match ? `${match[1]}/${match[2]}/${match[3]}` : raw || '—';
}

function formatMoney(amount: string, currency: string) {
  const numeric = Number(amount);
  if (!Number.isFinite(numeric)) return `${amount} ${currency}`;
  return `${new Intl.NumberFormat('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(numeric)} ${currency}`;
}

function formatAmount(amount: string, currency: string) {
  const numeric = Number(amount);
  if (!Number.isFinite(numeric)) return `${amount} ${currency}`;
  const value = new Intl.NumberFormat('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(numeric);
  return currency === 'SAR' ? value : `${value} ${currency}`;
}

const PAGE_SIZE = 10;
const ico = (children: ReactNode) => <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{children}</svg>;

const local = {
  ar: {
    title: 'الحركات البنكية',
    description: 'راجع الحركة، حالتها، ومبلغها أولًا. التفاصيل البنكية والإجراءات الثانوية متاحة عند الحاجة.',
    date: 'التاريخ', descriptionLabel: 'البيان', amount: 'المبلغ', status: 'الحالة', action: 'الإجراء',
    reference: 'المرجع البنكي', balance: 'الرصيد الجاري', details: 'التفاصيل', hideDetails: 'إخفاء التفاصيل',
    refresh: 'تحديث', empty: 'لا توجد حركات بنكية', error: 'تعذر تحميل الحركات البنكية',
    documentType: 'نوع المستند', counterparty: 'الطرف المقابل', total: 'المبلغ الإجمالي', obligation: 'الذمة المرتبطة', remaining: 'المبلغ المتبقي', noObligation: 'لا توجد',
    statementTitle: 'حركات كشف الحساب البنكي', transactionsCount: (count: number) => `${count} حركة`, showing: (shown: number, total: number) => `إظهار ${shown} من ${total} حركة`, amountSar: 'المبلغ (ر.س)', matchStatus: 'حالة المطابقة', reset: 'إعادة تعيين', pagination: 'التنقل بين الصفحات', prevPage: 'الصفحة السابقة', nextPage: 'الصفحة التالية',
    selectedDetails: 'تفاصيل الحركة المحددة', bankData: 'بيانات البنك', actionsPanel: 'الإجراءات', pendingMetric: 'قيد المراجعة', matchedMetric: 'مطابق', unmatchedMetric: 'غير مطابق',
    statuses: { unmatched: 'غير مطابق', matched: 'قيد المراجعة', reconciled: 'مطابق' } as Record<ReconciliationStatus, string>,
    toolbar: 'البحث وتصفية الحركات البنكية', searchTransactions: 'البحث في الحركات', searchPlaceholder: 'البيان أو المرجع أو المبلغ', reconciliation: 'حالة التسوية', allStatuses: 'كل الحالات', from: 'من تاريخ', to: 'إلى تاريخ', amountMin: 'الحد الأدنى للمبلغ', amountMax: 'الحد الأعلى للمبلغ', resultCount: (count: number) => `عدد النتائج: ${count}`, clearFilters: 'مسح عوامل التصفية', noResults: 'لا توجد حركات تطابق عوامل التصفية.',
  },
  en: {
    title: 'Bank transactions',
    description: 'Review the transaction, status, and amount first. Bank metadata and secondary actions remain available on demand.',
    date: 'Date', descriptionLabel: 'Description', amount: 'Amount', status: 'Status', action: 'Action',
    reference: 'Bank reference', balance: 'Running balance', details: 'Details', hideDetails: 'Hide details',
    refresh: 'Refresh', empty: 'No bank transactions', error: 'Unable to load bank transactions',
    documentType: 'Document type', counterparty: 'Counterparty', total: 'Total amount', obligation: 'Linked obligation', remaining: 'Remaining amount', noObligation: 'None',
    statementTitle: 'Bank statement transactions', transactionsCount: (count: number) => `${count} transactions`, showing: (shown: number, total: number) => `Showing ${shown} of ${total} transactions`, amountSar: 'Amount (SAR)', matchStatus: 'Match status', reset: 'Reset', pagination: 'Pagination', prevPage: 'Previous page', nextPage: 'Next page',
    selectedDetails: 'Selected transaction details', bankData: 'Bank data', actionsPanel: 'Actions', pendingMetric: 'Matched', matchedMetric: 'Reconciled', unmatchedMetric: 'Unmatched',
    statuses: { unmatched: 'Unmatched', matched: 'Matched', reconciled: 'Reconciled' } as Record<ReconciliationStatus, string>,
    toolbar: 'Search and filter bank transactions', searchTransactions: 'Search transactions', searchPlaceholder: 'Description, reference, or amount', reconciliation: 'Reconciliation status', allStatuses: 'All statuses', from: 'From date', to: 'To date', amountMin: 'Minimum amount', amountMax: 'Maximum amount', resultCount: (count: number) => `${count} results`, clearFilters: 'Clear filters', noResults: 'No transactions match the filters.',
  },
};

const reconciliationStatuses = ['unmatched', 'matched', 'reconciled'] as const;
const discoveryParameters = ['search', 'reconciliation', 'from', 'to', 'amountMin', 'amountMax'] as const;
const datePattern = /^\d{4}-(0[1-9]|1[0-2])-([0-2]\d|3[01])$/;
type Filters = { search: string; reconciliation: string; from: string; to: string; amountMin: string; amountMax: string };
const validDate = (value: string | null) => value && datePattern.test(value) && new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value ? value : '';
const validAmount = (value: string | null) => value != null && value.trim() !== '' && Number.isFinite(Number(value)) ? value : '';
const readFilters = (): Filters => ({
  search: readQueryParameter('search') ?? '',
  reconciliation: readQueryParameter('reconciliation', { allowedValues: reconciliationStatuses }) ?? '',
  from: validDate(readQueryParameter('from')),
  to: validDate(readQueryParameter('to')),
  amountMin: validAmount(readQueryParameter('amountMin')),
  amountMax: validAmount(readQueryParameter('amountMax')),
});

export function BankTransactionsView({ canView, canMatch, canReconcile, onUnauthorized }: Props) {
  const { t, i18n } = useTranslation();
  const s = i18n.language === 'ar' ? local.ar : local.en;
  const [transactions, setTransactions] = useState<Transaction[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [matchTransaction, setMatchTransaction] = useState<Transaction | null>(null);
  const [candidateData, setCandidateData] = useState<CandidateResponse | null>(null);
  const [candidateSearch, setCandidateSearch] = useState('');
  const [selectedDocument, setSelectedDocument] = useState<string | null>(null);
  const [matchNote, setMatchNote] = useState('');
  const [matchBusy, setMatchBusy] = useState(false);
  const [filters, setFilters] = useState<Filters>(readFilters);
  const [page, setPage] = useState(1);
  const company = useActiveCompanyName() ?? '';

  const counts = useMemo(() => transactions.reduce((acc, tx) => {
    acc[tx.reconciliation_status] += 1;
    return acc;
  }, { unmatched: 0, matched: 0, reconciled: 0 }), [transactions]);

  const refresh = async () => {
    if (!canView) return;
    setLoading(true); setError('');
    try {
      const data = await api<{ transactions: Transaction[] }>('/api/bank-transactions', undefined, onUnauthorized);
      setTransactions(data.transactions);
    } catch (e) { setError(e instanceof Error ? e.message : s.error); }
    finally { setLoading(false); }
  };
  useEffect(() => { void refresh(); }, [canView]);
  useEffect(() => {
    const restore = () => setFilters(readFilters());
    window.addEventListener('popstate', restore);
    return () => window.removeEventListener('popstate', restore);
  }, []);

  const updateFilter = (name: keyof Filters, value: string) => {
    setFilters(current => ({ ...current, [name]: value })); setPage(1);
    writeQueryParameters({ [name]: value || null }, name === 'search' ? 'replace' : 'push');
  };
  const clearFilters = () => {
    setFilters({ search: '', reconciliation: '', from: '', to: '', amountMin: '', amountMax: '' }); setPage(1);
    clearQueryParameters(discoveryParameters);
  };
  const filteredTransactions = useMemo(() => {
    const needle = filters.search.trim().toLocaleLowerCase();
    const minimum = validAmount(filters.amountMin) ? Number(filters.amountMin) : null;
    const maximum = validAmount(filters.amountMax) ? Number(filters.amountMax) : null;
    return transactions.map((transaction, index) => ({ transaction, index })).filter(({ transaction }) => {
      const amount = Number(transaction.amount);
      const date = transaction.transaction_date.slice(0, 10);
      const searchable = [transaction.description, transaction.bank_reference, transaction.amount, formatMoney(transaction.amount, transaction.currency_code), transaction.running_balance];
      return (!needle || searchable.some(value => value?.toLocaleLowerCase().includes(needle)))
        && (!filters.reconciliation || transaction.reconciliation_status === filters.reconciliation)
        && (!filters.from || date >= filters.from) && (!filters.to || date <= filters.to)
        && (minimum == null || (Number.isFinite(amount) && amount >= minimum))
        && (maximum == null || (Number.isFinite(amount) && amount <= maximum));
    }).sort((a, b) => b.transaction.transaction_date.localeCompare(a.transaction.transaction_date) || a.index - b.index).map(({ transaction }) => transaction);
  }, [filters, transactions]);
  const selectedTransaction = filteredTransactions.find(transaction => transaction.id === selectedId) ?? null;
  const filtersActive = Object.values(filters).some(Boolean);

  const loadCandidates = async (transaction: Transaction, search = '') => {
    setMatchTransaction(transaction); setMatchBusy(true); setError('');
    try {
      const data = await api<CandidateResponse>(`/api/bank-transactions/${transaction.id}/match-candidates${search ? `?search=${encodeURIComponent(search)}` : ''}`, undefined, onUnauthorized);
      setCandidateData(data); setSelectedDocument(data.match?.document_id ?? null);
    } catch (e) { setError(e instanceof Error ? e.message : t('banks.reconciliationError')); setMatchTransaction(null); }
    finally { setMatchBusy(false); }
  };
  const closeMatch = () => {
    setMatchTransaction(null); setCandidateData(null); setCandidateSearch(''); setSelectedDocument(null); setMatchNote('');
  };
  const createMatch = async () => {
    if (!matchTransaction || !selectedDocument) return;
    setMatchBusy(true); setError('');
    try {
      await api(`/api/bank-transactions/${matchTransaction.id}/match`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ document_id: selectedDocument, note: matchNote || undefined }) }, onUnauthorized);
      setMatchBusy(false); closeMatch(); await refresh();
    } catch (e) { setError(e instanceof Error ? e.message : t('banks.reconciliationError')); setMatchBusy(false); }
  };
  const unmatch = async (transaction: Transaction) => {
    setError('');
    try { await api(`/api/bank-transactions/${transaction.id}/match`, { method: 'DELETE' }, onUnauthorized); await refresh(); }
    catch (e) { setError(e instanceof Error ? e.message : t('banks.reconciliationError')); }
  };
  const setReconciliation = async (transaction: Transaction, status: 'matched' | 'reconciled') => {
    setError('');
    try {
      await api(`/api/bank-transactions/${transaction.id}/reconciliation`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ status }) }, onUnauthorized);
      await refresh();
    } catch (e) { setError(e instanceof Error ? e.message : t('banks.reconciliationError')); }
  };

  // Export mirrors the filtered list on screen (all pages), never a refetch.
  const exportDoc = !loading && !error && filteredTransactions.length > 0 ? (() => {
    const ar = i18n.language.startsWith('ar');
    const filterRows: Array<[string, string]> = [];
    if (filters.reconciliation) filterRows.push([s.reconciliation, s.statuses[filters.reconciliation as ReconciliationStatus]]);
    if (filters.search.trim()) filterRows.push([s.searchTransactions, filters.search.trim()]);
    if (filters.from) filterRows.push([s.from, filters.from]);
    if (filters.to) filterRows.push([s.to, filters.to]);
    if (filters.amountMin) filterRows.push([s.amountMin, filters.amountMin]);
    if (filters.amountMax) filterRows.push([s.amountMax, filters.amountMax]);
    const stamp = generatedStamp();
    return bankReconciliationExport({ ar, company, generatedAt: stamp, asOf: stamp.slice(0, 10), statusLabels: s.statuses, filters: filterRows, from: filters.from || undefined, to: filters.to || undefined, rows: filteredTransactions });
  })() : null;

  if (!canView) return <Text role="status">{t('banks.noAccess')}</Text>;

  const statusLabel = (status: ReconciliationStatus) => s.statuses[status];
  const pageCount = Math.max(1, Math.ceil(filteredTransactions.length / PAGE_SIZE));
  const currentPage = Math.min(page, pageCount);
  const pagedTransactions = filteredTransactions.slice((currentPage - 1) * PAGE_SIZE, currentPage * PAGE_SIZE);
  const rowActions = (tx: Transaction) => <>
    {tx.reconciliation_status === 'unmatched' && canMatch && <Button size="xs" onClick={event => { event.stopPropagation(); void loadCandidates(tx); }}>{t('banks.match')}</Button>}
    {tx.reconciliation_status === 'matched' && canReconcile && <Button size="xs" onClick={event => { event.stopPropagation(); void setReconciliation(tx, 'reconciled'); }}>{t('banks.reconcile')}</Button>}
    {(tx.reconciliation_status === 'reconciled' || (tx.reconciliation_status === 'matched' && !canReconcile) || (tx.reconciliation_status === 'unmatched' && !canMatch)) && <Button size="xs" variant="light" onClick={event => { event.stopPropagation(); setSelectedId(tx.id); }}>{s.details}</Button>}
  </>;

  return <section className="bank-transactions-view bank-recon">
    {error && <Alert color="red" role="alert">{error}</Alert>}

    <div className="bank-recon__status" role="group" aria-label={s.title}>
      <div className="bank-recon__metrics bank-transactions-view__summary">
        <span className="bank-recon__metric is-unmatched"><i aria-hidden="true"/>{s.unmatchedMetric}: <b dir="ltr">{counts.unmatched}</b></span>
        <span className="bank-recon__metric is-pending"><i aria-hidden="true"/>{s.pendingMetric}: <b dir="ltr">{counts.matched}</b></span>
        <span className="bank-recon__metric is-matched"><i aria-hidden="true"/>{s.matchedMetric}: <b dir="ltr">{counts.reconciled}</b></span>
      </div>
      <Button variant="default" size="compact-sm" className="bank-recon__refresh" onClick={() => void refresh()} loading={loading}>{s.refresh}</Button>
    </div>
    <ExportButtons language={i18n.language} document={exportDoc} landscape />

    {!loading && <WorkspaceToolbar className="bank-recon__toolbar" ariaLabel={s.toolbar} search={<label><span className="bank-recon__sr">{s.searchTransactions}</span><input type="search" value={filters.search} placeholder={s.searchPlaceholder} onChange={event => updateFilter('search', event.target.value)}/></label>} filters={<><label>{s.reconciliation}<select value={filters.reconciliation} onChange={event => updateFilter('reconciliation', event.target.value)}><option value="">{s.allStatuses}</option>{reconciliationStatuses.map(status => <option key={status} value={status}>{statusLabel(status)}</option>)}</select></label><label>{s.from}<input type="date" value={filters.from} onChange={event => updateFilter('from', event.target.value)}/></label><label>{s.to}<input type="date" value={filters.to} onChange={event => updateFilter('to', event.target.value)}/></label><label>{s.amountMin}<input type="number" step="any" value={filters.amountMin} onChange={event => updateFilter('amountMin', event.target.value)}/></label><label>{s.amountMax}<input type="number" step="any" value={filters.amountMax} onChange={event => updateFilter('amountMax', event.target.value)}/></label></>} resultCount={s.resultCount(filteredTransactions.length)} clearAction={filtersActive ? <button type="button" onClick={clearFilters}>{s.clearFilters}</button> : undefined}/>}

    {loading && transactions.length === 0 && <Group justify="center" py="xl"><Loader size="sm"/></Group>}
    {!loading && transactions.length === 0 && <WorkspaceState kind="empty">{s.empty}</WorkspaceState>}
    {!loading && transactions.length > 0 && filteredTransactions.length === 0 && <WorkspaceState kind="no-results" action={filtersActive ? <button type="button" onClick={clearFilters}>{s.clearFilters}</button> : undefined}>{s.noResults}</WorkspaceState>}

    {filteredTransactions.length > 0 && <DataWorkspace withDetail={Boolean(selectedTransaction)} className="bank-transactions-workspace"><div className="bank-recon__card">
      <div className="bank-recon__card-head"><h3>{s.statementTitle}</h3><span className="bank-recon__pill">{s.transactionsCount(filteredTransactions.length)}</span></div>
      <div className="bank-transactions-list">
        <div className="bank-transaction-head" aria-hidden="true">
          <span>{s.date}</span><span>{s.descriptionLabel}</span><span>{s.amountSar}</span><span>{s.matchStatus}</span><span>{s.action}</span>
        </div>
        {pagedTransactions.map((tx) => {
          const selected = selectedId === tx.id;
          return <article className={`bank-transaction-row bank-transaction-row--${tx.reconciliation_status}`} key={tx.id} tabIndex={0} aria-selected={selected} onClick={() => setSelectedId(tx.id)} onKeyDown={event => { if (event.target === event.currentTarget && (event.key === 'Enter' || event.key === ' ')) { event.preventDefault(); setSelectedId(tx.id); } }}>
            <div className="bank-transaction-main">
              <time className="bank-transaction-date" dir="ltr">{displayDate(tx.transaction_date)}</time>
              <div className="bank-transaction-description">
                <p dir="auto">{tx.description || '—'}</p>
                {tx.bank_reference && <small className="bank-transaction-mobile-meta"><span dir="ltr">{tx.bank_reference}</span></small>}
              </div>
              <span className={`bank-transaction-amount ${Number(tx.amount) < 0 ? 'is-outbound' : 'is-inbound'}`} dir="ltr">{formatAmount(tx.amount, tx.currency_code)}</span>
              <span className={`bank-status bank-status--${tx.reconciliation_status} bank-transaction-status`}>{statusLabel(tx.reconciliation_status)}</span>
              <div className="bank-transaction-primary-action">{rowActions(tx)}</div>
            </div>
          </article>;
        })}
      </div>
      <nav className="bank-recon__pagination" aria-label={s.pagination}>
        <span>{s.showing(pagedTransactions.length, filteredTransactions.length)}</span>
        <div>
          <button type="button" disabled={currentPage <= 1} aria-label={s.prevPage} onClick={() => setPage(currentPage - 1)}>‹</button>
          {Array.from({ length: pageCount }, (_, index) => index + 1).map(number => <button key={number} type="button" className={number === currentPage ? 'is-active' : ''} aria-current={number === currentPage ? 'page' : undefined} onClick={() => setPage(number)}>{number}</button>)}
          <button type="button" disabled={currentPage >= pageCount} aria-label={s.nextPage} onClick={() => setPage(currentPage + 1)}>›</button>
        </div>
      </nav>
    </div>{selectedTransaction && <DetailPane label={s.details}>
      <div className="shared-detail-pane__header bank-transaction-detail__header">
        <div className="bank-recon__detail-title"><span className="bank-recon__detail-icon">{ico(<><rect x="3" y="3" width="18" height="18" rx="3"/><path d="m8 12.5 3 3 5-6"/></>)}</span><h3>{s.selectedDetails}</h3></div>
        <Button size="compact-sm" variant="subtle" onClick={() => setSelectedId(null)} aria-label={t('common.close')}>×</Button>
      </div>
      <div className="bank-recon__detail-grid">
        <div className="bank-recon__panel">
          <h4>{s.bankData}</h4>
          <dl>
            <dt>{s.date}</dt><dd dir="ltr">{displayDate(selectedTransaction.transaction_date)}</dd>
            <dt>{s.amount}</dt><dd dir="ltr">{formatMoney(selectedTransaction.amount, selectedTransaction.currency_code)}</dd>
            <dt>{s.descriptionLabel}</dt><dd dir="auto">{selectedTransaction.description || '—'}</dd>
            <dt>{s.reference}</dt><dd dir="ltr">{selectedTransaction.bank_reference || '—'}</dd>
            <dt>{s.balance}</dt><dd dir="ltr">{selectedTransaction.running_balance ?? '—'} {selectedTransaction.currency_code}</dd>
            <dt>{s.status}</dt><dd><span className={`bank-status bank-status--${selectedTransaction.reconciliation_status}`}>{statusLabel(selectedTransaction.reconciliation_status)}</span></dd>
          </dl>
        </div>
        <div className="bank-recon__panel">
          <h4>{s.actionsPanel}</h4>
          <div className="shared-detail-pane__actions">
            {selectedTransaction.reconciliation_status === 'matched' && <Button size="xs" variant="light" onClick={() => void loadCandidates(selectedTransaction)}>{t('banks.viewMatch')}</Button>}
            {selectedTransaction.reconciliation_status === 'matched' && canMatch && <Button size="xs" color="red" variant="subtle" onClick={() => void unmatch(selectedTransaction)}>{t('banks.unmatch')}</Button>}
            {selectedTransaction.reconciliation_status === 'reconciled' && canReconcile && <Button size="xs" variant="light" onClick={() => void setReconciliation(selectedTransaction, 'matched')}>{t('banks.reopen')}</Button>}
            {selectedTransaction.reconciliation_status === 'unmatched' && canMatch && <Button size="xs" onClick={() => void loadCandidates(selectedTransaction)}>{t('banks.match')}</Button>}
            {selectedTransaction.reconciliation_status === 'matched' && canReconcile && <Button size="xs" onClick={() => void setReconciliation(selectedTransaction, 'reconciled')}>{t('banks.reconcile')}</Button>}
          </div>
        </div>
      </div>
    </DetailPane>}</DataWorkspace>}

    {matchTransaction && <Dialog title={t('banks.matchDialog')} busy={matchBusy} onClose={closeMatch}><Stack gap="md">
      <div className="bank-match-summary">
        <Text fw={700} dir="auto">{matchTransaction.description || '—'}</Text>
        <Group gap="xs"><Badge variant="light"><span dir="ltr">{displayDate(matchTransaction.transaction_date)}</span></Badge><Badge variant="light"><span dir="ltr">{formatMoney(matchTransaction.amount, matchTransaction.currency_code)}</span></Badge></Group>
      </div>
      <Group align="end"><TextInput label={t('banks.searchDocuments')} value={candidateSearch} onChange={e => setCandidateSearch(e.currentTarget.value)}/><Button variant="light" loading={matchBusy} onClick={() => void loadCandidates(matchTransaction, candidateSearch)}>{t('banks.search')}</Button></Group>
      {candidateData?.match && <Alert>{t('banks.currentMatch')}: {candidateData.match.document_id}</Alert>}
      <div className="bank-match-candidates">
        {(candidateData?.documents ?? []).map(doc => {
          const selected = selectedDocument === doc.id;
          return <button type="button" key={doc.id} className={`bank-match-candidate ${selected ? 'is-selected' : ''}`} aria-pressed={selected} onClick={() => !candidateData?.match && setSelectedDocument(doc.id)} disabled={Boolean(candidateData?.match)}>
            <span className="bank-match-candidate__type"><small>{s.documentType}</small><strong>{doc.document_type ? t(`documents.intake.types.${doc.document_type}`) : '—'}</strong></span>
            <span className="bank-match-candidate__counterparty"><small>{s.counterparty}</small><strong dir="auto">{doc.counterparty_name || '—'}</strong></span>
            <span className="bank-match-candidate__total"><small>{s.total}</small><strong dir="ltr">{doc.total_amount || '—'}</strong></span>
            <span className="bank-match-candidate__reference" dir="auto">{doc.reference_number || doc.original_filename}</span>
            <span className="bank-match-candidate__obligation"><small>{s.obligation}</small>{doc.linked_obligation ? <><Badge size="sm" variant="light">{doc.linked_obligation.state}</Badge><small>{s.remaining}: <b dir="ltr">{doc.linked_obligation.remaining_amount}</b></small></> : <strong>{s.noObligation}</strong>}</span>
            <span className="bank-match-candidate__check" aria-hidden="true">✓</span>
          </button>;
        })}
      </div>
      <TextInput label={t('banks.matchNote')} value={matchNote} onChange={e => setMatchNote(e.currentTarget.value)} maxLength={500} disabled={Boolean(candidateData?.match)}/>
      <Group justify="flex-end"><Button variant="default" onClick={closeMatch} disabled={matchBusy}>{t('common.close')}</Button>{canMatch && !candidateData?.match && <Button onClick={() => void createMatch()} loading={matchBusy} disabled={!selectedDocument}>{t('banks.confirmMatch')}</Button>}</Group>
    </Stack></Dialog>}
  </section>;
}
