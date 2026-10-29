import { FormEvent, useCallback, useEffect, useMemo, useState } from 'react';
import { DateTextInput } from './DateInput';
import { Alert, Badge, Button, Card, Group, Modal, NativeSelect, Stack, Table, Text, TextInput, Title } from '@mantine/core';
import { useTranslation } from 'react-i18next';
import { readQueryParameter } from '../navigation/queryState';
import { formatMoney } from '../money-format';
import { formatDisplayDateLtr } from '../date-format';
import './BankStatementReconciliation.css';

type Mode = 'off' | 'warn' | 'enforce';
type Settings = { mode: Mode; enforce_from: string | null; version: number };
type Account = { id: string; display_name: string; currency_code: string; is_active: boolean };
type LedgerAccount = { id: string; code: string; name: string; account_type: string; cash_role?: string };
type Link = { id: string; bank_account_id: string; account_id: string; valid_from: string; valid_to: string | null };
type Statement = {
  id: string; bank_account_id: string; statement_ref: string; period_start: string; period_end: string; opening_balance: string | null; closing_balance: string;
  status: 'draft' | 'confirmed' | 'superseded'; version: number; replacement_reason: string | null; currency_code: string;
};
type Item = { journal_entry_id: string; accounting_date: string; bank_transaction_id: string; bank_transaction_date: string; kind: 'deposit_in_transit' | 'outstanding_payment'; amount: string; days_after_period_end: number; aged: boolean };
type Result = {
  ledger_account_id: string | null; statement_ref: string | null; statement_closing_balance: string | null; gl_balance: string | null; deposits_in_transit: string; outstanding_payments: string;
  adjusted_bank_balance: string | null; adjusted_gl_balance: string | null; difference: string | null; outstanding_items: Item[]; rejected_evidence: unknown[];
  bank_only_count: number; problems: string[]; warnings: string[]; reconciled: boolean;
};
type Evaluation = { mode: Mode; effective_mode: Mode; accounts: Result[] };

type Props = {
  canView: boolean; canManageStatements: boolean; canConfirmStatements: boolean; canManageSettings: boolean; canManageLinks: boolean; onUnauthorized: () => void;
};

const copy = {
  en: {
    title: 'Statement balance reconciliation', mode: 'Closing check', modes: { off: 'Off', warn: 'Warn only', enforce: 'Enforced' } as Record<Mode, string>,
    effective: 'Effective from', save: 'Save', account: 'Bank account', periodEnd: 'Statement date', load: 'Calculate',
    draft: 'Draft', confirmed: 'Confirmed', superseded: 'Superseded', warning: 'Warning', blocker: 'Blocker', ok: 'Reconciled', noPermission: 'You can view this page but not change it.',
    statements: 'Statement balances', ref: 'Statement reference', period: 'Period', from: 'Period start', to: 'Period end', opening: 'Opening balance', closing: 'Closing balance', note: 'Note',
    add: 'Save draft', confirm: 'Confirm', replace: 'Replace', remove: 'Delete draft', reason: 'Reason for replacement', status: 'Status', actions: 'Actions',
    links: 'Ledger account link', ledger: 'Ledger cash/bank account', validFrom: 'Valid from', link: 'Link', endLink: 'End link', validTo: 'Valid to', unlinked: 'No ledger account is linked for this date.',
    calc: 'Reconciliation', stmt: 'Statement closing balance', dit: 'Deposits in transit', op: 'Outstanding payments', adjBank: 'Adjusted bank balance', gl: 'Ledger balance (all posted lines)',
    diff: 'Unexplained difference', items: 'Evidence-backed outstanding items', kind: 'Type', amount: 'Amount', glDate: 'Ledger date', bankDate: 'Bank date', aged: 'Older than 10 days',
    deposit_in_transit: 'Deposit in transit', outstanding_payment: 'Outstanding payment', none: 'None', rejected: 'Evidence rejected (amount or direction differs from the bank row)',
    bankOnly: 'Bank rows without an accounting entry yet', goLink: 'Link the ledger account', goStatement: 'Enter the statement balance', unknownDiff: 'Cannot be calculated yet', reconciledHint: 'Adjusted bank balance equals the ledger balance.', problemHint: 'Explain or correct the difference before closing.', unknownHint: 'Resolve the items below to calculate the difference.', settingsTitle: 'Closing check settings', zero: 'Tolerance is exactly zero. No manual adjustments are possible.',
    problemLabels: { unmapped: 'Bank account is not linked to a ledger account', statement_missing: 'No confirmed statement balance for this date', currency_mismatch: 'Bank currency differs from the company currency',
      currency_unverified: 'No approved accounting profile gives the company currency', difference_unexplained: 'Difference is not explained by evidenced items' } as Record<string, string>,
    warningLabels: { outstanding_aged: 'An outstanding item is older than 10 days', bank_only_items: 'Bank rows exist without an accounting entry' } as Record<string, string>,
    confirmAsk: 'Confirm this statement balance? Confirmed values cannot be edited.', loadError: 'Could not load data', empty: 'No statement balances yet.',
    confirmTitle: 'Please confirm', cancel: 'Cancel', deleteAsk: 'Delete this draft statement balance?', endLinkAsk: 'End this ledger account link on the statement date?',
    required: 'This field is required', badAmount: 'Enter a valid amount with at most two decimals', badDate: 'Enter a valid date', endBeforeStart: 'Period end cannot be before period start',
    genericError: 'The request could not be completed. Please try again.',
    errors: {
      BANK_STATEMENT_INVALID: 'The statement details are invalid. Check the fields and try again.', BANK_STATEMENT_NOT_FOUND: 'The statement balance was not found.',
      BANK_STATEMENT_STALE: 'This statement balance was changed by someone else. Reload and try again.', BANK_STATEMENT_NOT_DRAFT: 'Only a draft statement balance can be changed or deleted.',
      BANK_STATEMENT_NOT_CONFIRMED: 'Only a confirmed statement balance can be replaced.', BANK_STATEMENT_ALREADY_SUPERSEDED: 'This statement balance has already been replaced.',
      BANK_STATEMENT_REASON_REQUIRED: 'A reason for the replacement is required.', BANK_STATEMENT_DUPLICATE_DRAFT: 'A draft already exists for this bank account and period end.',
      BANK_STATEMENT_DUPLICATE_PERIOD: 'A confirmed statement balance already exists for this bank account and period end.', BANK_STATEMENT_DUPLICATE_REF: 'This statement reference is already used for this bank account.',
      BANK_STATEMENT_BATCH_INVALID: 'The selected import batch does not belong to this bank account.', BANK_STATEMENT_ACCOUNT_IMMUTABLE: 'The bank account of a statement balance cannot be changed.',
      BANK_ACCOUNT_NOT_FOUND: 'The bank account was not found.', BANK_ACCOUNT_INACTIVE: 'The bank account is inactive.',
      BANK_LINK_ACCOUNT_NOT_FOUND: 'The ledger account was not found.', BANK_LINK_NOT_FOUND: 'The ledger link was not found.', BANK_LINK_ALREADY_ENDED: 'This ledger link has already ended.',
      BANK_LINK_OVERLAP: 'This link overlaps another link for the same bank account or ledger account.', BANK_LINK_INVALID_DATE: 'The link dates are invalid.',
      BANK_LINK_CURRENCY_MISMATCH: 'The ledger account currency differs from the bank account currency.', BANK_LINK_CURRENCY_UNVERIFIED: 'The company currency could not be verified from an approved accounting profile.',
      BANK_RECON_ENFORCE_DATE_REQUIRED: 'An effective date is required to enforce the closing check.', BANK_RECON_INVALID_SETTINGS: 'The closing check settings are invalid.',
      BANK_RECON_SETTINGS_STALE: 'The settings were changed by someone else. Reload and try again.', BANK_RECONCILIATION_CONSTRAINT: 'The change conflicts with existing reconciliation data.',
      ACCOUNTING_PERIOD_CLOSED: 'The accounting period is closed.', FORBIDDEN: 'You do not have permission for this action.',
    } as Record<string, string>,
  },
  ar: {
    title: 'مطابقة رصيد الكشف', mode: 'فحص الإقفال', modes: { off: 'متوقف', warn: 'تحذير فقط', enforce: 'إلزامي' } as Record<Mode, string>,
    effective: 'يسري من', save: 'حفظ', account: 'الحساب البنكي', periodEnd: 'تاريخ الكشف', load: 'احتساب',
    draft: 'مسودة', confirmed: 'معتمد', superseded: 'مستبدل', warning: 'تحذير', blocker: 'مانع إقفال', ok: 'مطابق', noPermission: 'يمكنك عرض هذه الصفحة دون تعديلها.',
    statements: 'أرصدة الكشوف', ref: 'مرجع الكشف', period: 'الفترة', from: 'بداية الفترة', to: 'نهاية الفترة', opening: 'الرصيد الافتتاحي', closing: 'الرصيد الختامي', note: 'ملاحظة',
    add: 'حفظ كمسودة', confirm: 'اعتماد', replace: 'استبدال', remove: 'حذف المسودة', reason: 'سبب الاستبدال', status: 'الحالة', actions: 'الإجراءات',
    links: 'ربط حساب الدفتر', ledger: 'حساب النقد/البنك في الدفتر', validFrom: 'يسري من', link: 'ربط', endLink: 'إنهاء الربط', validTo: 'ينتهي في', unlinked: 'لا يوجد حساب دفتر مربوط لهذا التاريخ.',
    calc: 'المطابقة', stmt: 'الرصيد الختامي للكشف', dit: 'إيداعات في الطريق', op: 'مدفوعات معلقة', adjBank: 'رصيد البنك المعدّل', gl: 'رصيد الدفتر (كل القيود المرحّلة)',
    diff: 'الفرق غير المفسَّر', items: 'بنود معلقة مثبتة بدليل', kind: 'النوع', amount: 'المبلغ', glDate: 'تاريخ القيد', bankDate: 'تاريخ البنك', aged: 'أقدم من 10 أيام',
    deposit_in_transit: 'إيداع في الطريق', outstanding_payment: 'دفعة معلقة', none: 'لا يوجد', rejected: 'أدلة مرفوضة (المبلغ أو الاتجاه يخالف حركة البنك)',
    bankOnly: 'حركات بنكية بلا قيد محاسبي بعد', goLink: 'اربط حساب الدفتر', goStatement: 'أدخل رصيد الكشف', unknownDiff: 'لا يمكن احتسابه بعد', reconciledHint: 'رصيد البنك المعدّل يساوي رصيد الدفتر.', problemHint: 'فسّر الفرق أو صحّحه قبل الإقفال.', unknownHint: 'عالج البنود أدناه ليُحتسب الفرق.', settingsTitle: 'إعدادات فحص الإقفال', zero: 'حد التسامح صفر تماماً. لا توجد تسويات يدوية.',
    problemLabels: { unmapped: 'الحساب البنكي غير مربوط بحساب في الدفتر', statement_missing: 'لا يوجد رصيد كشف معتمد لهذا التاريخ', currency_mismatch: 'عملة البنك تخالف عملة الشركة',
      currency_unverified: 'لا يوجد ملف محاسبي معتمد يحدد عملة الشركة', difference_unexplained: 'الفرق غير مفسَّر ببنود مثبتة' } as Record<string, string>,
    warningLabels: { outstanding_aged: 'بند معلق أقدم من 10 أيام', bank_only_items: 'توجد حركات بنكية بلا قيد محاسبي' } as Record<string, string>,
    confirmAsk: 'اعتماد رصيد الكشف؟ لا يمكن تعديل القيم بعد الاعتماد.', loadError: 'تعذر تحميل البيانات', empty: 'لا توجد أرصدة كشوف بعد.',
    confirmTitle: 'يرجى التأكيد', cancel: 'إلغاء', deleteAsk: 'حذف مسودة رصيد الكشف هذه؟', endLinkAsk: 'إنهاء ربط حساب الدفتر هذا في تاريخ الكشف؟',
    required: 'هذا الحقل مطلوب', badAmount: 'أدخل مبلغاً صحيحاً بحد أقصى منزلتين عشريتين', badDate: 'أدخل تاريخاً صحيحاً', endBeforeStart: 'نهاية الفترة لا يمكن أن تسبق بدايتها',
    genericError: 'تعذر إكمال الطلب. حاول مرة أخرى.',
    errors: {
      BANK_STATEMENT_INVALID: 'بيانات الكشف غير صحيحة. راجع الحقول وحاول مرة أخرى.', BANK_STATEMENT_NOT_FOUND: 'رصيد الكشف غير موجود.',
      BANK_STATEMENT_STALE: 'تم تعديل رصيد الكشف هذا من مستخدم آخر. أعد التحميل وحاول مرة أخرى.', BANK_STATEMENT_NOT_DRAFT: 'يمكن تعديل المسودة أو حذفها فقط.',
      BANK_STATEMENT_NOT_CONFIRMED: 'يمكن استبدال رصيد الكشف المعتمد فقط.', BANK_STATEMENT_ALREADY_SUPERSEDED: 'تم استبدال رصيد الكشف هذا مسبقاً.',
      BANK_STATEMENT_REASON_REQUIRED: 'سبب الاستبدال مطلوب.', BANK_STATEMENT_DUPLICATE_DRAFT: 'توجد مسودة لهذا الحساب البنكي ولنهاية الفترة نفسها.',
      BANK_STATEMENT_DUPLICATE_PERIOD: 'يوجد رصيد كشف معتمد لهذا الحساب البنكي ولنهاية الفترة نفسها.', BANK_STATEMENT_DUPLICATE_REF: 'مرجع الكشف مستخدم مسبقاً لهذا الحساب البنكي.',
      BANK_STATEMENT_BATCH_INVALID: 'دفعة الاستيراد المختارة لا تخص هذا الحساب البنكي.', BANK_STATEMENT_ACCOUNT_IMMUTABLE: 'لا يمكن تغيير الحساب البنكي لرصيد الكشف.',
      BANK_ACCOUNT_NOT_FOUND: 'الحساب البنكي غير موجود.', BANK_ACCOUNT_INACTIVE: 'الحساب البنكي غير نشط.',
      BANK_LINK_ACCOUNT_NOT_FOUND: 'حساب الدفتر غير موجود.', BANK_LINK_NOT_FOUND: 'ربط الدفتر غير موجود.', BANK_LINK_ALREADY_ENDED: 'انتهى هذا الربط مسبقاً.',
      BANK_LINK_OVERLAP: 'هذا الربط يتداخل مع ربط آخر لنفس الحساب البنكي أو حساب الدفتر.', BANK_LINK_INVALID_DATE: 'تواريخ الربط غير صحيحة.',
      BANK_LINK_CURRENCY_MISMATCH: 'عملة حساب الدفتر تخالف عملة الحساب البنكي.', BANK_LINK_CURRENCY_UNVERIFIED: 'تعذر التحقق من عملة الشركة من ملف محاسبي معتمد.',
      BANK_RECON_ENFORCE_DATE_REQUIRED: 'تاريخ السريان مطلوب لتفعيل فحص الإقفال الإلزامي.', BANK_RECON_INVALID_SETTINGS: 'إعدادات فحص الإقفال غير صحيحة.',
      BANK_RECON_SETTINGS_STALE: 'تم تعديل الإعدادات من مستخدم آخر. أعد التحميل وحاول مرة أخرى.', BANK_RECONCILIATION_CONSTRAINT: 'التغيير يتعارض مع بيانات المطابقة الحالية.',
      ACCOUNTING_PERIOD_CLOSED: 'الفترة المحاسبية مقفلة.', FORBIDDEN: 'ليس لديك صلاحية لهذا الإجراء.',
    } as Record<string, string>,
  },
};

async function api<T>(url: string, init?: RequestInit, onUnauthorized?: () => void): Promise<T> {
  const response = await fetch(url, init);
  if (response.status === 401) { onUnauthorized?.(); throw new Error('unauthorized'); }
  if (response.status === 204) return undefined as T;
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new ApiFailure(typeof body.code === 'string' ? body.code : response.status === 403 ? 'FORBIDDEN' : '');
  return body as T;
}
/** Carries only the server's stable error code; user-facing text is always localized here, never the raw backend message. */
class ApiFailure extends Error { constructor(readonly code: string) { super(code || 'request_failed'); } }
const AMOUNT = /^-?(?:0|[1-9]\d{0,15})(?:\.\d{1,2})?$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
type Pending = { kind: 'confirm'; st: Statement } | { kind: 'delete'; st: Statement } | { kind: 'endLink'; link: Link };
const json = (method: string, body: unknown): RequestInit => ({ method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
const monthEnd = () => { const d = new Date(); return new Date(Date.UTC(d.getFullYear(), d.getMonth(), 0)).toISOString().slice(0, 10); };

export function BankStatementReconciliation({ canView, canManageStatements, canConfirmStatements, canManageSettings, canManageLinks, onUnauthorized }: Props) {
  const { i18n } = useTranslation();
  const ar = i18n.language.startsWith('ar');
  const s = ar ? copy.ar : copy.en;
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [ledger, setLedger] = useState<LedgerAccount[]>([]);
  const [links, setLinks] = useState<Link[]>([]);
  const [statements, setStatements] = useState<Statement[]>([]);
  const [settings, setSettings] = useState<Settings>({ mode: 'off', enforce_from: null, version: 0 });
  const [bankId, setBankId] = useState('');
  const [periodEnd, setPeriodEnd] = useState(() => readQueryParameter('reconDate', { pattern: DATE }) ?? monthEnd());
  const [evaluation, setEvaluation] = useState<Evaluation | null>(null);
  const [mode, setMode] = useState<Mode>('off');
  const [enforceFrom, setEnforceFrom] = useState('');
  const [error, setError] = useState('');
  const [reason, setReason] = useState('');
  const [replacing, setReplacing] = useState<Statement | null>(null);
  const [ledgerId, setLedgerId] = useState('');
  const [validFrom, setValidFrom] = useState('');
  const [pending, setPending] = useState<Pending | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});

  const guard = useCallback(async <T,>(fn: () => Promise<T>): Promise<T | undefined> => {
    try { setError(''); return await fn(); } catch (e) {
      const message = (e as Error).message;
      if (message !== 'unauthorized') setError(e instanceof ApiFailure ? (s.errors[e.code] ?? s.genericError) : s.loadError);
      return undefined;
    }
  }, [s.errors, s.genericError, s.loadError]);

  const load = useCallback(async () => {
    if (!canView) return;
    await guard(async () => {
      const [a, st, lk, cfg] = await Promise.all([
        api<{ accounts: Account[] }>('/api/bank-accounts', undefined, onUnauthorized),
        api<Statement[]>('/api/bank-statements', undefined, onUnauthorized),
        api<Link[]>('/api/bank-ledger-links', undefined, onUnauthorized),
        api<Settings>('/api/bank-reconciliation/settings', undefined, onUnauthorized),
      ]);
      setAccounts(a.accounts); setStatements(st); setLinks(lk); setSettings(cfg); setMode(cfg.mode); setEnforceFrom(cfg.enforce_from ?? '');
      setBankId(current => current || a.accounts[0]?.id || '');
      if (canManageLinks) {
        const chart = await api<{ accounts: LedgerAccount[] }>('/api/accounts', undefined, onUnauthorized).catch(() => ({ accounts: [] as LedgerAccount[] }));
        setLedger(chart.accounts.filter(x => x.account_type === 'asset' && (x.cash_role === 'cash' || x.cash_role === 'cash_equivalent')));
      }
    });
  }, [canView, canManageLinks, guard, onUnauthorized]);
  useEffect(() => { void load(); }, [load]);

  const calculate = useCallback(async () => {
    if (!canView || !bankId || !DATE.test(periodEnd)) { setEvaluation(null); return; }
    const result = await guard(() => api<Evaluation>(`/api/bank-reconciliation/preview?bank_account_id=${bankId}&period_end=${periodEnd}`, undefined, onUnauthorized));
    if (result) setEvaluation(result);
  }, [canView, bankId, periodEnd, guard, onUnauthorized]);
  useEffect(() => { void calculate(); }, [calculate]);

  const result = evaluation?.accounts[0] ?? null;
  const problemKind = settings.mode === 'enforce' && settings.enforce_from !== null && periodEnd >= settings.enforce_from ? s.blocker : s.warning;
  const bankStatements = useMemo(() => statements.filter(x => x.bank_account_id === bankId), [statements, bankId]);
  const activeLink = links.find(x => x.bank_account_id === bankId && x.valid_from <= periodEnd && (x.valid_to === null || x.valid_to >= periodEnd));
  const ledgerName = (id: string | null | undefined) => { const a = ledger.find(x => x.id === id); return a ? `${a.code} ${a.name}` : id ?? ''; };
  const statusBadge = (status: Statement['status']) => <Badge color={status === 'confirmed' ? 'green' : status === 'draft' ? 'gray' : 'dark'} variant={status === 'superseded' ? 'outline' : 'light'}>{s[status]}</Badge>;

  const saveSettings = (e: FormEvent) => { e.preventDefault(); if (mode === 'enforce' && !DATE.test(enforceFrom)) { setFieldErrors({ enforceFrom: enforceFrom ? s.badDate : s.required }); return; } setFieldErrors({}); void guard(async () => { await api('/api/bank-reconciliation/settings', json('PUT', { mode, enforce_from: mode === 'enforce' ? enforceFrom || null : null, version: settings.version }), onUnauthorized); await load(); }); };
  const addLink = (e: FormEvent) => {
    e.preventDefault();
    const errors: Record<string, string> = {};
    if (!ledgerId) errors['ledgerId'] = s.required;
    if (!validFrom) errors['validFrom'] = s.required; else if (!DATE.test(validFrom)) errors['validFrom'] = s.badDate;
    setFieldErrors(errors); if (Object.keys(errors).length) return;
    void guard(async () => { await api('/api/bank-ledger-links', json('POST', { bank_account_id: bankId, account_id: ledgerId, valid_from: validFrom }), onUnauthorized); await load(); await calculate(); }); };
  const endLink = (link: Link) => void guard(async () => { await api(`/api/bank-ledger-links/${link.id}/end`, json('POST', { valid_to: periodEnd }), onUnauthorized); await load(); await calculate(); });
  const addStatement = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault(); const form = e.currentTarget; const data = new FormData(form); const field = (k: string) => String(data.get(k) ?? '').trim();
    const body = { bank_account_id: bankId, statement_ref: field('ref'), period_start: field('from'), period_end: field('to'), opening_balance: field('opening') || null, closing_balance: field('closing'), note: field('note') || null };
    const errors: Record<string, string> = {};
    if (!body.statement_ref) errors['ref'] = s.required;
    if (!body.period_start) errors['from'] = s.required; else if (!DATE.test(body.period_start)) errors['from'] = s.badDate;
    if (!body.period_end) errors['to'] = s.required; else if (!DATE.test(body.period_end)) errors['to'] = s.badDate; else if (body.period_start && body.period_end < body.period_start) errors['to'] = s.endBeforeStart;
    if (!body.closing_balance) errors['closing'] = s.required; else if (!AMOUNT.test(body.closing_balance)) errors['closing'] = s.badAmount;
    if (body.opening_balance && !AMOUNT.test(body.opening_balance)) errors['opening'] = s.badAmount;
    if (replacing && !reason.trim()) errors['reason'] = s.required;
    setFieldErrors(errors); if (Object.keys(errors).length) return;
    void guard(async () => {
      if (replacing) await api(`/api/bank-statements/${replacing.id}/supersede`, json('POST', { ...body, version: replacing.version, reason }), onUnauthorized);
      else await api('/api/bank-statements', json('POST', body), onUnauthorized);
      form.reset(); setReplacing(null); setReason(''); setFieldErrors({}); await load(); await calculate();
    });
  };
  const confirmStatement = (st: Statement) => void guard(async () => { await api(`/api/bank-statements/${st.id}/confirm`, json('POST', { version: st.version }), onUnauthorized); await load(); await calculate(); });
  const removeDraft = (st: Statement) => void guard(async () => { await api(`/api/bank-statements/${st.id}?version=${st.version}`, { method: 'DELETE' }, onUnauthorized); await load(); await calculate(); });
  const runPending = () => { const p = pending; setPending(null); if (!p) return; if (p.kind === 'confirm') confirmStatement(p.st); else if (p.kind === 'delete') removeDraft(p.st); else endLink(p.link); };
  const pendingText = pending?.kind === 'confirm' ? s.confirmAsk : pending?.kind === 'delete' ? s.deleteAsk : pending?.kind === 'endLink' ? s.endLinkAsk : '';

  if (!canView) return null;
  return <Stack gap="md" className="bank-statement-reconciliation" dir={ar ? 'rtl' : 'ltr'}>
    <Modal opened={pending !== null} onClose={() => setPending(null)} title={s.confirmTitle} centered dir={ar ? 'rtl' : 'ltr'}>
      <Stack gap="md"><Text>{pendingText}</Text><Group justify="flex-end"><Button variant="default" onClick={() => setPending(null)}>{s.cancel}</Button><Button color={pending?.kind === 'delete' ? 'red' : undefined} onClick={runPending}>{pending?.kind === 'delete' ? s.remove : pending?.kind === 'endLink' ? s.endLink : s.confirm}</Button></Group></Stack>
    </Modal>
    {error && <Alert color="red" role="alert">{error}</Alert>}
    {!canManageStatements && !canConfirmStatements && !canManageSettings && <Text size="sm" c="dimmed">{s.noPermission}</Text>}

    <Card withBorder><Group align="end" wrap="wrap" justify="space-between">
      <Group align="end" wrap="wrap">
        <NativeSelect label={s.account} value={bankId} onChange={e => setBankId(e.currentTarget.value)} data={accounts.map(a => ({ value: a.id, label: `${a.display_name} (${a.currency_code})` }))}/>
        <DateTextInput label={s.periodEnd} value={periodEnd} onChange={setPeriodEnd}/>
        <Button variant="default" onClick={() => void calculate()}>{s.load}</Button>
      </Group>
      <Group gap="xs"><Text size="sm" c="dimmed">{s.mode}:</Text><Badge color={settings.mode === 'enforce' ? 'red' : settings.mode === 'warn' ? 'yellow' : 'gray'}>{s.modes[settings.mode]}</Badge>{settings.enforce_from && <Text size="sm" c="dimmed">{s.effective}: <span dir="ltr">{formatDisplayDateLtr(settings.enforce_from, i18n.language)}</span></Text>}</Group>
    </Group></Card>

    {result && (() => {
      const known = result.difference !== null;
      const problem = known && !result.reconciled;
      const tone = !known ? 'is-unknown' : problem ? 'is-problem' : 'is-ok';
      const severity = problemKind === s.blocker ? 'red' : 'yellow';
      const goTo = (id: string) => { const el = document.getElementById(id); el?.scrollIntoView({ behavior: 'smooth', block: 'start' }); el?.focus({ preventScroll: true }); };
      return <Card withBorder><Stack gap="md">
      <div className="bsr-result__status"><Title order={3} size="h4">{s.calc}</Title>
        {result.reconciled ? <Badge color="green">{s.ok}</Badge> : <Badge color={severity}>{problemKind}</Badge>}</div>
      <div className="bsr-result">
        <dl className="fin-headline"><dt className="fin-headline__label">{s.diff}</dt><dd className={`fin-headline__value ${tone}`}>{known ? formatMoney(result.difference) : s.unknownDiff}</dd>
          <dd className="fin-headline__hint">{!known ? s.unknownHint : problem ? s.problemHint : s.reconciledHint}</dd></dl>
        <dl className="fin-summary">
          <div><dt>{s.stmt}</dt><dd>{formatMoney(result.statement_closing_balance)}</dd></div>
          <div><dt>+ {s.dit}</dt><dd>{formatMoney(result.deposits_in_transit)}</dd></div>
          <div><dt>− {s.op}</dt><dd>{formatMoney(result.outstanding_payments)}</dd></div>
          <div className="is-subtotal"><dt>{s.adjBank}</dt><dd>{formatMoney(result.adjusted_bank_balance)}</dd></div>
          <div className="is-subtotal"><dt>{s.gl}</dt><dd>{formatMoney(result.gl_balance)}</dd></div>
          <div className={`is-total${problem ? ' is-problem' : ''}`}><dt>{s.diff}</dt><dd>{formatMoney(result.difference)}</dd></div>
        </dl>
      </div>
      <Text size="xs" c="dimmed">{s.zero}</Text>
      {result.problems.length > 0 && <Alert color={severity} title={problemKind}><ul className="fin-notice-list">{result.problems.map(p => <li key={p}>{s.problemLabels[p] ?? p}</li>)}</ul>
        {(result.problems.includes('unmapped') || result.problems.includes('statement_missing')) && <Group gap="xs" mt="sm">
          {result.problems.includes('unmapped') && <Button size="xs" variant="default" onClick={() => goTo('bsr-links')}>{s.goLink}</Button>}
          {result.problems.includes('statement_missing') && <Button size="xs" variant="default" onClick={() => goTo('bsr-statements')}>{s.goStatement}</Button>}
        </Group>}</Alert>}
      {result.warnings.length > 0 && <Alert color="yellow" title={s.warning}><ul className="fin-notice-list">{result.warnings.map(w => <li key={w}>{s.warningLabels[w] ?? w}{w === 'bank_only_items' ? ` (${result.bank_only_count}) · ${s.bankOnly}` : ''}</li>)}</ul></Alert>}
      {result.rejected_evidence.length > 0 && <Alert color="orange">{s.rejected}: {result.rejected_evidence.length}</Alert>}
      <Title order={4} size="h5">{s.items}</Title>
      {result.outstanding_items.length === 0 ? <Text c="dimmed">{s.none}</Text> : <Table.ScrollContainer minWidth={0} className="bsr-items-scroll"><Table className="bsr-items">
        <Table.Thead><Table.Tr><Table.Th>{s.kind}</Table.Th><Table.Th>{s.glDate}</Table.Th><Table.Th>{s.bankDate}</Table.Th><Table.Th className="bsr-items__amount">{s.amount}</Table.Th></Table.Tr></Table.Thead><Table.Tbody>
        {result.outstanding_items.map(i => <Table.Tr key={i.journal_entry_id}><Table.Td data-label={s.kind}>{s[i.kind]}</Table.Td><Table.Td data-label={s.glDate}><span dir="ltr">{formatDisplayDateLtr(i.accounting_date, i18n.language)}</span></Table.Td>
          <Table.Td data-label={s.bankDate}><span dir="ltr">{formatDisplayDateLtr(i.bank_transaction_date, i18n.language)}</span>{i.aged && <Badge ms="xs" color="yellow">{s.aged}</Badge>}</Table.Td><Table.Td className="bsr-items__amount" data-label={s.amount}><span className="fin-amount">{formatMoney(i.amount)}</span></Table.Td></Table.Tr>)}
      </Table.Tbody></Table></Table.ScrollContainer>}
    </Stack></Card>; })()}

    <Card withBorder id="bsr-links" tabIndex={-1}><Stack gap="sm"><Title order={3} size="h4">{s.links}</Title>
      {activeLink ? <Group><Text><bdi dir="auto">{ledgerName(activeLink.account_id)}</bdi> · {s.validFrom} <span dir="ltr">{formatDisplayDateLtr(activeLink.valid_from, i18n.language)}</span></Text>
        {canManageLinks && <Button size="xs" variant="default" onClick={() => setPending({ kind: 'endLink', link: activeLink })}>{s.endLink} (<span dir="ltr">{formatDisplayDateLtr(periodEnd, i18n.language)}</span>)</Button>}</Group> : <Text c="dimmed">{s.unlinked}</Text>}
      {canManageLinks && !activeLink && <form onSubmit={addLink} noValidate><Group align="end">
        <NativeSelect label={s.ledger} value={ledgerId} onChange={e => setLedgerId(e.currentTarget.value)} error={fieldErrors['ledgerId']} data={[{ value: '', label: '—' }, ...ledger.map(a => ({ value: a.id, label: `${a.code} ${a.name}` }))]} required/>
        <DateTextInput label={s.validFrom} value={validFrom} onChange={setValidFrom} error={fieldErrors['validFrom']} required/>
        <Button type="submit">{s.link}</Button></Group></form>}
    </Stack></Card>

    <Card withBorder id="bsr-statements" tabIndex={-1}><Stack gap="sm"><Title order={3} size="h4">{s.statements}</Title>
      {bankStatements.length === 0 ? <Text c="dimmed">{s.empty}</Text> : <Table.ScrollContainer minWidth={640}><Table className="bsr-table">
        <colgroup><col className="bsr-col-ref"/><col className="bsr-col-period"/><col className="bsr-col-closing"/><col className="bsr-col-status"/><col className="bsr-col-actions"/></colgroup>
        <Table.Thead><Table.Tr>
        <Table.Th>{s.ref}</Table.Th><Table.Th>{s.period}</Table.Th><Table.Th>{s.closing}</Table.Th><Table.Th>{s.status}</Table.Th><Table.Th>{s.actions}</Table.Th></Table.Tr></Table.Thead><Table.Tbody>
        {bankStatements.map(st => <Table.Tr key={st.id}><Table.Td><bdi dir="auto" className="bsr-text">{st.statement_ref}</bdi>{st.replacement_reason && <Text size="xs" c="dimmed"><bdi dir="auto">{st.replacement_reason}</bdi></Text>}</Table.Td>
          <Table.Td><bdi dir="ltr" className="bsr-ltr">{formatDisplayDateLtr(st.period_start, i18n.language)} → {formatDisplayDateLtr(st.period_end, i18n.language)}</bdi></Table.Td><Table.Td><bdi dir="ltr" className="bsr-ltr">{formatMoney(st.closing_balance)} {st.currency_code}</bdi></Table.Td><Table.Td>{statusBadge(st.status)}</Table.Td>
          <Table.Td><Group gap="xs" justify="flex-start">
            {st.status === 'draft' && canConfirmStatements && <Button size="xs" onClick={() => setPending({ kind: 'confirm', st })}>{s.confirm}</Button>}
            {st.status === 'draft' && canManageStatements && <Button size="xs" color="red" variant="subtle" onClick={() => setPending({ kind: 'delete', st })}>{s.remove}</Button>}
            {st.status === 'confirmed' && canConfirmStatements && <Button size="xs" variant="default" onClick={() => setReplacing(st)}>{s.replace}</Button>}
          </Group></Table.Td></Table.Tr>)}
      </Table.Tbody></Table></Table.ScrollContainer>}

      {(canManageStatements || (replacing && canConfirmStatements)) && <form onSubmit={addStatement} noValidate key={replacing?.id ?? 'new'}><Stack gap="xs">
        {replacing && <><Alert color="yellow">{s.replace}: {replacing.statement_ref}</Alert><TextInput label={s.reason} value={reason} onChange={e => setReason(e.currentTarget.value)} error={fieldErrors['reason']} maxLength={500} required/></>}
        <Group align="end" wrap="wrap">
          <TextInput name="ref" label={s.ref} defaultValue={replacing?.statement_ref ?? ''} error={fieldErrors['ref']} maxLength={100} required/>
          <DateTextInput name="from" error={fieldErrors['from']} label={s.from} defaultValue={replacing?.period_start ?? ''} required/>
          <DateTextInput name="to" error={fieldErrors['to']} label={s.to} defaultValue={replacing?.period_end ?? periodEnd} required/>
          <TextInput name="opening" dir="ltr" error={fieldErrors['opening']} label={s.opening} inputMode="decimal" defaultValue={replacing?.opening_balance ?? ''}/>
          <TextInput name="closing" dir="ltr" error={fieldErrors['closing']} label={s.closing} inputMode="decimal" defaultValue={replacing?.closing_balance ?? ''} required/>
          <TextInput name="note" label={s.note} maxLength={500}/>
          <Button type="submit" disabled={!bankId}>{replacing ? s.replace : s.add}</Button>
          {replacing && <Button variant="default" onClick={() => { setReplacing(null); setReason(''); }}>×</Button>}
        </Group></Stack></form>}
    </Stack></Card>

    <Card withBorder><Group justify="space-between" align="end" wrap="wrap">
      <div><Title order={3} size="h4">{s.settingsTitle}</Title><Badge color={settings.mode === 'enforce' ? 'red' : settings.mode === 'warn' ? 'yellow' : 'gray'}>{s.modes[settings.mode]}</Badge>
        {settings.enforce_from && <Text size="sm" c="dimmed"> {s.effective}: <span dir="ltr">{formatDisplayDateLtr(settings.enforce_from, i18n.language)}</span></Text>}</div>
      {canManageSettings && <form onSubmit={saveSettings} noValidate><Group align="end">
        <NativeSelect label={s.mode} value={mode} onChange={e => setMode(e.currentTarget.value as Mode)} data={(['off', 'warn', 'enforce'] as Mode[]).map(m => ({ value: m, label: s.modes[m] }))}/>
        {mode === 'enforce' && <DateTextInput label={s.effective} value={enforceFrom} onChange={setEnforceFrom} error={fieldErrors['enforceFrom']} required/>}
        <Button type="submit">{s.save}</Button></Group></form>}
    </Group></Card>
  </Stack>;
}
