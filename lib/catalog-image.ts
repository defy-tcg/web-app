const TCGPLAYER_IMAGE_HOST = "tcgplayer-cdn.tcgplayer.com";
const TCGPLAYER_PAGE_HOSTS = new Set([
  "tcgplayer.com",
  "www.tcgplayer.com",
  "store.tcgplayer.com",
]);

function httpsUrl(source: string | null | undefined) {
  if (!source) return null;
  try {
    const url = new URL(source);
    return url.protocol === "https:" ? url : null;
  } catch {
    return null;
  }
}

export function tcgplayerProductIdFromUrl(source: string | null | undefined) {
  const url = httpsUrl(source);
  if (!url || !TCGPLAYER_PAGE_HOSTS.has(url.hostname.toLowerCase())) return null;
  const match = url.pathname.match(/\/product\/(\d+)/i);
  const productId = Number(match?.[1]);
  return Number.isSafeInteger(productId) && productId > 0 ? productId : null;
}

export function directProductImageUrl(source: string | null | undefined) {
  const url = httpsUrl(source);
  if (!url) return null;
  if (TCGPLAYER_PAGE_HOSTS.has(url.hostname.toLowerCase())) return null;
  if (url.hostname.toLowerCase() === TCGPLAYER_IMAGE_HOST) {
    return url.toString().replace("_200w.", "_in_1000x1000.");
  }
  return url.toString();
}

export function tcgplayerImageUrl(
  productId: number | null | undefined,
  source?: string | null,
) {
  const directImage = directProductImageUrl(source);
  if (directImage) return directImage;
  const linkedProductId = tcgplayerProductIdFromUrl(source);
  const resolvedProductId =
    productId && productId > 0 ? Math.round(productId) : linkedProductId;
  return resolvedProductId
    ? `https://${TCGPLAYER_IMAGE_HOST}/product/${resolvedProductId}_in_1000x1000.jpg`
    : null;
}

export function tcgplayerProductUrl(
  productId: number | null | undefined,
  source?: string | null,
) {
  const url = httpsUrl(source);
  if (url && TCGPLAYER_PAGE_HOSTS.has(url.hostname.toLowerCase())) {
    return url.toString();
  }
  const linkedProductId = tcgplayerProductIdFromUrl(source);
  const resolvedProductId =
    productId && productId > 0 ? Math.round(productId) : linkedProductId;
  return resolvedProductId
    ? `https://www.tcgplayer.com/product/${resolvedProductId}`
    : null;
}