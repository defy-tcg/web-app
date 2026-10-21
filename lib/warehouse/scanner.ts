import { createHash, randomUUID } from 'node:crypto';
import { applyOperation, eligible, signature, text, type Scan, type Command } from './model.ts';
import { readSnapshot, readCatalog, readImage, executeWarehouse, saveScannerState, ConflictError } from './store.ts';
import { samePrinting, VISION_VERSION, type VisionDecision } from './vision/policy.ts';
import { fetchReferenceBytes } from './vision/store.ts';
import { scannerEntity, scannerOperation, SCANNER_PROTOCOL } from './scanner-policy.ts';
import type { ScannerDevice } from './scanner-auth.ts';
const sha=(value:string)=>createHash('sha256').update(value).digest('hex');
const actor=(device:ScannerDevice)=>`${device.owner_email} [Scanner: ${device.name}]`;
const candidatePending:VisionDecision={version:VISION_VERSION,candidates:[],complete:false,examined:0,elapsedMs:0,reviewReason:'Receiving draft from a paired scanner; human confirmation required.'};

export async function scannerManifest(device:ScannerDevice) {
  const {state}=await readSnapshot();if(!state.activeCatalog)throw new Error('The cloud Mastersheet has not been configured.');
  const {cards}=await readCatalog(state.activeCatalog);const current=new Map(cards.map(c=>[c.master_id,c]));
  const references=cards.filter(c=>eligible(c)&&c.image_is_exact==='1'&&c.image_url).map(c=>({
    key:'catalog:'+sha(JSON.stringify([c.image_url,c.front_asset||'',c.image_match||'',c.image_is_exact])),
    id:c.master_id,masterId:c.master_id,kind:'catalog',
  }));
  for(const label of state.learned){const c=current.get(label.masterId);if(!c||!eligible(c))continue;
    const old=(await readCatalog(label.catalogVersion)).cards.find(x=>x.master_id===label.masterId);
    const scan=state.scans.find(s=>s.id===label.scanId);
    if(old&&scan&&samePrinting(old,c)&&scan.approvalMethod==='manual'&&scan.status==='approved')references.push({key:'human:'+scan.id,id:scan.id,masterId:c.master_id,kind:'human'});
  }
  return {protocol:SCANNER_PROTOCOL,deviceId:device.id,version:state.activeCatalog,cards,references,generatedAt:new Date().toISOString(),approval:'Cloud re-verifies unconfirmed scans; local scores are not trusted as approvals.'};
}
export async function scannerImage(kind:string,version:string,id:string) {
  const {cards}=await readCatalog(version);const {state}=await readSnapshot();
  if(kind==='reference'){const card=cards.find(c=>c.master_id===id);if(!card||!eligible(card)||card.image_is_exact!=='1'||!card.image_url)throw new Error('No exact eligible reference.');return fetchReferenceBytes(card.image_url);}
  const label=state.learned.find(l=>l.scanId===id);const scan=state.scans.find(s=>s.id===id);
  if(!label||!scan||scan.approvalMethod!=='manual'||scan.status!=='approved')throw new Error('Human example is no longer active.');
  const current=cards.find(c=>c.master_id===label.masterId);const original=(await readCatalog(label.catalogVersion)).cards.find(c=>c.master_id===label.masterId);
  if(!current||!original||!samePrinting(original,current))throw new Error('Human example does not match this catalog.');
  const image=await readImage(id);if(!image)throw new Error('Saved scan image unavailable.');return image.bytes;
}
export async function createScannerBatch(device:ScannerDevice,body:Record<string,unknown>) {
  const id=scannerEntity(device.id,body.localBatchId,'batch');const version=text(body.catalogVersion,64);
  const {cards}=await readCatalog(version);const operationId=scannerOperation(device.id,body.localBatchId,'batch');
  for(let attempt=0;attempt<3;attempt++){
    const current=await readSnapshot();const existing=current.state.batches.find(b=>b.id===id);
    if(existing){if(existing.catalogVersion!==version||existing.finish!==body.finish||existing.language!==body.language||existing.condition!==body.condition)throw new Error('Existing scanner batch settings differ. Do not reuse its local ID.');return {batch:existing};}
    const requestedName=text(body.name);const name=current.state.batches.some(b=>b.name.toLowerCase()===requestedName.toLowerCase())?requestedName.slice(0,210)+' · '+id.slice(-12):requestedName;
    let sequence=0;const next=applyOperation({...current.state,activeCatalog:version},{kind:'createBatch',operationId,name,finish:body.finish,language:body.language,condition:body.condition},cards,actor(device),new Date().toISOString(),()=>sequence++===0?id.slice(7):randomUUID());
    next.activeCatalog=current.state.activeCatalog;
    try{const saved=await saveScannerState(current.revision,next);return {batch:saved.state.batches.find(b=>b.id===id)!};}
    catch(e){if(!(e instanceof ConflictError)||attempt===2)throw e;}
  }
  throw new Error('Warehouse changed; retry synchronization.');
}
function responseScan(scan:Scan) {
  return {id:scan.id,batchId:scan.batchId,status:scan.status,cardId:scan.cardId,approvalMethod:scan.approvalMethod,reviewReason:scan.reviewReason||null};
}
export async function syncScannerScan(device:ScannerDevice,body:Record<string,unknown>) {
  const batchId=scannerEntity(device.id,body.localBatchId,'batch');
  const scanId=scannerEntity(device.id,body.localScanId,'scan');const operationId=scannerOperation(device.id,body.localScanId,'scan');
  const hash=text(body.sha256,64);if(!/^[a-f0-9]{64}$/.test(hash))throw new Error('Invalid original image hash.');
  const sig=signature(body.signature);if(!sig)throw new Error('Browser image signature required.');
  if(typeof body.image!=='string'||!/^data:image\/jpeg;base64,[A-Za-z0-9+/=]+$/.test(body.image)||body.image.length>2_800_000)throw new Error('Use a JPEG preview below 2 MB.');
  const base64=body.image.split(',')[1];const bytes=Buffer.from(base64,'base64');if(bytes.length<4||bytes[0]!==255||bytes[1]!==216||bytes[2]!==255)throw new Error('Invalid JPEG preview.');
  const version=text(body.catalogVersion,64);const {cards}=await readCatalog(version);
  const command:Command={kind:'uploadScan',operationId,batchId,scanId,filename:text(body.filename),sha256:hash,signature:sig,image:body.image};
  for(let attempt=0;attempt<3;attempt++){
    const current=await readSnapshot();const batch=current.state.batches.find(b=>b.id===batchId);
    if(!batch||batch.catalogVersion!==version)throw new Error('Create the scanner batch first; catalog versions must agree.');
    const existing=current.state.scans.find(s=>s.id===scanId);
    if(existing){if(existing.batchId!==batchId||existing.sha256!==hash)throw new Error('This scan ID already represents different content.');return {scan:responseScan(existing),replayed:true};}
    if(batch.status!=='draft')throw new Error('Cloud batch is finalized. Create a new receiving batch.');
    try{
      if(body.manual===true){
        // Explicit human confirmations may be imported atomically. Native scores
        // are never accepted as authority for an automatic approval.
        const at=new Date().toISOString();let next=applyOperation(current.state,command,cards,actor(device),at,randomUUID,[],candidatePending);
        next=applyOperation(next,{kind:'approveScan',operationId:scannerOperation(device.id,body.localScanId,'human'),scanId,masterId:body.masterId,condition:batch.condition,duplicateAcknowledged:body.duplicateAcknowledged===true},cards,actor(device),at,randomUUID);
        const saved=await saveScannerState(current.revision,next,{id:scanId,base64});
        return {scan:responseScan(saved.state.scans.find(s=>s.id===scanId)!),replayed:false};
      }
      const saved=await executeWarehouse(command,current.revision,actor(device));
      return {scan:responseScan(saved.state.scans.find(s=>s.id===scanId)!),replayed:false};
    }catch(e){if(!(e instanceof ConflictError)||attempt===2)throw e;}
  }
  throw new Error('Warehouse changed; retry synchronization.');
}
