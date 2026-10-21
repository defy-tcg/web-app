'use client';
import type { Scan } from '@/lib/warehouse/model';
export default function RecognitionEvidence({scan}:{scan:Scan}){
  if(!scan.vision)return null;
  const detail=scan.candidates[0]?.detail;
  return <section className="rw-index-status" aria-label="Detailed recognition evidence">
    <strong>Detailed feature verification</strong>
    <p>{scan.vision.reviewReason || 'Artwork alignment and the visible printing regions passed the current checks.'}</p>
    {detail&&<p>{detail.inliers} aligned keypoints of {detail.matches} distinctive matches · {(detail.coverage*100).toFixed(0)}% spatial coverage.<br/>
      Artwork {detail.artwork.toFixed(3)} · Name band {detail.title.toFixed(3)} · Footer {detail.footer.toFixed(3)}.</p>}
    <small>{scan.vision.examined} reference images compared · {(scan.vision.elapsedMs/1000).toFixed(1)} seconds · {scan.vision.quality?.crop || 'Crop unavailable'}. Scores measure visual agreement, not probability or authenticity.</small>
  </section>;
}
