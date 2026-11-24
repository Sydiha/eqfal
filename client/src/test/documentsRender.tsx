import { act, render as baseRender } from '@testing-library/react';
import type { ReactElement } from 'react';

/**
 * Documents no longer opens a preview by itself; the user must pick a row. These suites exercise the
 * selected-document detail pane, so this helper performs that explicit selection once the first row appears.
 */
export function render(ui: ReactElement, options?: Parameters<typeof baseRender>[1]) {
  const result = baseRender(ui, options);
  const observer = new MutationObserver(() => {
    const row = result.container.ownerDocument.querySelector<HTMLButtonElement>('.documents-approved__row-button');
    if (!row) return;
    observer.disconnect();
    act(() => { row.click(); });
  });
  observer.observe(result.container.ownerDocument.body, { childList: true, subtree: true });
  const unmount = result.unmount;
  result.unmount = () => { observer.disconnect(); unmount(); };
  return result;
}
