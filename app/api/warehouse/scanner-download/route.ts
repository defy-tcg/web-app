import { NextResponse } from 'next/server';
import { getAuthorizedSession } from '@/lib/auth/authorization';
import { buildScannerPackage } from '@/lib/warehouse/scanner-package';
export const runtime='nodejs';export const dynamic='force-dynamic';
export async function GET(){
 if(!await getAuthorizedSession())return NextResponse.json({error:'Sign in first.'},{status:401});
 try{return new NextResponse(new Uint8Array(await buildScannerPackage()),{headers:{'Content-Type':'application/zip','Content-Disposition':'attachment; filename="rift-warehouse-scanner-0.1.0.zip"','Cache-Control':'private, no-store','X-Content-Type-Options':'nosniff'}});}
 catch{return NextResponse.json({error:'Scanner source package is unavailable.'},{status:503});}
}
