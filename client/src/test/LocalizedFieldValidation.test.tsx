import { afterEach, describe, expect, it } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { useState } from 'react';
import { MantineProvider, TextInput } from '@mantine/core';
import { installLocalizedFieldValidation } from '../forms/localizedFieldValidation';

describe('localized native field validation', () => {
  let dispose: (() => void) | undefined;
  afterEach(() => { dispose?.(); dispose = undefined; document.body.replaceChildren(); document.documentElement.lang = 'en'; });

  it('replaces the browser message with an inline Arabic required-field error and clears it after correction', async () => {
    document.documentElement.lang = 'ar';
    dispose = installLocalizedFieldValidation();
    const form = document.createElement('form');
    const label = document.createElement('label');
    label.textContent = 'الاسم';
    const input = document.createElement('input');
    input.required = true;
    input.setAttribute('aria-describedby', 'help');
    label.append(input);
    form.append(label);
    document.body.append(form);

    const invalid = new Event('invalid', { cancelable: true });
    expect(input.dispatchEvent(invalid)).toBe(false);
    const error = label.querySelector('[role="alert"]');
    expect(error).toHaveTextContent('هذا الحقل مطلوب.');
    expect(input).toHaveAttribute('aria-invalid', 'true');
    expect(input.getAttribute('aria-describedby')).toContain('help');
    expect(input.getAttribute('aria-describedby')).toContain(error?.id);

    input.value = 'اسم';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    await waitFor(() => expect(label.querySelector('[role="alert"]')).toBeNull());
    expect(input).not.toHaveAttribute('aria-invalid');
    expect(input).toHaveAttribute('aria-describedby', 'help');
  });

  it('uses English copy when the active document language is English', () => {
    document.documentElement.lang = 'en';
    dispose = installLocalizedFieldValidation();
    const input = document.createElement('input');
    input.required = true;
    document.body.append(input);
    input.dispatchEvent(new Event('invalid', { cancelable: true }));
    expect(document.querySelector('[role="alert"]')).toHaveTextContent('This field is required.');
  });

  it('updates an existing inline error when the document language changes', async () => {
    dispose = installLocalizedFieldValidation();
    const input = document.createElement('input');
    input.required = true;
    document.body.append(input);
    input.dispatchEvent(new Event('invalid', { cancelable: true }));
    expect(screen.getByRole('alert')).toHaveTextContent('This field is required.');

    document.documentElement.lang = 'ar';
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('هذا الحقل مطلوب.'));
  });

  it('keeps one message per invalid field across repeated submissions and preserves custom messages and ARIA', async () => {
    dispose = installLocalizedFieldValidation();
    const form = document.createElement('form');
    const first = document.createElement('input');
    first.required = true;
    first.setAttribute('aria-invalid', 'false');
    first.setAttribute('aria-describedby', 'first-help');
    const second = document.createElement('input');
    second.required = true;
    second.setAttribute('aria-describedby', 'second-help');
    form.append(first, second);
    document.body.append(form);

    first.dispatchEvent(new Event('invalid', { cancelable: true }));
    second.dispatchEvent(new Event('invalid', { cancelable: true }));
    first.dispatchEvent(new Event('invalid', { cancelable: true }));
    expect(form.querySelectorAll('[role="alert"]')).toHaveLength(2);
    first.value = 'ok';
    first.dispatchEvent(new Event('input', { bubbles: true }));
    await waitFor(() => expect(first).toHaveAttribute('aria-invalid', 'false'));
    expect(first).toHaveAttribute('aria-describedby', 'first-help');
    expect(second.getAttribute('aria-describedby')).toMatch(/^second-help eqfal-field-error-/);

    const custom = document.createElement('input');
    custom.setCustomValidity('Use the account code shown on your statement.');
    custom.setAttribute('aria-describedby', 'custom-help');
    const help = document.createElement('span');
    help.id = 'custom-help';
    form.append(custom, help);
    custom.dispatchEvent(new Event('invalid', { cancelable: true }));
    expect(form.querySelectorAll('[role="alert"]')).toHaveLength(2);
    expect([...form.querySelectorAll('[role="alert"]')].map(node => node.textContent)).toContain('Use the account code shown on your statement.');
    custom.setCustomValidity('');
    custom.dispatchEvent(new Event('input', { bubbles: true }));
    await waitFor(() => expect(custom).toHaveAttribute('aria-describedby', 'custom-help'));
  });

  it('cleans errors when fields unmount or the app listener is disposed', async () => {
    dispose = installLocalizedFieldValidation();
    const wrapper = document.createElement('div');
    const input = document.createElement('input');
    input.required = true;
    wrapper.append(input);
    document.body.append(wrapper);
    input.dispatchEvent(new Event('invalid', { cancelable: true }));
    expect(document.querySelectorAll('[role="alert"]')).toHaveLength(1);
    input.remove();
    await waitFor(() => expect(document.querySelector('[role="alert"]')).toBeNull());

    const next = document.createElement('input');
    next.required = true;
    document.body.append(next);
    next.dispatchEvent(new Event('invalid', { cancelable: true }));
    expect(document.querySelectorAll('[role="alert"]')).toHaveLength(1);
    dispose();
    dispose = undefined;
    expect(document.querySelector('[role="alert"]')).toBeNull();
  });

  it('supports a controlled React input rendered inside a Mantine input wrapper', async () => {
    dispose = installLocalizedFieldValidation();
    function ControlledField() {
      const [value, setValue] = useState('');
      return <TextInput label="Account code" required value={value} onChange={event => setValue(event.currentTarget.value)} />;
    }
    render(<MantineProvider><ControlledField /></MantineProvider>);
    const input = screen.getByRole('textbox', { name: 'Account code' });
    fireEvent.invalid(input);
    expect(screen.getByRole('alert')).toHaveTextContent('This field is required.');
    expect(screen.getByRole('alert').previousElementSibling).toHaveClass('mantine-InputWrapper-root');
    fireEvent.change(input, { target: { value: '1100' } });
    await waitFor(() => expect(screen.queryByRole('alert')).toBeNull());
    expect(input).toHaveValue('1100');
  });
});
