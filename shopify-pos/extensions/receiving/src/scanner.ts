export type ScanEvent = {data?: string; source?: string};
type Signal<T> = {value: T; subscribe: (callback: (value: T) => void) => () => void};
type Scanner = {scannerData: {current: Signal<ScanEvent>}; sources: {current: Signal<string[]>}};

/** A scan selects a product; it never changes quantity or submits a receipt. */
export function subscribeToExternalScanner(scanner: Scanner, options: {
  canAccept: () => boolean;
  onScan: (barcode: string) => void;
  onSources: (sources: string[]) => void;
  onSourcesError?: () => void;
  onScanSource?: (source: string | undefined) => void;
  now?: () => number;
}) {
  const now = options.now || Date.now;
  const initial = scanner.scannerData.current.value;
  const initialKey = typeof initial?.data === 'string' && initial.data.trim() ? `${initial.source}:${initial.data}` : null;
  let initialReplayPending = initialKey !== null;
  let lastKey = '';
  let lastTime = -Infinity;
  let disposed = false;
  let unsubscribeSources: (() => void) | undefined;
  let unsubscribeData: (() => void) | undefined;
  const dispose = () => {
    disposed = true;
    try { unsubscribeData?.(); } finally { unsubscribeSources?.(); }
  };
  try {
    // Availability is advisory: a source-status failure must not stop scan events.
    try {
      options.onSources(scanner.sources.current.value || []);
      unsubscribeSources = scanner.sources.current.subscribe((sources) => {
        if (!disposed) options.onSources(sources || []);
      });
    } catch { options.onSourcesError?.(); }
    unsubscribeData = scanner.scannerData.current.subscribe((event) => {
      if (disposed || typeof event?.data !== 'string' || !event.data.trim()) return;
      const key = `${event.source}:${event.data}`;
      // POS may replay the previous scan on subscription, including after remount.
      // With no event ID, conservatively ignore the first matching initial value.
      if (initialReplayPending) {
        initialReplayPending = false;
        if (key === initialKey) return;
      }
      // Shopify's scan source is optional; scan data is useful even without it.
      options.onScanSource?.(typeof event.source === 'string' ? event.source : undefined);
      if (!options.canAccept()) return;
      const time = now();
      if (key === lastKey && time - lastTime < 500) return;
      lastKey = key;
      lastTime = time;
      options.onScan(event.data);
    });
  } catch (error) {
    dispose();
    throw error;
  }
  return dispose;
}
