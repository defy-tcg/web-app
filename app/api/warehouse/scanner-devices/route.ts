import { NextRequest, NextResponse } from 'next/server';
import { getAuthorizedSession } from '@/lib/auth/authorization';
import { createScannerDevice,listScannerDevices,revokeScannerDevice } from '@/lib/warehouse/scanner-auth';
export const runtime='nodejs';export const dynamic='force-dynamic';
const headers={'Cache-Control':'private, no-store'};
export async function GET(){const session=await getAuthorizedSession();if(!session)return NextResponse.json({error:'Sign in first.'},{status:401,headers});try{return NextResponse.json({devices:await listScannerDevices(session.user.id)},{headers});}catch{return NextResponse.json({error:'Scanner connections could not be loaded.'},{status:500,headers});}}
export async function POST(request:NextRequest){
 const session=await getAuthorizedSession();if(!session)return NextResponse.json({error:'Sign in first.'},{status:401,headers});
 if(request.headers.get('origin')!==request.nextUrl.origin||request.headers.get('sec-fetch-site')==='cross-site')return NextResponse.json({error:'Same-origin confirmation required.'},{status:403,headers});
 if(!request.headers.get('content-type')?.startsWith('application/json'))return NextResponse.json({error:'JSON required.'},{status:415,headers});
 try{const raw=await request.text();if(Buffer.byteLength(raw)>4000)throw new Error('Request too large.');const body=JSON.parse(raw);
  if(body.action==='revoke'){await revokeScannerDevice(session.user.id,String(body.id));return NextResponse.json({revoked:true},{headers});}
  if(body.action!=='create'&&body.action!=='renew')throw new Error('Unsupported action.');
  return NextResponse.json(await createScannerDevice(session.user.id,session.user.email||'',String(body.name||''),body.action==='renew'?String(body.id):undefined),{headers});
 }catch{return NextResponse.json({error:'Device change failed. Check the name and device ownership; a maximum of 10 active keys is allowed.'},{status:400,headers});}
}
