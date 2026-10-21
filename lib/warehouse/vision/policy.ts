/** Version every image-dependent setting. Never reuse an 8x8 signature as a detailed feature. */
export const VISION_VERSION = 'rw-akaze-ransac-630-v1';
export const VISION_POLICY = 'legacy90-and-geometric-detail-v1';
export const WIDTH = 630;
export const HEIGHT = 880;
export const PROBE_W = 32;
export const PROBE_H = 44;
export type FeatureQuality = { sourceWidth: number; sourceHeight: number; crop: string; aspectValid: boolean; sharpness: number; keypoints: number };
export type DetailFeature = { version: string; width: number; height: number; cols: number; points: number[][]; descriptors: string; grayJpeg: string; probe: string; quality: FeatureQuality; imageHash: string };
export type GeometricEvidence = { version: string; matches: number; inliers: number; inlierRatio: number; coverage: number; artwork: number; title: number; footer: number; score: number; geometry: boolean; identityVerified: boolean; printingVerified: boolean; reason: string };
export type VisionCandidate = { masterId: string; score: number; evidence: 'reference' | 'human'; detail: GeometricEvidence; referenceKey: string };
export type VisionDecision = { version: string; candidates: VisionCandidate[]; reviewReason: string | null; quality?: FeatureQuality; complete: boolean; examined: number; elapsedMs: number };
/** Conservative gates are evidence thresholds, not calibrated probabilities. */
export function verifyEvidence(e: Omit<GeometricEvidence,'version'|'identityVerified'|'printingVerified'|'reason'>): GeometricEvidence {
  const finite = [e.matches,e.inliers,e.inlierRatio,e.coverage,e.artwork,e.title,e.footer,e.score].every(Number.isFinite);
  const identityVerified = finite && e.geometry && e.inliers >= 18 && e.inlierRatio >= .55 && e.coverage >= .20 && e.artwork >= .72;
  const printingVerified = identityVerified && e.inliers >= 28 && e.inlierRatio >= .65 && e.coverage >= .30 && e.artwork >= .84 && e.title >= .82 && e.footer >= .80;
  return {...e, version: VISION_VERSION, identityVerified, printingVerified,
    reason: !identityVerified ? 'Insufficient aligned artwork evidence; review or rescan.' : !printingVerified ? 'Artwork found; small printing details still need human verification.' : 'Artwork, geometry, name band and footer agree.'};
}
export function detailApprovalReason(candidates: VisionCandidate[], complete: boolean, quality: FeatureQuality, legacyBestId: string | undefined, sharedImage: boolean): string | null {
  const best=candidates[0];
  if(!complete) return 'Detailed reference preparation is incomplete. No automatic approval.';
  if(!quality.aspectValid || quality.sourceWidth<300 || quality.sourceHeight<400 || quality.sharpness<12 || quality.keypoints<40) return 'Scan quality is insufficient for automatic approval; check crop, focus and full card edges.';
  if(!best?.detail.printingVerified) return best?.detail.reason || 'No geometrically verified card match.';
  if(sharedImage) return 'Multiple exact printings share the same reference image. Confirm the printing manually.';
  if(candidates[1] && best.detail.score-candidates[1].detail.score<.035) return 'The best two detailed matches are too close. Confirm the exact printing.';
  if(best.masterId!==legacyBestId) return 'Detailed features and the legacy 90% matcher disagree. Human confirmation required.';
  return null;
}
/** Only inherit a human label if the immutable printing identity still agrees. */
export function samePrinting(a:Record<string,string>,b:Record<string,string>):boolean {
  return ['master_id','card_name','set_code','collector_number','finish','language','printing_type','promo_event','markings','physical_key'].every(k=>(a[k]||'')===(b[k]||''));
}
