import { NextRequest, NextResponse } from 'next/server';
import { getAuthorizedSession } from '@/lib/auth/authorization';
import { initializeWarehouse, readCatalog } from '@/lib/warehouse/store';
export const runtime='nodejs';
export const dynamic='force-dynamic';
const allowedHosts=new Set(['tcgplayer-cdn.tcgplayer.com','cmsassets.rgpub.io','static.dotgg.gg','openrift.app','www.cardtrader.com']);
export async function GET(request:NextRequest){
 if(!await getAuthorizedSession())return new NextResponse(null,{status:401});
 try{
  await initializeWarehouse();const {cards}=await readCatalog(request.nextUrl.searchParams.get('version')||'');const card=cards.find(c=>c.master_id===request.nextUrl.searchParams.get('id'));if(!card?.image_url)return new NextResponse(null,{status:404});
  const url=new URL(card.image_url);if(url.protocol!=='https:'||url.username||url.password||(url.port&&url.port!=='443')||!allowedHosts.has(url.hostname))return new NextResponse('Image host not permitted.',{status:400});
  const response=await fetch(url,{redirect:'error',signal:AbortSignal.timeout(10000),cache:'no-store',headers:{Accept:'image/jpeg,image/png,image/webp'}});const mime=response.headers.get('content-type')?.split(';')[0];
  if(!response.ok||!['image/jpeg','image/png','image/webp'].includes(mime||'')||Number(response.headers.get('content-length')||'0')>8_000_000)return new NextResponse(null,{status:502});
  const reader=response.body?.getReader();if(!reader)return new NextResponse(null,{status:502});const chunks:Uint8Array[]=[];let total=0;
  while(true){const {value,done}=await reader.read();if(done)break;total+=value.byteLength;if(total>8_000_000){await reader.cancel();return new NextResponse(null,{status:413});}chunks.push(value);}
  return new NextResponse(new Uint8Array(Buffer.concat(chunks)),{headers:{'Content-Type':mime!,'X-Content-Type-Options':'nosniff','Cache-Control':'private, max-age=3600'}});
 }catch{return new NextResponse('Reference image unavailable.',{status:502});}
}
