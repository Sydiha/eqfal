import {useTranslation} from 'react-i18next';
import {PageHeader,WorkspacePage,WorkspaceState} from './SharedUI';
import {SalesInvoices,SalesInvoiceCapabilities} from './SalesInvoices';
import './PurchasesApproved.css';

/** The one invoice workspace for this direction. Users without invoice access get a restricted state, never a legacy document register (documents live in the Documents module). */
export function Purchases({invoices,onNavigate,onUnauthorized}:{invoices?:SalesInvoiceCapabilities;onNavigate?:(page:string,parameters:Record<string,string>)=>void;onUnauthorized:()=>void}){
 const{t}=useTranslation();
 const invoiceAccess=!!invoices&&(invoices.canView||invoices.canCreate);
 return <WorkspacePage size="operational" labelledBy="purchases-title" className="purchases-workspace purchases-v22 purchases-approved"><PageHeader className="purchases-approved__header" titleId="purchases-title" title={t('purchases.title')} description={invoiceAccess?t('purchaseInvoice.intro'):undefined}/>{invoiceAccess?<SalesInvoices {...invoices!} direction="purchase" onNavigate={onNavigate} onUnauthorized={onUnauthorized}/>:<WorkspaceState>{t('invoiceWorkspace.restricted')}</WorkspaceState>}</WorkspacePage>;
}
