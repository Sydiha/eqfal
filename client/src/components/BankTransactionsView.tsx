import { useEffect, useMemo, useState } from 'react';
import { Alert, Badge, Button, Card, Group, Loader, Stack, Text, TextInput, Title } from '@mantine/core';
import { useTranslation } from 'react-i18next';
import { Dialog } from './Dialog';

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
type CandidateDocument = {
  id: string;
  status: 'needs_review' | 'approved';
  document_type: string | null;
  counterparty_name: string | null;
  document_date: string | null;
  reference_number: string | null;
  total_amount: string | null;
  original_filename: string;
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
  return match ? `${match[3]}/${match[2]}/${match[1]}` : raw || '—';
}

function formatMoney(amount: string, currency: string) {
  const numeric = Number(amount);
  if (!Number.isFinite(numeric)) return `${amount} ${currency}`;
  return `${new Intl.NumberFormat('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(numeric)} ${currency}`;
}

const local = {
  ar: {
    title: 'الحركات البنكية',
    description: 'راجع الحركة، حالتها، ومبلغها أولًا. التفاصيل البنكية والإجراءات الثانوية متاحة عند الحاجة.',
    date: 'التاريخ', descriptionLabel: 'البيان', amount: 'المبلغ', status: 'الحالة', action: 'الإجراء',
    reference: 'المرجع البنكي', balance: 'الرصيد الجاري', details: 'التفاصيل', hideDetails: 'إخفاء التفاصيل',
    refresh: 'تحديث', empty: 'لا توجد حركات بنكية', error: 'تعذر تحميل الحركات البنكية',
  },
  en: {
    title: 'Bank transactions',
    description: 'Review the transaction, status, and amount first. Bank metadata and secondary actions remain available on demand.',
    date: 'Date', descriptionLabel: 'Description', amount: 'Amount', status: 'Status', action: 'Action',
    reference: 'Bank reference', balance: 'Running balance', details: 'Details', hideDetails: 'Hide details',
    refresh: 'Refresh', empty: 'No bank transactions', error: 'Unable to load bank transactions',
  },
};

export function BankTransactionsView({ canView, canMatch, canReconcile, onUnauthorized }: Props) {
  const { t, i18n } = useTranslation();
  const s = i18n.language === 'ar' ? local.ar : local.en;
  const [transactions, setTransactions] = useState<Transaction[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [matchTransaction, setMatchTransaction] = useState<Transaction | null>(null);
  const [candidateData, setCandidateData] = useState<CandidateResponse | null>(null);
  const [candidateSearch, setCandidateSearch] = useState('');
  const [selectedDocument, setSelectedDocument] = useState<string | null>(null);
  const [matchNote, setMatchNote] = useState('');
  const [matchBusy, setMatchBusy] = useState(false);

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

  if (!canView) return <Text role="status">{t('banks.noAccess')}</Text>;

  return <Card withBorder padding="xl" className="bank-transactions-view">
    <Stack gap="lg">
      <Group justify="space-between" align="flex-start" wrap="wrap">
        <div>
          <Title order={2} size="h3">{s.title}</Title>
          <Text c="dimmed" maw={760}>{s.description}</Text>
        </div>
        <Button variant="light" onClick={() => void refresh()} loading={loading}>{s.refresh}</Button>
      </Group>

      <Group gap="xs" className="bank-transactions-view__summary">
        <Badge variant="light" color="gray">{t('banks.reconciliation.unmatched')}: {counts.unmatched}</Badge>
        <Badge variant="light" color="blue">{t('banks.reconciliation.matched')}: {counts.matched}</Badge>
        <Badge variant="light" color="green">{t('banks.reconciliation.reconciled')}: {counts.reconciled}</Badge>
      </Group>

      {error && <Alert color="red" role="alert">{error}</Alert>}
      {loading && transactions.length === 0 && <Group justify="center" py="xl"><Loader size="sm"/></Group>}
      {!loading && transactions.length === 0 && <Text c="dimmed">{s.empty}</Text>}

      {transactions.length > 0 && <div className="bank-transactions-list">
        <div className="bank-transaction-head" aria-hidden="true">
          <span>{s.date}</span><span>{s.descriptionLabel}</span><span>{s.amount}</span><span>{s.status}</span><span>{s.action}</span>
        </div>
        {transactions.map((tx) => {
          const expanded = expandedId === tx.id;
          return <article className={`bank-transaction-row bank-transaction-row--${tx.reconciliation_status}`} key={tx.id}>
            <div className="bank-transaction-main">
              <time className="bank-transaction-date" dir="ltr">{displayDate(tx.transaction_date)}</time>
              <div className="bank-transaction-description">
                <Text fw={650} lineClamp={2}><span dir="auto">{tx.description || '—'}</span></Text>
                {tx.bank_reference && <Text size="xs" c="dimmed" className="bank-transaction-mobile-meta"><span dir="ltr">{tx.bank_reference}</span></Text>}
              </div>
              <Text className={`bank-transaction-amount ${Number(tx.amount) < 0 ? 'is-outbound' : 'is-inbound'}`} fw={750} dir="ltr">{formatMoney(tx.amount, tx.currency_code)}</Text>
              <Badge className="bank-transaction-status" variant="light" color={tx.reconciliation_status === 'reconciled' ? 'green' : tx.reconciliation_status === 'matched' ? 'blue' : 'gray'}>{t(`banks.reconciliation.${tx.reconciliation_status}`)}</Badge>
              <div className="bank-transaction-primary-action">
                {tx.reconciliation_status === 'unmatched' && canMatch && <Button size="xs" onClick={() => void loadCandidates(tx)}>{t('banks.match')}</Button>}
                {tx.reconciliation_status === 'matched' && canReconcile && <Button size="xs" onClick={() => void setReconciliation(tx, 'reconciled')}>{t('banks.reconcile')}</Button>}
                {(tx.reconciliation_status === 'reconciled' || (tx.reconciliation_status === 'matched' && !canReconcile) || (tx.reconciliation_status === 'unmatched' && !canMatch)) && <Button size="xs" variant="light" onClick={() => setExpandedId(expanded ? null : tx.id)}>{expanded ? s.hideDetails : s.details}</Button>}
              </div>
            </div>

            <button type="button" className="bank-transaction-details-toggle" onClick={() => setExpandedId(expanded ? null : tx.id)} aria-expanded={expanded}>{expanded ? s.hideDetails : s.details}</button>
            {expanded && <div className="bank-transaction-details">
              <dl>
                <div><dt>{s.reference}</dt><dd dir="ltr">{tx.bank_reference || '—'}</dd></div>
                <div><dt>{s.balance}</dt><dd dir="ltr">{tx.running_balance ?? '—'} {tx.currency_code}</dd></div>
              </dl>
              <Group gap="xs" justify="flex-end">
                {tx.reconciliation_status === 'matched' && <Button size="xs" variant="light" onClick={() => void loadCandidates(tx)}>{t('banks.viewMatch')}</Button>}
                {tx.reconciliation_status === 'matched' && canMatch && <Button size="xs" color="red" variant="subtle" onClick={() => void unmatch(tx)}>{t('banks.unmatch')}</Button>}
                {tx.reconciliation_status === 'reconciled' && canReconcile && <Button size="xs" variant="light" onClick={() => void setReconciliation(tx, 'matched')}>{t('banks.reopen')}</Button>}
              </Group>
            </div>}
          </article>;
        })}
      </div>}
    </Stack>

    {matchTransaction && <Dialog title={t('banks.matchDialog')} busy={matchBusy} onClose={closeMatch}><Stack gap="md">
      <div className="bank-match-summary">
        <Text fw={700} dir="auto">{matchTransaction.description || '—'}</Text>
        <Group gap="xs"><Badge variant="light"><span dir="ltr">{displayDate(matchTransaction.transaction_date)}</span></Badge><Badge variant="light"><span dir="ltr">{formatMoney(matchTransaction.amount, matchTransaction.currency_code)}</span></Badge></Group>
      </div>
      <Group align="end"><TextInput label={t('banks.searchDocuments')} value={candidateSearch} onChange={e => setCandidateSearch(e.currentTarget.value)}/><Button variant="light" loading={matchBusy} onClick={() => void loadCandidates(matchTransaction, candidateSearch)}>{t('banks.search')}</Button></Group>
      {candidateData?.match && <Alert>{t('banks.currentMatch')}: {candidateData.match.document_id}</Alert>}
      <div className="bank-match-candidates">
        {(candidateData?.documents ?? []).map(doc => <button type="button" key={doc.id} className={`bank-match-candidate ${selectedDocument === doc.id ? 'is-selected' : ''}`} onClick={() => !candidateData?.match && setSelectedDocument(doc.id)} disabled={Boolean(candidateData?.match)}>
          <strong dir="auto">{doc.original_filename}</strong>
          <span dir="auto">{doc.counterparty_name || '—'}</span>
          <span dir="ltr">{doc.total_amount || '—'}</span>
          <Badge size="sm" variant="light">{t(`documents.statuses.${doc.status}`)}</Badge>
        </button>)}
      </div>
      <TextInput label={t('banks.matchNote')} value={matchNote} onChange={e => setMatchNote(e.currentTarget.value)} maxLength={500} disabled={Boolean(candidateData?.match)}/>
      <Group justify="flex-end"><Button variant="default" onClick={closeMatch} disabled={matchBusy}>{t('common.close')}</Button>{canMatch && !candidateData?.match && <Button onClick={() => void createMatch()} loading={matchBusy} disabled={!selectedDocument}>{t('banks.confirmMatch')}</Button>}</Group>
    </Stack></Dialog>}
  </Card>;
}
