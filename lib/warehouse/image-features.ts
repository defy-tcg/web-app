import { FEATURE_ALGORITHM, type Signature } from './model.ts';

/** Keep the existing browser preprocessing: reference and scan grids use identical code. */
export async function features(blob: Blob): Promise<Signature> {
  const bitmap = await createImageBitmap(blob);
  try {
    const canvas = document.createElement('canvas'); canvas.width = 8; canvas.height = 8;
    const context = canvas.getContext('2d', { willReadFrequently: true });
    if (!context) throw new Error('Image processing is unavailable in this browser.');
    context.fillStyle = '#fff'; context.fillRect(0, 0, 8, 8); context.drawImage(bitmap, 0, 0, 8, 8);
    const pixels = context.getImageData(0, 0, 8, 8).data; const values: number[] = [];
    for (let i = 0; i < pixels.length; i += 4) values.push(pixels[i], pixels[i + 1], pixels[i + 2]);
    return { algorithm: FEATURE_ALGORITHM, values };
  } finally { bitmap.close(); }
}
