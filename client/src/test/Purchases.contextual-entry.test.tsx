import {fireEvent,screen} from './test-utils';
import {render} from './test-utils';
import {beforeEach,describe,expect,it,vi} from 'vitest';
import {Purchases} from '../components/Purchases';
import i18n from '../i18n';

describe('Purchases contextual entry points',()=>{
 beforeEach(async()=>{vi.restoreAllMocks();await i18n.changeLanguage('en');vi.stubGlobal('fetch',vi.fn().mockResolvedValue(new Response(JSON.stringify({purchases:[]}))))});

 it('offers purchase and expense entry from one Add action when document upload is allowed',async()=>{
  const onCreateDocument=vi.fn();
  render(<Purchases canView canManage={false} canCreate onCreateDocument={onCreateDocument} onUnauthorized={vi.fn()}/>);
  const actions=await screen.findAllByRole('button',{name:'Add purchase document +'});
  expect(screen.getByText('No purchases or expenses yet.')).toBeInTheDocument();
  fireEvent.click(actions[0]!);
  expect(screen.getByRole('dialog',{name:'Add purchase or expense'})).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button',{name:'Purchase'}));
  expect(onCreateDocument).toHaveBeenCalledWith('purchase');
 });

 it('starts an expense with the same contextual entry flow',async()=>{
  const onCreateDocument=vi.fn();
  render(<Purchases canView canManage={false} canCreate onCreateDocument={onCreateDocument} onUnauthorized={vi.fn()}/>);
  const actions=await screen.findAllByRole('button',{name:'Add purchase document +'});
  fireEvent.click(actions[0]!);
  fireEvent.click(screen.getByRole('button',{name:'Expense'}));
  expect(onCreateDocument).toHaveBeenCalledWith('expense');
 });

 it('keeps the workspace read-only when document upload is not allowed',async()=>{
  render(<Purchases canView canManage={false} onUnauthorized={vi.fn()}/>);
  await screen.findByText('No purchases or expenses yet.');
  expect(screen.queryByRole('button',{name:'Add purchase document +'})).not.toBeInTheDocument();
 });
});
