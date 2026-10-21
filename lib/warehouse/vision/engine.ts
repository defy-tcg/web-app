/* eslint-disable @typescript-eslint/no-explicit-any -- OpenCV's generated WASM bindings differ from its published declarations. All boundary values are validated here. */
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { WIDTH as W, HEIGHT as H, PROBE_W, PROBE_H, VISION_VERSION, verifyEvidence, type DetailFeature, type GeometricEvidence } from './policy.ts';
const require = createRequire(path.join(process.cwd(), 'lib/warehouse/vision/runtime/package.json'));
const sharp: typeof import('sharp') = require('sharp');
let runtime: Promise<{cv:any}> | undefined;
export function openCv():Promise<{cv:any}> {
  if(!runtime) runtime = new Promise<{cv:any}>((resolve,reject)=>{
    const timer=setTimeout(()=>reject(new Error('Detailed recognition runtime timed out.')),20000);
    const ready=(cv:any)=>{clearTimeout(timer); if(!cv.AKAZE || !cv.findHomography) reject(new Error('Required feature matcher unavailable.')); else resolve({cv});};
    try {const mod=require('@techstark/opencv-js'); if(mod.Mat)ready(mod);else if(mod instanceof Promise)mod.then(ready,reject);else mod.onRuntimeInitialized=()=>ready(mod);}catch(e){clearTimeout(timer);reject(e);}
  }).catch(e=>{runtime=undefined;throw e;});
  return runtime!;
}
function destroy(...objects:any[]) { for(const o of objects) if(o && typeof o.delete==='function')o.delete(); }
function matrix(cv:any, bytes:Uint8Array,width:number,height:number) {return cv.matFromArray(height,width,cv.CV_8UC1,bytes);}
function area(points:number[][]):number {let sum=0;for(let i=0;i<points.length;i++){const p=points[i],q=points[(i+1)%points.length];sum+=p[0]*q[1]-q[0]*p[1];}return Math.abs(sum)/2;}
function ordered(points:number[][]):number[][] {
  const cx=points.reduce((s,p)=>s+p[0],0)/4,cy=points.reduce((s,p)=>s+p[1],0)/4;
  const ring=[...points].sort((a,b)=>Math.atan2(a[1]-cy,a[0]-cx)-Math.atan2(b[1]-cy,b[0]-cx));
  const start=ring.reduce((best,p,i)=>p[0]+p[1]<ring[best][0]+ring[best][1]?i:best,0);
  return ring.slice(start).concat(ring.slice(0,start));
}
function normalize(cv:any,source:any):{gray:any;crop:string;aspectValid:boolean} {
  const edges=new cv.Mat(),blur=new cv.Mat(),contours=new cv.MatVector(),hierarchy=new cv.Mat();
  let corners:number[][]|null=null,best=0;
  try {
    cv.GaussianBlur(source,blur,new cv.Size(5,5),0);cv.Canny(blur,edges,35,110);cv.findContours(edges,contours,hierarchy,cv.RETR_LIST,cv.CHAIN_APPROX_SIMPLE);
    for(let i=0;i<contours.size();i++){
      const c=contours.get(i),approx=new cv.Mat();
      try{cv.approxPolyDP(c,approx,.02*cv.arcLength(c,true),true);if(approx.rows!==4 || !cv.isContourConvex(approx))continue;
        const pts=ordered(Array.from({length:4},(_,j)=>[approx.data32S[j*2],approx.data32S[j*2+1]]));
        const size=area(pts)/(source.cols*source.rows);if(size<.55||size>1.01)continue;
        const len=(a:number[],b:number[])=>Math.hypot(a[0]-b[0],a[1]-b[1]);const ratio=(len(pts[0],pts[1])+len(pts[3],pts[2]))/(len(pts[0],pts[3])+len(pts[1],pts[2]));
        if(!((ratio>.60&&ratio<.83)||(ratio>1.20&&ratio<1.68)))continue;
        if(size>best){best=size;corners=ratio>1? [pts[1],pts[2],pts[3],pts[0]]:pts;}
      }finally{destroy(c,approx);}
    }
    const output=new cv.Mat();
    if(corners){const src=cv.matFromArray(4,1,cv.CV_32FC2,corners.flat()),dst=cv.matFromArray(4,1,cv.CV_32FC2,[0,0,W-1,0,W-1,H-1,0,H-1]);const transform=cv.getPerspectiveTransform(src,dst);try{cv.warpPerspective(source,output,transform,new cv.Size(W,H),cv.INTER_LINEAR,cv.BORDER_REPLICATE);}finally{destroy(src,dst,transform);}return{gray:output,crop:'quadrilateral',aspectValid:true};}
    const aspect=Math.min(source.cols,source.rows)/Math.max(source.cols,source.rows);let upright=source;const rotated=new cv.Mat();
    try{if(source.cols>source.rows){cv.rotate(source,rotated,cv.ROTATE_90_CLOCKWISE);upright=rotated;}cv.resize(upright,output,new cv.Size(W,H),0,0,cv.INTER_AREA);}finally{destroy(rotated);}
    return{gray:output,crop:'full-frame',aspectValid:aspect>=.65&&aspect<=.79};
  }finally{destroy(edges,blur,contours,hierarchy);}
}
export async function extractFeature(bytes:Buffer):Promise<DetailFeature> {
  if(bytes.length<32||bytes.length>12_000_000)throw new Error('Invalid recognition image size.');
  const meta=await sharp(bytes,{limitInputPixels:24_000_000,failOn:'error'}).metadata();
  if(!meta.width||!meta.height||meta.width<80||meta.height<80)throw new Error('Image is too small for detailed recognition.');
  const decoded=await sharp(bytes,{limitInputPixels:24_000_000}).rotate().flatten({background:'#fff'}).resize({width:1400,height:1400,fit:'inside',withoutEnlargement:true}).greyscale().raw().toBuffer({resolveWithObject:true});
  const {cv}=await openCv();const source=matrix(cv,decoded.data,decoded.info.width,decoded.info.height);
  let gray:any,keypoints:any,descriptors:any,detector:any,enhanced:any,clahe:any,mask:any,lap:any;
  try{
    const norm=normalize(cv,source);gray=norm.gray;enhanced=new cv.Mat();clahe=new cv.CLAHE(2,new cv.Size(8,8));clahe.apply(gray,enhanced);
    keypoints=new cv.KeyPointVector();descriptors=new cv.Mat();detector=new cv.AKAZE();mask=new cv.Mat();detector.detectAndCompute(enhanced,mask,keypoints,descriptors);
    // Response-sorted cap keeps storage bounded; geometry still covers the full card.
    const ids=Array.from({length:keypoints.size()},(_,i)=>i).sort((a,b)=>keypoints.get(b).response-keypoints.get(a).response).slice(0,1800);
    const cols=descriptors.cols||61, selected=Buffer.alloc(ids.length*cols),points:number[][]=[];
    ids.forEach((id,i)=>{const p=keypoints.get(id).pt;points.push([Math.round(p.x*100)/100,Math.round(p.y*100)/100]);selected.set(descriptors.data.subarray(id*cols,(id+1)*cols),i*cols);});
    lap=new cv.Mat();cv.Laplacian(gray,lap,cv.CV_32F);let sum=0,sum2=0;for(const x of lap.data32F){sum+=x;sum2+=x*x;}const sharpness=sum2/lap.data32F.length-(sum/lap.data32F.length)**2;
    const pixels=Buffer.from(gray.data);const [jpeg,probe]=await Promise.all([sharp(pixels,{raw:{width:W,height:H,channels:1}}).jpeg({quality:94}).toBuffer(),sharp(pixels,{raw:{width:W,height:H,channels:1}}).resize(PROBE_W,PROBE_H,{fit:'fill'}).greyscale().raw().toBuffer()]);
    return{version:VISION_VERSION,width:W,height:H,cols,points,descriptors:selected.toString('base64'),grayJpeg:jpeg.toString('base64'),probe:probe.toString('base64'),imageHash:createHash('sha256').update(bytes).digest('hex'),quality:{sourceWidth:Math.min(meta.width,meta.height),sourceHeight:Math.max(meta.width,meta.height),crop:norm.crop,aspectValid:norm.aspectValid,sharpness:Math.round(sharpness*100)/100,keypoints:ids.length}};
  }finally{destroy(source,gray,keypoints,descriptors,detector,enhanced,clahe,mask,lap);}
}
function correlation(a:Uint8Array,b:Uint8Array,w:number,h:number,region:number[],rotate=false):number{
  let n=0,sa=0,sb=0,saa=0,sbb=0,sab=0;
  const [x0,y0,x1,y1]=region;for(let y=Math.ceil(y0*h);y<Math.floor(y1*h);y++)for(let x=Math.ceil(x0*w);x<Math.floor(x1*w);x++){
    const i=y*w+x,j=rotate?(h-1-y)*w+w-1-x:i;const av=a[i],bv=b[j];n++;sa+=av;sb+=bv;saa+=av*av;sbb+=bv*bv;sab+=av*bv;
  }
  const denominator=Math.sqrt(Math.max(0,(saa-sa*sa/n)*(sbb-sb*sb/n)));return denominator<1e-5?0:Math.max(0,Math.min(1,(sab-sa*sb/n)/denominator));
}
export function probeSimilarity(scan:string,reference:string):number {
  const a=Buffer.from(scan,'base64'),b=Buffer.from(reference,'base64');if(a.length!==PROBE_W*PROBE_H||b.length!==a.length)return 0;
  return Math.max(...[false,true].map(r=>.70*correlation(a,b,PROBE_W,PROBE_H,[.08,.12,.92,.52],r)+.30*correlation(a,b,PROBE_W,PROBE_H,[.04,.04,.96,.98],r)));
}
function project(h:number[],x:number,y:number):number[]{const d=h[6]*x+h[7]*y+h[8];return[(h[0]*x+h[1]*y+h[2])/d,(h[3]*x+h[4]*y+h[5])/d];}
export async function compareFeatures(query:DetailFeature,reference:DetailFeature):Promise<GeometricEvidence>{
  const empty=()=>verifyEvidence({matches:0,inliers:0,inlierRatio:0,coverage:0,artwork:0,title:0,footer:0,score:0,geometry:false});
  if(query.version!==VISION_VERSION||reference.version!==VISION_VERSION||query.cols!==reference.cols||query.points.length<8||reference.points.length<8)return empty();
  const {cv}=await openCv();let q:any,r:any,matches:any,reverseMatches:any,matcher:any,src:any,dst:any,inlierMask:any,transform:any,grayQ:any,grayR:any,aligned:any,softQ:any,softR:any;
  try{
    q=cv.matFromArray(query.points.length,query.cols,cv.CV_8UC1,Buffer.from(query.descriptors,'base64'));r=cv.matFromArray(reference.points.length,reference.cols,cv.CV_8UC1,Buffer.from(reference.descriptors,'base64'));
    matcher=new cv.BFMatcher(cv.NORM_HAMMING,false);matches=new cv.DMatchVectorVector();matcher.knnMatch(q,r,matches,2);
    reverseMatches=new cv.DMatchVectorVector();matcher.knnMatch(r,q,reverseMatches,2);
    const reverse=new Map<number,number>();
    for(let i=0;i<reverseMatches.size();i++){const pair=reverseMatches.get(i);try{if(pair.size()<2)continue;const a=pair.get(0),b=pair.get(1);if(a.distance<.72*b.distance&&a.distance<=100)reverse.set(a.queryIdx,a.trainIdx);}finally{pair.delete();}}
    const unique=new Map<number,{queryIdx:number;trainIdx:number;distance:number}>();
    for(let i=0;i<matches.size();i++){const pair=matches.get(i);try{if(pair.size()<2)continue;const a=pair.get(0),b=pair.get(1);if(a.distance>=.72*b.distance||a.distance>100||reverse.get(a.trainIdx)!==a.queryIdx)continue;const previous=unique.get(a.trainIdx);if(!previous||a.distance<previous.distance)unique.set(a.trainIdx,{queryIdx:a.queryIdx,trainIdx:a.trainIdx,distance:a.distance});}finally{pair.delete();}}
    const good=[...unique.values()];if(good.length<10)return empty();
    src=cv.matFromArray(good.length,1,cv.CV_32FC2,good.flatMap(m=>query.points[m.queryIdx]));dst=cv.matFromArray(good.length,1,cv.CV_32FC2,good.flatMap(m=>reference.points[m.trainIdx]));inlierMask=new cv.Mat();
    transform=cv.findHomography(src,dst,cv.RANSAC,3,inlierMask,3000,.995);if(transform.empty())return empty();
    const h=Array.from(transform.data64F) as number[],corners=[[0,0],[W-1,0],[W-1,H-1],[0,H-1]].map(([x,y])=>project(h,x,y));
    const size=area(corners)/(W*H),geometry=corners.every(p=>p.every(Number.isFinite)&&p[0]>-.15*W&&p[0]<1.15*W&&p[1]>-.15*H&&p[1]<1.15*H)&&size>.72&&size<1.32;
    let inliers=0,artInliers=0;const cells=new Set<number>();for(let i=0;i<good.length;i++)if(inlierMask.data[i]){inliers++;const[x,y]=reference.points[good[i].trainIdx];cells.add(Math.min(3,Math.floor(x/W*4))+4*Math.min(4,Math.floor(y/H*5)));if(x>.07*W&&x<.93*W&&y>.12*H&&y<.53*H)artInliers++;}
    if(!geometry||artInliers<8)return verifyEvidence({matches:good.length,inliers,inlierRatio:inliers/good.length,coverage:cells.size/20,artwork:0,title:0,footer:0,score:0,geometry:false});
    const [qb,rb]=await Promise.all([sharp(Buffer.from(query.grayJpeg,'base64')).greyscale().raw().toBuffer(),sharp(Buffer.from(reference.grayJpeg,'base64')).greyscale().raw().toBuffer()]);grayQ=matrix(cv,qb,W,H);grayR=matrix(cv,rb,W,H);aligned=new cv.Mat();softQ=new cv.Mat();softR=new cv.Mat();
    cv.warpPerspective(grayQ,aligned,transform,new cv.Size(W,H),cv.INTER_LINEAR,cv.BORDER_CONSTANT,new cv.Scalar(255));cv.GaussianBlur(aligned,softQ,new cv.Size(3,3),.6);cv.GaussianBlur(grayR,softR,new cv.Size(3,3),.6);
    const artwork=correlation(softQ.data,softR.data,W,H,[.08,.13,.92,.52]);const title=correlation(softQ.data,softR.data,W,H,[.08,.54,.92,.64]);const footer=correlation(softQ.data,softR.data,W,H,[.035,.93,.965,.988]);
    const ratio=inliers/good.length,coverage=cells.size/20;
    const score=.45*artwork+.20*title+.20*footer+.10*ratio+.05*Math.min(1,coverage/.6);
    const evidence = verifyEvidence({matches:good.length,inliers,inlierRatio:ratio,coverage,artwork,title,footer,score,geometry});
    if(reference.quality.sourceWidth<300 || reference.quality.sourceHeight<400 || reference.quality.sharpness<12) { evidence.printingVerified=false; evidence.reason='Reference image lacks enough detail to verify this printing.'; }
    return evidence;
  }finally{destroy(q,r,matches,reverseMatches,matcher,src,dst,inlierMask,transform,grayQ,grayR,aligned,softQ,softR);}
}
