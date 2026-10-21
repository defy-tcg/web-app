import { NextRequest, NextResponse } from 'next/server';
import { isAllowedEmail } from '@/lib/auth/authorization';
import { authenticateScanner } from '@/lib/warehouse/scanner-auth';
import { permittedScannerAction, SCANNER_PROTOCOL } from '@/lib/warehouse/scanner-policy';
import { scannerManifest, scannerImage, createScannerBatch, syncScannerScan } from '@/lib/warehouse/scanner';
export const runtime='nodejs';
export const dynamic='force-dynamic';
export const maxDuration=300;
const headers={'Cache-Control':'private, no-store','X-Content-Type-Options':'nosniff'};
async function handle(request:NextRequest) {
  // This exact route has separate scoped bearer authentication. Cookie sessions
  // alone cannot call it; no permissive CORS or middleware bypass for other APIs.
  const origin=request.headers.get('origin');
  if((origin&&origin!==request.nextUrl.origin)||request.headers.get('sec-fetch-site')==='cross-site')return NextResponse.json({error:'Cross-site request rejected.'},{status:403,headers});
  try{
    const device=await authenticateScanner(request.headers.get('authorization'),isAllowedEmail);
    if(!device)return NextResponse.json({error:'Scanner key is missing, expired, revoked, or unauthorized.'},{status:401,headers});
    const action=request.nextUrl.searchParams.get('action')||'';
    if(!permittedScannerAction(action))return NextResponse.json({error:'Scanner scope does not allow this action.'},{status:403,headers});
    if(request.method==='GET'){
      if(action==='status')return NextResponse.json({protocol:SCANNER_PROTOCOL,deviceId:device.id,name:device.name,expiresAt:device.expires_at},{headers});
      if(action==='manifest')return NextResponse.json(await scannerManifest(device),{headers});
      if(action==='reference'||action==='learned-image'){
        const image=await scannerImage(action,request.nextUrl.searchParams.get('version')||'',request.nextUrl.searchParams.get('id')||'');
        const mime=image[0]===0x89?'image/png':image.subarray(0,4).toString()==='RIFF'?'image/webp':'image/jpeg';
        return new NextResponse(new Uint8Array(image),{headers:{...headers,'Content-Type':mime}});
      }
    }else if(request.method==='POST'){
      if(!request.headers.get('content-type')?.startsWith('application/json'))return NextResponse.json({error:'JSON required.'},{status:415,headers});
      if(Number(request.headers.get('content-length')||0)>3_500_000)return NextResponse.json({error:'Request too large.'},{status:413,headers});
      const raw=await request.text();if(Buffer.byteLength(raw)>3_500_000)return NextResponse.json({error:'Request too large.'},{status:413,headers});
      const body=JSON.parse(raw);if(!body||typeof body!=='object'||Array.isArray(body))throw new Error('Invalid scanner request.');
      if(action==='create-batch')return NextResponse.json(await createScannerBatch(device,body),{headers});
      if(action==='sync-scan')return NextResponse.json(await syncScannerScan(device,body),{headers});
    }
    return NextResponse.json({error:'Method not allowed for this action.'},{status:405,headers});
  }catch(error){
    const message=error instanceof Error?error.message:'Scanner request failed.';
    const safe=/password|postgres|SQL|connection|fetch failed|ECONN|relation/i.test(message)?'Warehouse storage is unavailable; local drafts are safe.':message.slice(0,300);
    return NextResponse.json({error:safe},{status:400,headers});
  }
}
export const GET=handle;
export const POST=handle;
