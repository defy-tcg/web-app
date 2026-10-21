import {neon} from '@neondatabase/serverless';
import {createHash} from 'node:crypto';
import {gzipSync,gunzipSync} from 'node:zlib';
import {eligible,finish,rankCandidates,type Card,type Batch,type State,type Scan,type Reference} from '../model.ts';
import {extractFeature,compareFeatures,probeSimilarity} from './engine.ts';
import {VISION_VERSION,detailApprovalReason,samePrinting,type DetailFeature,type VisionCandidate,type VisionDecision} from './policy.ts';
const hosts=new Set(['tcgplayer-cdn.tcgplayer.com','cmsassets.rgpub.io','static.dotgg.gg','openrift.app','www.cardtrader.com']);
function db(){const url=process.env.WAREHOUSE_DATABASE_URL||process.env.DATABASE_URL;if(!url)throw new Error('Warehouse database is not configured.');return neon(url);}
let initialized:Promise<void>|undefined;
export async function initializeVision(){if(!initialized)initialized=(async()=>{const sql=db();await sql`CREATE TABLE IF NOT EXISTS rift_warehouse.vision_assets (source_key text PRIMARY KEY, algorithm text NOT NULL, status text NOT NULL, summary jsonb, payload bytea, error text, updated_at timestamptz NOT NULL DEFAULT now())`;})().catch(e=>{initialized=undefined;throw e;});return initialized;}
const hash=(s:string)=>createHash('sha256').update(s).digest('hex');
export function sourceKey(card:Card){return hash(JSON.stringify([VISION_VERSION,'reference',card.image_url,card.front_asset||'',card.image_match||'',card.image_is_exact]));}
function scanKey(scan:Scan){return hash(JSON.stringify([VISION_VERSION,'scan-preview1600',scan.imageId]));}
function indexable(c:Card){return eligible(c)&&c.image_is_exact==='1'&&Boolean(c.image_url);}
type AssetRow={source_key:string;status:string;summary:{probe:string;quality:DetailFeature['quality']}|null};
export async function fetchReferenceBytes(urlString:string):Promise<Buffer>{
  const url=new URL(urlString);if(url.protocol!=='https:'||url.username||url.password||(url.port&&url.port!=='443')||!hosts.has(url.hostname))throw new Error('Reference host not permitted.');
  const response=await fetch(url,{redirect:'error',signal:AbortSignal.timeout(12000),cache:'no-store',headers:{Accept:'image/jpeg,image/png,image/webp'}});
  if(!response.ok||!['image/jpeg','image/png','image/webp'].includes(response.headers.get('content-type')?.split(';')[0]||''))throw new Error('Reference image unavailable.');
  if(Number(response.headers.get('content-length')||0)>3500000)throw new Error('Reference image too large.');const reader=response.body?.getReader();if(!reader)throw new Error('Empty reference image.');let size=0;const chunks:Uint8Array[]=[];
  while(true){const{done,value}=await reader.read();if(done)break;size+=value.length;if(size>3500000){await reader.cancel();throw new Error('Reference image too large.');}chunks.push(value);}return Buffer.concat(chunks);
}
const summaries=new Map<string,{until:number;rows:AssetRow[]}>();
async function readAssets(keys:string[],cacheKey?:string):Promise<AssetRow[]>{
  await initializeVision();const hit=cacheKey&&summaries.get(cacheKey);if(hit&&hit.until>Date.now())return hit.rows;
  const sql=db();const rows=await sql`SELECT source_key,status,summary FROM rift_warehouse.vision_assets WHERE algorithm=${VISION_VERSION} AND source_key IN (SELECT jsonb_array_elements_text(${JSON.stringify(keys)}::jsonb))` as AssetRow[];
  if(cacheKey){if(summaries.size>4)summaries.clear();summaries.set(cacheKey,{until:Date.now()+15000,rows});}return rows;
}
export async function storeFeature(key:string,feature:DetailFeature){
  await initializeVision();const payload=gzipSync(JSON.stringify(feature));const sql=db();
  await sql`INSERT INTO rift_warehouse.vision_assets(source_key,algorithm,status,summary,payload,error) VALUES(${key},${VISION_VERSION},'ready',${JSON.stringify({probe:feature.probe,quality:feature.quality,imageHash:feature.imageHash})}::jsonb,decode(${payload.toString('base64')},'base64'),NULL) ON CONFLICT(source_key) DO UPDATE SET status='ready',summary=excluded.summary,payload=excluded.payload,error=NULL,updated_at=now()`;summaries.clear();
}
const featureCache=new Map<string,DetailFeature>();
async function readFeature(key:string):Promise<DetailFeature|null>{
  const cached=featureCache.get(key);if(cached)return cached;const sql=db();const rows=await sql`SELECT encode(payload,'base64') AS bytes FROM rift_warehouse.vision_assets WHERE source_key=${key} AND algorithm=${VISION_VERSION} AND status='ready'`;
  if(!rows.length)return null;const feature=JSON.parse(gunzipSync(Buffer.from(String(rows[0].bytes),'base64'),{maxOutputLength:3000000}).toString()) as DetailFeature;
  if(feature.version!==VISION_VERSION||feature.points.length>1800||feature.width!==630||feature.height!==880||feature.cols!==61||Buffer.from(feature.probe,'base64').length!==1408||Buffer.from(feature.descriptors,'base64').length!==feature.points.length*feature.cols)throw new Error('Detailed index integrity check failed.');
  if(featureCache.size>=128)featureCache.delete(featureCache.keys().next().value!);featureCache.set(key,feature);return feature;
}
async function saveFailure(key:string){const sql=db();await sql`INSERT INTO rift_warehouse.vision_assets(source_key,algorithm,status,error) VALUES(${key},${VISION_VERSION},'failed','Source image unavailable or invalid') ON CONFLICT(source_key) DO UPDATE SET status='failed',error=excluded.error,updated_at=now() WHERE rift_warehouse.vision_assets.status<>'ready'`;summaries.clear();}
async function imageBytes(scan:Scan):Promise<Buffer>{const sql=db();const rows=await sql`SELECT encode(bytes,'base64') AS bytes FROM rift_warehouse.images WHERE id=${scan.imageId}`;if(!rows.length)throw new Error('Stored scan image unavailable.');return Buffer.from(String(rows[0].bytes),'base64');}
export async function featureForScan(scan:Scan,bytes?:Buffer):Promise<DetailFeature>{
  const key=scanKey(scan);const saved=await readFeature(key);if(saved)return saved;const feature=await extractFeature(bytes||await imageBytes(scan));await storeFeature(key,feature);return feature;
}
export async function detailedPlan(version:string,cards:Card[],state:State){
  const exact=cards.filter(indexable);const keys=[...new Set(exact.map(sourceKey))];const rows=await readAssets(keys,version);const byKey=new Map(rows.map(r=>[r.source_key,r]));
  const work=keys.filter(k=>!byKey.has(k)||byKey.get(k)!.status==='pending');const ready=exact.filter(c=>byKey.get(sourceKey(c))?.status==='ready').length;const failed=exact.filter(c=>byKey.get(sourceKey(c))?.status==='failed').length;
  const examples=state.learned.map(l=>state.scans.find(s=>s.id===l.scanId)).filter((s):s is Scan=>Boolean(s));const learnedKeys=[...new Set(examples.map(scanKey))];const learnedRows=await readAssets(learnedKeys);const finished=new Set(learnedRows.filter(r=>['ready','failed'].includes(r.status)).map(r=>r.source_key));const learnedWork=examples.filter(s=>!finished.has(scanKey(s)));
  return {version,algorithm:VISION_VERSION,total:cards.length,eligible:cards.filter(eligible).length,exact:exact.length,prepared:ready,failed,manualOnly:cards.filter(eligible).length-ready,pending:work.length,learnedPending:learnedWork.length,ready:work.length===0&&ready>0&&learnedWork.length===0,work,learnedWork};
}
export async function prepareDetailedStep(version:string,cards:Card[],state:State){
  const plan=await detailedPlan(version,cards,state);const groups=new Map(cards.filter(indexable).map(c=>[sourceKey(c),c]));
  // Small idempotent steps survive serverless timeouts and browser refresh; no detached work.
  for(const key of plan.work.slice(0,3)){try{await storeFeature(key,await extractFeature(await fetchReferenceBytes(groups.get(key)!.image_url)));}catch{await saveFailure(key);}}
  if(!plan.work.length)for(const scan of plan.learnedWork.slice(0,3)){try{await featureForScan(scan);}catch{await saveFailure(scanKey(scan));}}
  return publicPlan(await detailedPlan(version,cards,state));
}
export function publicPlan(plan:Awaited<ReturnType<typeof detailedPlan>>){const{work,learnedWork,...summary}=plan;void work;void learnedWork;return summary;}
export async function retryDetailedFailures(cards:Card[]){await initializeVision();const sql=db();const keys=[...new Set(cards.filter(indexable).map(sourceKey))];await sql`UPDATE rift_warehouse.vision_assets SET status='pending',error=NULL,updated_at=now() WHERE status='failed' AND source_key IN (SELECT jsonb_array_elements_text(${JSON.stringify(keys)}::jsonb))`;summaries.clear();return{scheduled:true};}
export async function recognizeDetailed(version:string,cards:Card[],state:State,batch:Batch,scan:Scan,legacyRefs:Reference[],readCatalog:(version:string)=>Promise<{cards:Card[]}>,bytes?:Buffer):Promise<VisionDecision>{
  const start=Date.now();const plan=await detailedPlan(version,cards,state);const query=await featureForScan(scan,bytes);
  let legacy=scan.signature?rankCandidates(scan.signature,cards,legacyRefs,batch,state.learned):[];
  const compatibleLearned: State['learned'] = [];
  if(plan.pending>0||plan.prepared===0)return{version:VISION_VERSION,candidates:[],reviewReason:'Detailed reference index is still preparing. This scan is saved for review.',quality:query.quality,complete:false,examined:0,elapsedMs:Date.now()-start};
  const pool=cards.filter(c=>eligible(c)&&finish(c.finish)===batch.finish&&c.language===batch.language);const allowed=new Map(pool.map(c=>[c.master_id,c]));
  const references=pool.filter(indexable);const rows=await readAssets([...new Set(references.map(sourceKey))],version+':'+batch.finish+':'+batch.language);const byKey=new Map(rows.map(r=>[r.source_key,r]));
  type Entry={key:string;ids:string[];evidence:'reference'|'human';probe:string;retrieval:number};const groups=new Map<string,Entry>();
  for(const card of references){const key=sourceKey(card),row=byKey.get(key);if(row?.status!=='ready'||!row.summary)continue;const prior=groups.get(key);if(prior)prior.ids.push(card.master_id);else groups.set(key,{key,ids:[card.master_id],evidence:'reference',probe:row.summary.probe,retrieval:probeSimilarity(query.probe,row.summary.probe)});}
  for(const label of state.learned){if(label.scanId===scan.id||label.finish!==batch.finish||label.language!==batch.language||!allowed.has(label.masterId))continue;const original=state.scans.find(s=>s.id===label.scanId);if(!original)continue;
    const old=label.catalogVersion===version?allowed.get(label.masterId):(await readCatalog(label.catalogVersion)).cards.find(c=>c.master_id===label.masterId);if(!old||!samePrinting(old,allowed.get(label.masterId)!))continue;compatibleLearned.push({...label,catalogVersion:version});
    try{const feature=await featureForScan(original);const key=scanKey(original);const prior=groups.get(key);if(prior){if(!prior.ids.includes(label.masterId))prior.ids.push(label.masterId);}else groups.set(key,{key,ids:[label.masterId],evidence:'human',probe:feature.probe,retrieval:probeSimilarity(query.probe,feature.probe)});}catch{/* Missing saved examples stay unavailable, not guessed. */}
  }
  if(scan.signature) legacy=rankCandidates(scan.signature,cards,legacyRefs,batch,compatibleLearned);
  const ranked=[...groups.values()].sort((a,b)=>b.retrieval-a.retrieval);const initial=ranked.slice(0,96);const names=new Set([...initial.flatMap(e=>e.ids.map(id=>allowed.get(id)!.card_name)),...legacy.map(c=>allowed.get(c.masterId)?.card_name||'')]);const selected=ranked.filter(e=>initial.includes(e)||e.ids.some(id=>names.has(allowed.get(id)!.card_name)||legacy.some(l=>l.masterId===id)));
  const bestById=new Map<string,VisionCandidate>();let examined=0,complete=true;
  for(const entry of selected){const feature=await readFeature(entry.key);if(!feature){complete=false;continue;}let detail;try{detail=await compareFeatures(query,feature);}catch{complete=false;continue;}examined++;if(detail.inliers<4)continue;
    for(const id of entry.ids){const candidate:VisionCandidate={masterId:id,score:legacy.find(c=>c.masterId===id)?.score||0,evidence:entry.evidence,detail,referenceKey:entry.key};const previous=bestById.get(id);if(!previous||detail.score>previous.detail.score||(detail.score===previous.detail.score&&entry.evidence==='human'))bestById.set(id,candidate);}
  }
  const candidates=[...bestById.values()].sort((a,b)=>Number(b.detail.identityVerified)-Number(a.detail.identityVerified)||b.detail.score-a.detail.score||b.detail.inliers-a.detail.inliers||a.masterId.localeCompare(b.masterId)).slice(0,5);
  const top=candidates[0];const entry=top&&groups.get(top.referenceKey);let reason=detailApprovalReason(candidates,complete,query.quality,legacy[0]?.masterId,Boolean(entry&&entry.ids.length>1));
  // A missing same-name printing could otherwise look indistinguishable from a covered one.
  if(!reason&&top){const name=allowed.get(top.masterId)!.card_name;const covered=new Set([...groups.values()].flatMap(e=>e.ids));if(pool.some(c=>c.card_name===name&&!covered.has(c.master_id)))reason='A related printing has no usable exact reference. Confirm the variant manually.';}
  return{version:VISION_VERSION,candidates,reviewReason:reason,quality:query.quality,complete,examined,elapsedMs:Date.now()-start};
}
