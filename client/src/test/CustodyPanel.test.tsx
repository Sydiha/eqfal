import { render, screen, waitFor } from '@testing-library/react';
import { MantineProvider } from '@mantine/core';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import '../i18n';
import i18n from '../i18n';
import { CustodyPanel } from '../components/CustodyPanel';
beforeEach(async()=>{await i18n.changeLanguage('en');vi.restoreAllMocks();});
function renderPanel(props:React.ComponentProps<typeof CustodyPanel>){return render(<MantineProvider><CustodyPanel {...props}/></MantineProvider>);}
describe('CustodyPanel capability gating',()=>{
 it('does not request data without custody.view',()=>{vi.stubGlobal('fetch',vi.fn());renderPanel({canView:false,canManage:true,canClose:true,onUnauthorized:vi.fn()});expect(screen.queryByText('Custody & advances')).not.toBeInTheDocument();expect(fetch).not.toHaveBeenCalled();});
 it('loads read-only custody view while hiding mutation controls',async()=>{const fetchMock=vi.fn().mockResolvedValueOnce(new Response(JSON.stringify({custodies:[]}),{status:200})).mockResolvedValueOnce(new Response(JSON.stringify({transactions:[]}),{status:200}));vi.stubGlobal('fetch',fetchMock);renderPanel({canView:true,canManage:false,canClose:false,onUnauthorized:vi.fn()});expect(screen.getByText('Custody & advances')).toBeInTheDocument();await waitFor(()=>expect(fetchMock).toHaveBeenCalledTimes(2));expect(screen.queryByText('Create custody')).not.toBeInTheDocument();expect(screen.queryByText('Close custody')).not.toBeInTheDocument();});
});
