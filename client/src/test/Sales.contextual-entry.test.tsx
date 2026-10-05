import {fireEvent,screen} from './test-utils';
import {render} from './test-utils';
import {beforeEach,describe,expect,it,vi} from 'vitest';
import {Sales} from '../components/Sales';
import i18n from '../i18n';

describe('Sales contextual entry point',()=>{
 beforeEach(async()=>{vi.restoreAllMocks();await i18n.changeLanguage('en')});

 it('offers one direct sale entry action and delegates document creation without financial writes',async()=>{
  const fetchMock=vi.fn().mockResolvedValue(new Response(JSON.stringify({sales:[]})));
  vi.stubGlobal('fetch',fetchMock);
  const onCreateDocument=vi.fn();
  render(<Sales canView canManage canCreate onCreateDocument={onCreateDocument} onUnauthorized={vi.fn()}/>);
  const buttons=await screen.findAllByRole('button',{name:'Add sales invoice +'});
  fireEvent.click(buttons[0]!);
  expect(onCreateDocument).toHaveBeenCalledTimes(1);
  expect(fetchMock).toHaveBeenCalledTimes(1);
  expect(fetchMock.mock.calls[0][0]).toBe('/api/sales');
  expect(fetchMock.mock.calls.some(call=>call[0]==='/api/obligations')).toBe(false);
 });

 it('hides sale entry when document upload capability is absent',async()=>{
  vi.stubGlobal('fetch',vi.fn().mockResolvedValue(new Response(JSON.stringify({sales:[]}))));
  render(<Sales canView canManage canCreate={false} onCreateDocument={vi.fn()} onUnauthorized={vi.fn()}/>);
  await screen.findByText('No sales invoices yet.');
  expect(screen.queryByRole('button',{name:'Add sales invoice +'})).not.toBeInTheDocument();
 });

 it('uses the localized sale label in Arabic',async()=>{
  await i18n.changeLanguage('ar');
  vi.stubGlobal('fetch',vi.fn().mockResolvedValue(new Response(JSON.stringify({sales:[]}))));
  render(<Sales canView canManage canCreate onCreateDocument={vi.fn()} onUnauthorized={vi.fn()}/>);
  expect((await screen.findAllByRole('button',{name:'إضافة فاتورة مبيعات +'})).length).toBeGreaterThan(0);
 });
});
