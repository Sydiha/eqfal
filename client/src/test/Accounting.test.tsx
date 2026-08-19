import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import '../i18n';
import { Accounting } from '../components/Accounting';

describe('Accounting workspace',()=>{
 it('enforces view capability before loading or rendering accounting data',()=>{render(<Accounting canView={false} canManageChart={false} canManageJournals={false} canPost={false} onUnauthorized={()=>undefined}/>);expect(screen.getByRole('status')).toBeInTheDocument();expect(screen.queryByRole('tab')).not.toBeInTheDocument()});
});
