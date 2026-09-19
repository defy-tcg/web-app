export const PRICING_URL = 'https://defy-store-os.vercel.app/api/shopify/pos/pricing';
export const QUOTE_PROPERTY = '_defy_pos_quote';
const QUOTE_LIFETIME_MS = 60_000;

export interface Quote {
  variantId: number;
  productId: string;
  sku: string;
  title: string;
  priceCents: number;
  currency: 'USD';
  scrydexId: string;
}

export interface CartLine {
  uuid: string;
  variantId?: number;
  sku?: string;
  price?: number;
  quantity: number;
  properties?: Record<string, string>;
}

export interface PosAdapter {
  currency(): string;
  getToken(): Promise<string | undefined | null>;
  request: typeof fetch;
  getVariant(id: number): Promise<{id: number; price: string; sku?: string} | undefined>;
  cart(): {lineItems: CartLine[]; editable?: boolean};
  add(id: number, properties: Record<string, string>): Promise<string>;
  remove(uuid: string): Promise<void>;
  pause(ms: number): Promise<void>;
  now(): number;
  uniqueId(): string;
}

export type PricingState =
  | {kind: 'idle'}
  | {kind: 'loading'; code: string}
  | {kind: 'quoted'; quote: Quote; receivedAt: number}
  | {kind: 'adding'; quote: Quote}
  | {kind: 'added'; quote: Quote}
  | {kind: 'error'; message: string; quote?: Quote};

export function amountToCents(value: string | number | undefined): number | undefined {
  if (typeof value === 'string' && !/^\d+(?:\.\d{1,2})?$/.test(value)) return undefined;
  const amount = typeof value === 'string' ? Number(value) : value;
  if (typeof amount !== 'number' || !Number.isFinite(amount) || amount <= 0) return undefined;
  const cents = Math.round(amount * 100);
  if (!Number.isSafeInteger(cents) || cents > 100_000_000 || Math.abs(amount * 100 - cents) > 0.000001) return undefined;
  return cents;
}

export function parseQuote(value: unknown): Quote {
  if (!value || typeof value !== 'object') throw new Error('The pricing service returned an invalid response.');
  const result = value as Record<string, unknown>;
  if (!Number.isSafeInteger(result.variantId) || (result.variantId as number) <= 0 ||
      !Number.isSafeInteger(result.priceCents) || (result.priceCents as number) <= 0 ||
      (result.priceCents as number) > 100_000_000 || result.currency !== 'USD' || typeof result.sku !== 'string' ||
      !['productId', 'title', 'scrydexId'].every((key) => typeof result[key] === 'string' && (result[key] as string).trim().length > 0)) {
    throw new Error('The pricing service returned an invalid response.');
  }
  return result as unknown as Quote;
}

// A newly subscribed scanner may replay its current, previously scanned value.
export function createScanGate(initial?: string) {
  let last = initial?.trim();
  return {
    accept(value: string | undefined): boolean {
      const code = value?.trim();
      if (!code || code === last) return false;
      last = code;
      return true;
    },
    reset() { last = undefined; },
  };
}

export function createPricingController(adapter: PosAdapter, changed: (state: PricingState) => void) {
  let state: PricingState = {kind: 'idle'};
  let busy = false;
  let disposed = false;
  let requestAbort: AbortController | undefined;
  const emit = (next: PricingState) => { state = next; if (!disposed) changed(next); };
  const assertUsd = () => {
    if (adapter.currency() !== 'USD') throw new Error('Defy pricing is available only for a USD POS location.');
  };
  const assertNewVariant = (quote: Quote) => {
    if (adapter.cart().editable === false) throw new Error('The cart cannot be edited. Finish the current checkout before adding a card.');
    if (adapter.cart().lineItems.some((line) => line.variantId === quote.variantId)) {
      throw new Error('This card is already in the cart. Use the cart quantity control instead of adding it again.');
    }
  };
  const poll = async <T>(read: () => Promise<T> | T, accept: (value: T) => boolean): Promise<T> => {
    let value = await read();
    for (let attempt = 0; attempt < 5 && !accept(value); attempt++) {
      await adapter.pause(1000);
      value = await read();
    }
    return value;
  };

  return {
    getState: () => state,
    isBusy: () => busy,
    async lookup(input: string) {
      if (disposed || busy) return;
      const code = input.trim();
      busy = true;
      try {
        assertUsd();
        if (!code || code.length > 128 || /[\u0000-\u001f\u007f]/.test(code)) throw new Error('Enter a valid SKU or barcode.');
        if (adapter.cart().lineItems.some((line) => line.sku === code)) throw new Error('This SKU is already in the cart. Use the cart quantity control instead of scanning it again.');
        emit({kind: 'loading', code});
        const token = await adapter.getToken();
        if (!token) throw new Error('Sign in to Shopify POS with an account that has permission to use the Defy app.');
        if (disposed) return;
        requestAbort = new AbortController();
        const timeout = setTimeout(() => requestAbort?.abort(), 30_000);
        let response: Response;
        let body: unknown;
        try {
          response = await adapter.request(PRICING_URL, {
            method: 'POST',
            headers: {'Content-Type': 'application/json', Authorization: `Bearer ${token}`},
            body: JSON.stringify({code}),
            signal: requestAbort.signal,
          });
          body = await response.json();
        } finally { clearTimeout(timeout); requestAbort = undefined; }
        if (!response.ok) {
          const error = body && typeof body === 'object' && 'error' in body ? (body as {error: unknown}).error : undefined;
          throw new Error(typeof error === 'string' ? error : 'The price could not be fetched. Please try again.');
        }
        const quote = parseQuote(body);
        assertUsd();
        assertNewVariant(quote);
        emit({kind: 'quoted', quote, receivedAt: adapter.now()});
      } catch (error) {
        emit({kind: 'error', message: error instanceof Error && error.name !== 'AbortError' ? error.message : 'The pricing request timed out. Please try again.'});
      } finally { busy = false; }
    },
    async add() {
      if (disposed || busy || state.kind !== 'quoted') return;
      const {quote, receivedAt} = state;
      let beforeIds: Set<string> | undefined;
      let marker: string | undefined;
      busy = true;
      try {
        assertUsd();
        assertNewVariant(quote);
        if (adapter.now() - receivedAt > QUOTE_LIFETIME_MS) throw new Error('This price needs refreshing. Look up the SKU again.');
        emit({kind: 'adding', quote});
        const variant = await poll(() => adapter.getVariant(quote.variantId), (value) => value?.id === quote.variantId && amountToCents(value.price) === quote.priceCents);
        if (!variant || variant.id !== quote.variantId || amountToCents(variant.price) !== quote.priceCents) {
          throw new Error('Shopify POS is still syncing this price. Nothing was added. Wait a moment, then look up the SKU again.');
        }
        if (disposed) return;
        assertUsd();
        assertNewVariant(quote);
        if (adapter.now() - receivedAt > QUOTE_LIFETIME_MS) throw new Error('This price needs refreshing. Look up the SKU again.');
        beforeIds = new Set(adapter.cart().lineItems.map((line) => line.uuid));
        marker = adapter.uniqueId();
        const uuid = await adapter.add(quote.variantId, {[QUOTE_PROPERTY]: marker});
        if (!uuid) throw new Error('Adding this card was canceled.');
        const line = await poll(
          () => adapter.cart().lineItems.find((entry) => entry.uuid === uuid),
          (entry) => !!entry && entry.variantId === quote.variantId && entry.quantity === 1 && entry.properties?.[QUOTE_PROPERTY] === marker && amountToCents(entry.price) === quote.priceCents,
        );
        if (disposed || !line || beforeIds.has(uuid) || line.variantId !== quote.variantId || line.quantity !== 1 ||
            line.properties?.[QUOTE_PROPERTY] !== marker || amountToCents(line.price) !== quote.priceCents || adapter.currency() !== 'USD') {
          throw new Error('The cart price could not be verified.');
        }
        emit({kind: 'added', quote});
      } catch (error) {
        let message = error instanceof Error ? error.message : 'The card could not be added.';
        if (beforeIds && marker) {
          // Only remove a fresh line carrying this operation's marker. Never an existing cart line.
          try {
            // A rejected native add can still create a line that reaches this signal later.
            const owned = await poll(
              () => adapter.cart().lineItems.filter((line) => !beforeIds!.has(line.uuid) && line.properties?.[QUOTE_PROPERTY] === marker && line.variantId === quote.variantId),
              (lines) => lines.length > 0,
            );
            for (const line of owned) await adapter.remove(line.uuid);
            const remaining = await poll(() => adapter.cart().lineItems, (lines) => !lines.some((line) => owned.some((entry) => entry.uuid === line.uuid)));
            if (remaining.some((line) => owned.some((entry) => entry.uuid === line.uuid))) throw new Error('Removal did not complete.');
            message += owned.length ? ' The new line was removed. Look up the SKU again.' : ' Check the cart before retrying.';
          } catch {
            message += ' Check and remove the unverified new line from the cart before checkout.';
          }
        }
        emit({kind: 'error', message, quote});
      } finally { busy = false; }
    },
    reset() { if (!busy) emit({kind: 'idle'}); },
    dispose() { disposed = true; requestAbort?.abort(); },
  };
}
