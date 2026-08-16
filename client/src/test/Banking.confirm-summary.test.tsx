import { render, screen } from '@testing-library/react';
import { MantineProvider } from '@mantine/core';
import { beforeEach, describe, expect, it } from 'vitest';
import '../i18n';
import i18n from '../i18n';
import { BankConfirmSummary } from '../components/Banking';

beforeEach(async () => { await i18n.changeLanguage('en'); });

describe('BankConfirmSummary', () => {
  it('shows imported and duplicate counts after a successful confirm', () => {
    render(<MantineProvider><BankConfirmSummary result={{ importedRows: 12, duplicateRows: 3, idempotent: false }}/></MantineProvider>);
    const status = screen.getByRole('status');
    expect(status).toHaveTextContent('Confirmed');
    expect(status).toHaveTextContent('Valid: 12');
    expect(status).toHaveTextContent('Duplicates: 3');
  });
});
