import {useEffect,useState} from 'react';
import {readQueryParameter,writeQueryParameters} from '../navigation/queryState';
import {AssetPolicyOperations} from './AssetPolicyOperations';
import {FixedAssets} from './FixedAssets';

type AssetView='main'|'policy'|'categories';
type Props={canView:boolean;canCreate:boolean;canEdit:boolean;canCancel:boolean;canManagePolicy:boolean;canApprove:boolean;canDispose:boolean;canCreateEstimate:boolean;canReviewEstimate:boolean;canApproveEstimate:boolean;onUnauthorized:()=>void};

const views=['policy','categories'] as const;
const readView=():AssetView=>(readQueryParameter('assetView',{allowedValues:views}) as AssetView|null)??'main';

// Presentation-only shell: splits the former long page into the approved Figma sub-views.
export function FixedAssetsModule({canCreateEstimate,canReviewEstimate,canApproveEstimate,...props}:Props){
 const[view,setView]=useState<AssetView>(readView);
 useEffect(()=>{const sync=()=>setView(readView());window.addEventListener('popstate',sync);return()=>window.removeEventListener('popstate',sync)},[]);
 const go=(next:AssetView)=>{writeQueryParameters({assetView:next==='main'?null:next});setView(next)};
 if(view==='policy')return <AssetPolicyOperations canView={props.canView} canManagePolicy={props.canManagePolicy} canCreateEstimate={canCreateEstimate} canReviewEstimate={canReviewEstimate} canApproveEstimate={canApproveEstimate} onUnauthorized={props.onUnauthorized} onBack={()=>go('main')}/>;
 return <FixedAssets {...props} view={view==='categories'?'categories':'main'} onOpenPolicy={()=>go('policy')} onOpenCategories={()=>go('categories')} onBack={()=>go('main')}/>;
}
