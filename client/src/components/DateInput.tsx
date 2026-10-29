import { ChangeEvent, KeyboardEvent, useCallback, useEffect, useId, useRef, useState } from 'react';
import type { InputHTMLAttributes } from 'react';
import { TextInput, TextInputProps } from '@mantine/core';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';

/**
 * Year-first (ISO) date entry. Native type="date" renders mm/dd/yyyy or dd/mm/yyyy depending on the browser locale, which is
 * ambiguous on financial screens. This control always shows and accepts YYYY-MM-DD, never guesses a day-first value, and
 * hands back ISO strings only (or '' while the text is incomplete/invalid).
 */
const strings = {
  en: { placeholder: 'YYYY-MM-DD', format: 'Enter the date as YYYY-MM-DD, for example 2026-03-31.', min: (d: string) => `The date must be on or after ${d}.`, max: (d: string) => `The date must be on or before ${d}.` },
  ar: { placeholder: 'YYYY-MM-DD', format: 'أدخل التاريخ بصيغة سنة-شهر-يوم YYYY-MM-DD، مثل 2026-03-31.', min: (d: string) => `يجب ألا يسبق التاريخ ${d}.`, max: (d: string) => `يجب ألا يتجاوز التاريخ ${d}.` },
};

const ISO = /^(\d{4})-(\d{2})-(\d{2})$/;

export function isValidIsoDate(value: string): boolean {
  const m = ISO.exec(value);
  if (!m) return false;
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  return d.getUTCFullYear() === Number(m[1]) && d.getUTCMonth() === Number(m[2]) - 1 && d.getUTCDate() === Number(m[3]);
}

/** Arabic-Indic/Persian digits to Latin, common separators to '-'. */
function normalizeText(raw: string): string {
  return raw
    .replace(/[\u0660-\u0669]/g, c => String(c.charCodeAt(0) - 0x0660))
    .replace(/[\u06f0-\u06f9]/g, c => String(c.charCodeAt(0) - 0x06f0))
    .replace(/[\u200e\u200f\u202a-\u202e\s]/g, '')
    .replace(/[/.\u066b\u2010-\u2015]/g, '-');
}

/** Masks typing into YYYY-MM-DD. A day-first value (dd/mm/yyyy) is left untouched so it fails validation instead of being reinterpreted. */
export function maskDateText(raw: string): string {
  const text = normalizeText(raw);
  if (/^\d{1,3}-/.test(text)) return text.slice(0, 10);
  const digits = text.replace(/\D/g, '').slice(0, 8);
  if (digits.length <= 4) return digits;
  if (digits.length <= 6) return `${digits.slice(0, 4)}-${digits.slice(4)}`;
  return `${digits.slice(0, 4)}-${digits.slice(4, 6)}-${digits.slice(6)}`;
}

function shiftDay(iso: string, delta: number): string {
  const m = ISO.exec(iso)!;
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]) + delta));
  return `${String(d.getUTCFullYear()).padStart(4, '0')}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
}

type Options = { value?: string; defaultValue?: string; onChange?: (iso: string) => void; min?: string; max?: string };

export function useDateField({ value, defaultValue, onChange, min, max }: Options) {
  const { i18n } = useTranslation();
  const s = i18n.language.startsWith('ar') ? strings.ar : strings.en;
  const controlled = value !== undefined;
  const [text, setText] = useState(value ?? defaultValue ?? '');
  const [touched, setTouched] = useState(false);
  const lastEmitted = useRef(value ?? '');
  const inputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    if (controlled && value !== lastEmitted.current) { lastEmitted.current = value; setText(value); }
  }, [controlled, value]);

  const emit = (iso: string) => { lastEmitted.current = iso; onChange?.(iso); };
  const valid = isValidIsoDate(text);
  let error = '';
  if (text && !valid && (touched || text.length >= 10)) error = s.format;
  else if (valid && min && isValidIsoDate(min) && text < min) error = s.min(min);
  else if (valid && max && isValidIsoDate(max) && text > max) error = s.max(max);

  useEffect(() => { inputRef.current?.setCustomValidity(error || (text && !valid ? s.format : '')); }, [error, text, valid, s.format]);

  const apply = (next: string) => {
    setText(next);
    if (controlled) emit(isValidIsoDate(next) && !(min && next < min) && !(max && next > max) ? next : '');
  };
  const inputProps = {
    ref: useCallback((el: HTMLInputElement | null) => { inputRef.current = el; }, []),
    type: 'text' as const,
    inputMode: 'numeric' as const,
    dir: 'ltr' as const,
    autoComplete: 'off',
    maxLength: 10,
    placeholder: s.placeholder,
    value: text,
    'aria-invalid': error ? true : undefined,
    onChange: (e: ChangeEvent<HTMLInputElement>) => apply(maskDateText(e.currentTarget.value)),
    onBlur: () => setTouched(true),
    onKeyDown: (e: KeyboardEvent<HTMLInputElement>) => {
      if ((e.key === 'ArrowUp' || e.key === 'ArrowDown') && valid) { e.preventDefault(); apply(shiftDay(text, e.key === 'ArrowUp' ? 1 : -1)); }
    },
  };
  return { inputProps, error };
}

type Props = Omit<InputHTMLAttributes<HTMLInputElement>, 'type' | 'value' | 'defaultValue' | 'onChange' | 'min' | 'max'> & {
  value?: string; defaultValue?: string; onChange?: (iso: string) => void; min?: string; max?: string;
};

export function DateInput({ value, defaultValue, onChange, min, max, required, ...rest }: Props) {
  const { inputProps, error } = useDateField({ value, defaultValue, onChange, min, max });
  const errorId = useId();
  return (
    <>
      <input {...rest} {...inputProps} min={min} max={max} required={required} className={['date-input', rest.className].filter(Boolean).join(' ')} aria-describedby={error ? errorId : rest['aria-describedby']} />
      {error && <small className="date-input__error" aria-hidden="true">{error}</small>}
      {error && createPortal(<span id={errorId} role="alert" className="date-input__sr">{error}</span>, document.body)}
    </>
  );
}

type FieldProps = Omit<TextInputProps, 'type' | 'value' | 'defaultValue' | 'onChange' | 'min' | 'max'> & {
  value?: string; defaultValue?: string; onChange?: (iso: string) => void; min?: string; max?: string;
};

/** Same behaviour as DateInput, rendered with Mantine's TextInput (label and error slots). */
export function DateTextInput({ value, defaultValue, onChange, min, max, error, ...rest }: FieldProps) {
  const { inputProps, error: ownError } = useDateField({ value, defaultValue, onChange, min, max });
  return <TextInput {...rest} {...inputProps} error={error || ownError || undefined} />;
}
