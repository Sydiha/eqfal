import { Accounting as AccountingCore } from './AccountingCore';
import { AccountClassificationPanel } from './AccountClassificationPanel';

interface Props {
  canView: boolean;
  canManageChart: boolean;
  canManageJournals: boolean;
  canPost: boolean;
  onUnauthorized: () => void;
}

export function Accounting(props:Props){
  return <>
    <AccountingCore {...props}/>
    <AccountClassificationPanel
      canView={props.canView}
      canManage={props.canManageChart}
      onUnauthorized={props.onUnauthorized}
    />
  </>;
}
