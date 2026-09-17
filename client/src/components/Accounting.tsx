import { Accounting as AccountingCore } from './AccountingCore';
import { AccountClassificationPanel } from './AccountClassificationPanel';

interface Props {
  canView: boolean;
  canCreateChart: boolean;
  canEditChart: boolean;
  canCreateJournal: boolean;
  canEditJournal: boolean;
  canPost: boolean;
  onUnauthorized: () => void;
}

export function Accounting(props:Props){
  return <>
    <AccountingCore {...props}/>
    <AccountClassificationPanel
      canView={props.canView}
      canManage={props.canEditChart}
      onUnauthorized={props.onUnauthorized}
    />
  </>;
}
