const ERROR_ID = 'eqfal-field-error-';
let nextErrorId = 0;

type PreviousState = {
  describedBy: string | null;
  injectedDescribedBy: string;
  invalid: string | null;
  message: HTMLElement;
};

function messageFor(field: HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement, lang: string) {
  const ar = lang.toLowerCase().startsWith('ar');
  const validity = field.validity;
  if (validity.customError) return field.validationMessage || (ar ? 'راجع هذه القيمة.' : 'Check this value.');
  if (validity.valueMissing) return ar ? 'هذا الحقل مطلوب.' : 'This field is required.';
  if (validity.typeMismatch) return ar ? 'أدخل قيمة بالتنسيق الصحيح.' : 'Enter a value in the correct format.';
  if (validity.patternMismatch) return ar ? 'أدخل قيمة بالتنسيق المطلوب.' : 'Enter a value in the required format.';
  if (validity.rangeUnderflow) return ar ? 'القيمة أقل من الحد المسموح.' : 'The value is below the allowed minimum.';
  if (validity.rangeOverflow) return ar ? 'القيمة أعلى من الحد المسموح.' : 'The value is above the allowed maximum.';
  if (validity.tooShort) return ar ? 'القيمة أقصر من الحد الأدنى المسموح.' : 'The value is shorter than the allowed minimum.';
  if (validity.tooLong) return ar ? 'القيمة أطول من الحد المسموح.' : 'The value is longer than the allowed maximum.';
  if (validity.stepMismatch || validity.badInput) return ar ? 'أدخل قيمة صحيحة.' : 'Enter a valid value.';
  return ar ? 'راجع هذه القيمة.' : 'Check this value.';
}

/** Adds localized, inline errors to fields rejected by native form constraints, without changing the form's submission rules. */
export function installLocalizedFieldValidation(doc: Document = document) {
  const previous = new Map<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement, PreviousState>();
  const clear = (field: HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement) => {
    const state = previous.get(field);
    if (!state) return;
    state.message.remove();
    if (field.getAttribute('aria-invalid') === 'true') {
      state.invalid === null ? field.removeAttribute('aria-invalid') : field.setAttribute('aria-invalid', state.invalid);
    }
    const describedBy = field.getAttribute('aria-describedby');
    if (describedBy === state.injectedDescribedBy) {
      state.describedBy === null ? field.removeAttribute('aria-describedby') : field.setAttribute('aria-describedby', state.describedBy);
    } else if (describedBy !== null) {
      const remaining = describedBy.split(/\s+/).filter(id => id && id !== state.message.id);
      remaining.length ? field.setAttribute('aria-describedby', remaining.join(' ')) : field.removeAttribute('aria-describedby');
    }
    previous.delete(field);
  };
  const invalid = (event: Event) => {
    const field = event.target;
    const view = doc.defaultView;
    if (!view || !(field instanceof view.HTMLInputElement || field instanceof view.HTMLSelectElement || field instanceof view.HTMLTextAreaElement)) return;
    event.preventDefault();
    clear(field);
    const message = doc.createElement('span');
    message.id = `${ERROR_ID}${++nextErrorId}`;
    message.className = 'form-validation-error';
    message.setAttribute('role', 'alert');
    message.textContent = messageFor(field, doc.documentElement.lang || 'en');
    const anchor = field.closest('.mantine-InputWrapper-root') ?? field;
    anchor.insertAdjacentElement('afterend', message);
    const describedBy = field.getAttribute('aria-describedby');
    const injectedDescribedBy = [describedBy, message.id].filter(Boolean).join(' ');
    previous.set(field, { describedBy, injectedDescribedBy, invalid: field.getAttribute('aria-invalid'), message });
    field.setAttribute('aria-invalid', 'true');
    field.setAttribute('aria-describedby', injectedDescribedBy);
  };
  const changed = (event: Event) => {
    const field = event.target;
    const view = doc.defaultView;
    if (view && (field instanceof view.HTMLInputElement || field instanceof view.HTMLSelectElement || field instanceof view.HTMLTextAreaElement)) {
      // React-controlled inputs may update their value after this document capture listener runs.
      queueMicrotask(() => {
        if (field.isConnected && field.validity.valid) clear(field);
      });
    }
  };
  const refresh = () => {
    for (const [field, state] of previous) {
      if (!field.isConnected) {
        clear(field);
        continue;
      }
      if (field.validity.valid) {
        clear(field);
        continue;
      }
      const text = messageFor(field, doc.documentElement.lang || 'en');
      if (state.message.textContent !== text) state.message.textContent = text;
      if (!state.message.isConnected) {
        const anchor = field.closest('.mantine-InputWrapper-root') ?? field;
        anchor.insertAdjacentElement('afterend', state.message);
      }
    }
  };
  const Observer = doc.defaultView?.MutationObserver;
  const observer = Observer ? new Observer(refresh) : null;
  if (observer && doc.documentElement) observer.observe(doc.documentElement, { subtree: true, childList: true, attributes: true, attributeFilter: ['lang'] });
  doc.addEventListener('invalid', invalid, true);
  doc.addEventListener('input', changed, true);
  doc.addEventListener('change', changed, true);
  return () => {
    observer?.disconnect();
    doc.removeEventListener('invalid', invalid, true);
    doc.removeEventListener('input', changed, true);
    doc.removeEventListener('change', changed, true);
    for (const field of previous.keys()) clear(field);
  };
}
