import type {CatalogProduct, createSealedCatalogClient} from '../../receiving/src/catalog-client.ts';
import {normalizeSealedCode, SealedPricingError, type SavedMatch, type SealedQuote, type createSealedPricingClient} from './client.ts';

export type MatchCatalogState =
  | {kind: 'idle'}
  | {kind: 'searching'}
  | {kind: 'results'; products: CatalogProduct[]; hasMore: boolean}
  | {kind: 'checking'}
  | {kind: 'selected'; product: CatalogProduct; selectionKey: number; packageConfirmed: boolean}
  | {kind: 'saving'; product: CatalogProduct}
  | {kind: 'error'; message: string};
type MatchState = {kind: 'matching'; code: string; expectedId: string | null; query: string; catalog: MatchCatalogState};
export type SealedPricingState =
  | {kind: 'idle'; code: string}
  | {kind: 'loading'; code: string}
  | {kind: 'quoted'; code: string; quote: SealedQuote}
  | MatchState
  | {kind: 'error'; code: string; message: string; match?: SavedMatch};
type Dependencies = {pricing: ReturnType<typeof createSealedPricingClient>; catalog: ReturnType<typeof createSealedCatalogClient>};

/** POS can replay its current scan when a modal subscribes. Debounce across camera/hardware sources. */
export function createSealedScanGate(initial?: string, now: () => number = Date.now) {
  let replay = initial?.trim();
  let previous = '';
  let receivedAt = -Infinity;
  return {
    accept(input: string | undefined) {
      const code = input?.trim();
      if (!code) return false;
      if (replay !== undefined) {
        const initialCode = replay;
        replay = undefined;
        if (initialCode === code) return false;
      }
      const timestamp = now();
      if (code === previous && timestamp - receivedAt < 750) return false;
      previous = code;
      receivedAt = timestamp;
      return true;
    },
    reset() { replay = undefined; previous = ''; receivedAt = -Infinity; },
  };
}

/** Every edit/scan invalidates prior reads, detail checks and package confirmations. */
export function createSealedPricingController(dependencies: Dependencies, changed: (state: SealedPricingState) => void) {
  let state: SealedPricingState = {kind: 'idle', code: ''};
  let revision = 0;
  let disposed = false;
  let request: AbortController | undefined;
  const emit = (next: SealedPricingState) => { if (!disposed) { state = next; changed(next); } };
  const current = (key: number) => !disposed && revision === key;
  const invalidate = () => { revision++; request?.abort(); request = undefined; return revision; };
  const message = (error: unknown) => error instanceof Error ? error.message : 'Live sealed pricing is unavailable. Try again.';
  const match = (code: string, expectedId: string | null, query = ''): MatchState => ({kind: 'matching', code, expectedId, query, catalog: {kind: 'idle'}});

  async function lookup(input: string) {
    if (disposed || (state.kind === 'loading' && state.code === input.trim())) return;
    const key = invalidate();
    let code = input.trim();
    try {
      code = normalizeSealedCode(input);
      emit({kind: 'loading', code});
      request = new AbortController();
      const result = await dependencies.pricing.scan(code, request.signal);
      if (!current(key)) return;
      if (result.status === 'unmapped') emit(match(code, null, result.suggestedQuery || ''));
      else emit({kind: 'quoted', code, quote: result.quote});
    } catch (error) {
      if (current(key)) emit({kind: 'error', code, message: message(error),
        ...(error instanceof SealedPricingError && error.match ? {match: error.match} : {})});
    }
  }

  return {
    getState: () => state,
    lookup,
    editCode(code: string) {
      if (disposed) return;
      invalidate();
      emit({kind: 'idle', code});
    },
    refresh() { return state.kind === 'quoted' ? lookup(state.code) : Promise.resolve(); },
    changeMatch() {
      if (disposed) return;
      if (state.kind === 'error' && state.match) {
        const {code, match: saved} = state;
        invalidate();
        emit(match(code, saved.id));
        return;
      }
      if (state.kind !== 'quoted') return;
      const {code, quote} = state;
      invalidate();
      emit(match(code, quote.mappingSource === 'shopify' ? null : quote.product.id, quote.product.name.slice(0, 100)));
    },
    editQuery(query: string) {
      if (disposed || state.kind !== 'matching') return;
      invalidate();
      emit({...state, query, catalog: {kind: 'idle'}});
    },
    async search() {
      if (disposed || state.kind !== 'matching' || state.catalog.kind === 'searching' || state.catalog.kind === 'saving') return;
      const context = state;
      const key = invalidate();
      emit({...context, catalog: {kind: 'searching'}});
      try {
        const result = await dependencies.catalog.search('pokemon', context.query);
        if (current(key)) emit({...context, catalog: {kind: 'results', ...result}});
      } catch (error) { if (current(key)) emit({...context, catalog: {kind: 'error', message: message(error)}}); }
    },
    async select(id: string) {
      if (disposed || state.kind !== 'matching' || state.catalog.kind !== 'results' || !state.catalog.products.some(product => product.id === id)) return;
      const context = state;
      const key = invalidate();
      emit({...context, catalog: {kind: 'checking'}});
      try {
        const product = await dependencies.catalog.detail('pokemon', id);
        if (current(key)) emit({...context, catalog: {kind: 'selected', product, selectionKey: key, packageConfirmed: false}});
      } catch (error) { if (current(key)) emit({...context, catalog: {kind: 'error', message: message(error)}}); }
    },
    confirmPackage(selectionKey: number, confirmed: boolean) {
      if (disposed || state.kind !== 'matching' || state.catalog.kind !== 'selected' || state.catalog.selectionKey !== selectionKey) return;
      emit({...state, catalog: {...state.catalog, packageConfirmed: confirmed}});
    },
    async confirm(selectionKey: number) {
      if (disposed || state.kind !== 'matching' || state.catalog.kind !== 'selected' || !state.catalog.packageConfirmed || state.catalog.selectionKey !== selectionKey) return;
      const context = state;
      const product = state.catalog.product;
      const key = invalidate();
      request = new AbortController();
      emit({...context, catalog: {kind: 'saving', product}});
      try {
        const quote = await dependencies.pricing.link(context.code, product.id, context.expectedId, request.signal);
        if (current(key)) emit({kind: 'quoted', code: context.code, quote});
      } catch (error) { if (current(key)) emit({...context, catalog: {kind: 'error', message: message(error)}}); }
    },
    clearSelection() {
      if (disposed || state.kind !== 'matching') return;
      invalidate();
      emit({...state, catalog: {kind: 'idle'}});
    },
    reset() { if (!disposed) { invalidate(); emit({kind: 'idle', code: ''}); } },
    dispose() { disposed = true; invalidate(); },
  };
}
