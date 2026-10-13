import {useTranslation} from 'react-i18next';
import {readQueryParameter,writeQueryParameters} from '../navigation/queryState';

export type InvoiceSection='invoices'|'legacy';
/** Current section from the URL (`<param>=legacy`); anything else is the invoice workspace. */
export const readInvoiceSection=(param:string):InvoiceSection=>readQueryParameter(param,{allowedValues:['legacy']})==='legacy'?'legacy':'invoices';
export const writeInvoiceSection=(param:string,section:InvoiceSection)=>writeQueryParameters({[param]:section==='legacy'?'legacy':null});

/** Separates the new invoice workspace from the legacy document register so the two never share one screen. */
export function InvoiceSectionTabs({active,onChange}:{active:InvoiceSection;onChange:(section:InvoiceSection)=>void}){
 const{t}=useTranslation();
 const tab=(section:InvoiceSection,label:string)=><button type="button" role="tab" id={`invoice-tab-${section}`} aria-selected={active===section} aria-controls="invoice-section-panel" tabIndex={active===section?0:-1} className={`invoice-tabs__tab${active===section?' invoice-tabs__tab--active':''}`} onClick={()=>onChange(section)} onKeyDown={e=>{if(e.key==='ArrowRight'||e.key==='ArrowLeft'||e.key==='Home'||e.key==='End'){e.preventDefault();onChange(section==='invoices'?'legacy':'invoices')}}}>{label}</button>;
 return <div className="invoice-tabs" role="tablist" aria-label={t('invoiceWorkspace.tabsLabel')}>{tab('invoices',t('invoiceWorkspace.tabInvoices'))}{tab('legacy',t('invoiceWorkspace.tabLegacy'))}</div>;
}
