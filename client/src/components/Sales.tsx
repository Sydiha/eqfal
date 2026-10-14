import {useTranslation} from 'react-i18next';
import {PageHeader,WorkspacePage,WorkspaceState} from './SharedUI';
import {SalesInvoices,SalesInvoiceCapabilities} from './SalesInvoices';
import './SalesApproved.css';

/** The one invoice workspace for this direction. Users without invoice access get a restricted state, never a legacy document register (documents live in the Documents module). */
export function Sales({invoices,onNavigate,onUnauthorized}:{invoices?:SalesInvoiceCapabilities;onNavigate?:(page:string,parameters:Record<string,string>)=>void;onUnauthorized:()=>void}){
 const{t}=useTranslation();
 const invoiceAccess=!!invoices&&(invoices.canView||invoices.canCreate);
 return <WorkspacePage size="operational" labelledBy="sales-title" className="sales-workspace sales-v22 sales-approved"><PageHeader className="sales-approved__header" titleId="sales-title" title={t('sales.title')} description={invoiceAccess?t('salesInvoice.intro'):undefined}/>{invoiceAccess?<SalesInvoices {...invoices!} direction="sales" onNavigate={onNavigate} onUnauthorized={onUnauthorized}/>:<WorkspaceState>{t('invoiceWorkspace.restricted')}</WorkspaceState>}</WorkspacePage>;
}
