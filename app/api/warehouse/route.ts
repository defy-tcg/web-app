import { NextRequest, NextResponse } from 'next/server';
import { getAuthorizedSession } from '@/lib/auth/authorization';
import { ConflictError, executeWarehouse, readCatalog, readImage, readSnapshot, referenceIds, release, saveReference } from '@/lib/warehouse/store';
import { AUTO_APPROVAL_CALIBRATED, AUTO_APPROVAL_THRESHOLD, integer, text, type Command } from '@/lib/warehouse/model';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;
const headers = { 'Cache-Control': 'private, no-store' };
export async function GET(request: NextRequest) {
 if (!await getAuthorizedSession()) return NextResponse.json({ error: 'Sign in with an authorized Defy account.' }, { status: 401, headers });
 try { const q=request.nextUrl.searchParams;
  if(q.has('image')){const image=await readImage(q.get('image')!);if(!image)return new NextResponse(null,{status:404});return new NextResponse(new Uint8Array(image.bytes),{headers:{...headers,'Content-Type':image.mime,'X-Content-Type-Options':'nosniff'}});}
  if(q.has('catalog'))return NextResponse.json(await readCatalog(q.get('catalog')!),{headers});
  if(q.has('references'))return NextResponse.json({ids:await referenceIds(q.get('references')!)},{headers});
  return NextResponse.json({...await readSnapshot(),release,policy:{threshold:AUTO_APPROVAL_THRESHOLD,calibrated:AUTO_APPROVAL_CALIBRATED,message:'Visual scores are advisory. Manual confirmation is required until this matcher is calibrated.'}},{headers});
 }catch{console.error('Warehouse read failed.');return NextResponse.json({error:'Warehouse data could not be loaded. Retry or check the isolated warehouse database setup.'},{status:500,headers});}
}
export async function POST(request: NextRequest) {
 const session=await getAuthorizedSession();if(!session)return NextResponse.json({error:'Sign in with an authorized Defy account.'},{status:401,headers});
 const origin=request.headers.get('origin');if((origin&&origin!==request.nextUrl.origin)||request.headers.get('sec-fetch-site')==='cross-site')return NextResponse.json({error:'Cross-site write rejected.'},{status:403,headers});
 if(!request.headers.get('content-type')?.startsWith('application/json'))return NextResponse.json({error:'Expected JSON.'},{status:415,headers});
 try{if(Number(request.headers.get('content-length')||'0')>4000000)return NextResponse.json({error:'Request is too large.'},{status:413,headers});const raw=await request.text();if(Buffer.byteLength(raw)>4000000)return NextResponse.json({error:'Use the compact Sorting Catalog CSV or a smaller scan.'},{status:413,headers});const body=JSON.parse(raw);if(!body||typeof body!=='object'||Array.isArray(body))throw new Error('Invalid request.');
  if(body.kind==='saveReference')return NextResponse.json(await saveReference(text(body.catalogVersion,64),text(body.masterId,200),body.signature),{headers});
  text(body.operationId,100);text(body.kind,100);const revision=integer(body.expectedRevision,0,2000000000);return NextResponse.json(await executeWarehouse(body as Command,revision,session.user.email||session.user.id),{headers});
 }catch(error){if(error instanceof ConflictError)return NextResponse.json({error:error.message},{status:409,headers});const message=error instanceof Error?error.message:'Warehouse operation failed.';console.error('Warehouse operation failed.');const safe=/database|password|postgres|relation|column|SQL|connection|fetch failed|ECONN/i.test(message)?'Warehouse storage is unavailable. Refresh before retrying.':message.slice(0,300);return NextResponse.json({error:safe},{status:400,headers});}
}
