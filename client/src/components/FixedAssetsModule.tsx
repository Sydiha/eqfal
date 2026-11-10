import {useEffect,useMemo,useState} from 'react';
import {readQueryParameter,writeQueryParameters} from '../navigation/queryState';
import {canOpenDestination,destinationsFor} from '../navigation/pageDestinations';
import {AssetPolicyOperations} from './AssetPolicyOperations';
import {FixedAssets} from './FixedAssets';

type AssetView='main'|'policy'|'categories';
type Props={capabilities?:readonly string[];canView:boolean;canCreate:boolean;canEdit:boolean;canCancel:boolean;canManagePolicy:boolean;canApprove:boolean;canDispose:boolean;canCreateEstimate:boolean;canReviewEstimate:boolean;canApproveEstimate:boolean;onUnauthorized:()=>void};

const assetDestinations=destinationsFor('assets');
const readView=(capabilities:readonly string[]):AssetView=>{
 const requested=readQueryParameter('assetView',{allowedValues:assetDestinations.map(destination=>destination.query!.assetView)}) as AssetView|null;
 const destination=requested?assetDestinations.find(item=>item.query?.assetView===requested):undefined;
 return destination&&canOpenDestination(destination,capabilities)?requested!:'main';
};

// Presentation-only shell: splits the former long page into the approved Figma sub-views.
export function FixedAssetsModule({canCreateEstimate,canReviewEstimate,canApproveEstimate,...props}:Props){
 const capabilities=useMemo(()=>props.capabilities ?? ['asset.view', ...(props.canManagePolicy?['asset.policy.manage']:[])],[props.capabilities,props.canManagePolicy]);
 const[view,setView]=useState<AssetView>(()=>readView(capabilities));
 useEffect(()=>{const sync=()=>setView(readView(capabilities));window.addEventListener('popstate',sync);return()=>window.removeEventListener('popstate',sync)},[capabilities]);
 const go=(next:AssetView)=>{const destination=assetDestinations.find(item=>item.query?.assetView===next);if(destination&&!canOpenDestination(destination,capabilities))return;writeQueryParameters({assetView:next==='main'?null:next});setView(next)};
 if(view==='policy')return <AssetPolicyOperations canView={props.canView} canManagePolicy={props.canManagePolicy} canCreateEstimate={canCreateEstimate} canReviewEstimate={canReviewEstimate} canApproveEstimate={canApproveEstimate} onUnauthorized={props.onUnauthorized} onBack={()=>go('main')}/>;
 return <FixedAssets {...props} view={view==='categories'?'categories':'main'} onOpenPolicy={()=>go('policy')} onOpenCategories={()=>go('categories')} onBack={()=>go('main')}/>;
}
