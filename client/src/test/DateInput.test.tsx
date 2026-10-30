import { fireEvent, render, screen } from '@testing-library/react';
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import '../i18n';
import { DateInput, isValidIsoDate, maskDateText } from '../components/DateInput';

describe('maskDateText', () => {
  it('formats digits year-first and converts Arabic-Indic digits and separators', () => {
    expect(maskDateText('20261029')).toBe('2026-10-29');
    expect(maskDateText('٢٠٢٦/١٠/٢٩')).toBe('2026-10-29');
    expect(maskDateText('2026.10')).toBe('2026-10');
  });
  it('never reinterprets a day-first value', () => {
    expect(maskDateText('29/10/2026')).toBe('29-10-2026');
    expect(isValidIsoDate(maskDateText('29/10/2026'))).toBe(false);
  });
});

describe('calendar picker', () => {
  it('fills the typed field from the browser date picker and keeps the ISO text', () => {
    const seen = vi.fn();
    render(<Harness onValue={seen} />);
    const native = document.querySelector('input[type="date"]') as HTMLInputElement;
    fireEvent.change(native, { target: { value: '2026-03-15' } });
    expect(screen.getByLabelText(/^Date/)).toHaveValue('2026-03-15');
    expect(seen).toHaveBeenLastCalledWith('2026-03-15');
  });
  it('opens the native picker from a labelled button', () => {
    render(<Harness onValue={vi.fn()} />);
    const native = document.querySelector('input[type="date"]') as HTMLInputElement;
    native.showPicker = vi.fn();
    fireEvent.click(screen.getByRole('button', { name: /calendar|التقويم/i }));
    expect(native.showPicker).toHaveBeenCalled();
  });
});

describe('isValidIsoDate', () => {
  it('rejects impossible calendar dates', () => {
    expect(isValidIsoDate('2026-02-29')).toBe(false);
    expect(isValidIsoDate('2028-02-29')).toBe(true);
    expect(isValidIsoDate('2026-13-01')).toBe(false);
  });
});

function Harness({ onValue }: { onValue: (v: string) => void }) {
  const [v, setV] = useState('');
  return <label>Date<DateInput value={v} onChange={x => { setV(x); onValue(x); }} min="2026-01-01" /></label>;
}

describe('DateInput', () => {
  it('emits ISO only when the text is a complete valid date', () => {
    const seen = vi.fn();
    render(<Harness onValue={seen} />);
    const input = screen.getByLabelText('Date');
    fireEvent.change(input, { target: { value: '2026103' } });
    expect(seen).toHaveBeenLastCalledWith('');
    fireEvent.change(input, { target: { value: '20261031' } });
    expect(input).toHaveValue('2026-10-31');
    expect(seen).toHaveBeenLastCalledWith('2026-10-31');
  });
  it('announces an error for a day-first entry and does not emit it', () => {
    const seen = vi.fn();
    render(<Harness onValue={seen} />);
    fireEvent.change(screen.getByLabelText(/^Date/), { target: { value: '31/10/2026' } });
    expect(screen.getByRole('alert')).toHaveTextContent('YYYY-MM-DD');
    expect(screen.getByLabelText(/^Date/)).toHaveAttribute('aria-invalid', 'true');
    expect(seen).toHaveBeenLastCalledWith('');
  });
  it('rejects dates before min and supports ArrowUp/ArrowDown day stepping', () => {
    const seen = vi.fn();
    render(<Harness onValue={seen} />);
    const input = screen.getByLabelText(/^Date/);
    fireEvent.change(input, { target: { value: '2025-12-31' } });
    expect(screen.getByRole('alert')).toHaveTextContent('2026-01-01');
    fireEvent.change(input, { target: { value: '2026-01-31' } });
    fireEvent.keyDown(input, { key: 'ArrowUp' });
    expect(input).toHaveValue('2026-02-01');
  });
});
