import { afterEach, describe, expect, it } from 'vitest';
import { installLocalizedFieldValidation } from '../forms/localizedFieldValidation';

describe('localized native field validation', () => {
  let dispose: (() => void) | undefined;
  afterEach(() => { dispose?.(); dispose = undefined; document.body.replaceChildren(); document.documentElement.lang = 'en'; });

  it('replaces the browser message with an inline Arabic required-field error and clears it after correction', () => {
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
    expect(label.querySelector('[role="alert"]')).toBeNull();
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
});
