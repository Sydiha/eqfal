import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { EmployeeBonusDraft } from '../components/EmployeeBonusDraft';

afterEach(() => vi.unstubAllGlobals());

it('saves a bulk Arabic bonus draft with different amounts, including a zero period', async () => {
  const fetch = vi.fn().mockResolvedValue(new Response('{}', { status: 201 }));
  const onSaved = vi.fn();
  vi.stubGlobal('fetch', fetch);
  render(<EmployeeBonusDraft arabic employees={[
    { id: 'a', display_name: 'سارة' }, { id: 'b', display_name: 'علي' },
  ]} onSaved={onSaved} onUnauthorized={vi.fn()} />);
  fireEvent.click(screen.getByText('إعداد مكافأة'));
  for (const [name, value] of [
    ['بداية الفترة', '2026-01-01'], ['نهاية الفترة', '2026-03-31'],
    ['شرط الأهلية', 'عقد ساري'], ['شرط الاعتراف', 'تحقق الأهداف'],
  ]) fireEvent.change(screen.getByLabelText(name!), { target: { value } });
  fireEvent.change(screen.getByLabelText('الدورية'), { target: { value: 'quarterly' } });
  for (const [name, value] of [['سارة', '21000'], ['علي', '0']]) {
    const employee = within(screen.getByRole('group', { name }));
    fireEvent.click(employee.getByLabelText('تخصيص مكافأة'));
    fireEvent.change(employee.getByLabelText('قيمة الحساب'), { target: { value } });
  }
  fireEvent.click(screen.getByRole('button', { name: 'حفظ للمراجعة' }));
  await waitFor(() => expect(onSaved).toHaveBeenCalledOnce());
  expect(JSON.parse(fetch.mock.calls[0]![1].body)).toMatchObject({
    frequency: 'quarterly',
    employees: [{ employee_id: 'a', value: '21000' }, { employee_id: 'b', value: '0' }],
  });
});
