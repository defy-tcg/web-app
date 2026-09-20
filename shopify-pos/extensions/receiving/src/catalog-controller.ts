import {type CatalogGame, type CatalogProduct, type createSealedCatalogClient} from './catalog-client.ts';
import type {Product} from './receiving-service.ts';

type Failure = {ok: false; error: {message: string}};
type Dependencies = {
  client: ReturnType<typeof createSealedCatalogClient>;
  findCatalogProduct(input: {game: CatalogGame; id: string}): Promise<{ok: true; found: boolean; product: Product | null} | Failure>;
  searchProducts(input: {query: string}): Promise<{ok: true; products: Product[]; hasMore: boolean} | Failure>;
};
export type CatalogState =
  | {kind: 'idle'}
  | {kind: 'searching'}
  | {kind: 'results'; products: CatalogProduct[]; hasMore: boolean}
  | {kind: 'checking'}
  | {kind: 'selected'; product: CatalogProduct; existing: Product[]; canRegister: boolean; hasMoreExisting: boolean; mapped: boolean}
  | {kind: 'error'; message: string};

/** Selection is read-only and invalidated whenever the scanned package changes. */
export function createCatalogController(dependencies: Dependencies, changed: (state: CatalogState) => void) {
  let state: CatalogState = {kind: 'idle'};
  let revision = 0;
  let busy = false;
  let disposed = false;
  const emit = (next: CatalogState) => { state = next; if (!disposed) changed(next); };
  const current = (request: number) => !disposed && request === revision;
  const fail = (error: unknown) => emit({kind: 'error', message: error instanceof Error ? error.message : 'The catalog could not be checked. Try again before creating a product.'});
  return {
    getState: () => state,
    isBusy: () => busy,
    async search(game: CatalogGame, query: string) {
      if (disposed || busy) return;
      busy = true;
      const request = ++revision;
      emit({kind: 'searching'});
      try {
        const result = await dependencies.client.search(game, query);
        if (current(request)) emit({kind: 'results', ...result});
      } catch (error) { if (current(request)) fail(error); }
      finally { if (current(request)) busy = false; }
    },
    async select(game: CatalogGame, id: string) {
      if (disposed || busy) return;
      busy = true;
      const request = ++revision;
      emit({kind: 'checking'});
      try {
        const product = await dependencies.client.detail(game, id);
        if (!current(request)) return;
        const [mapping, search] = await Promise.all([
          dependencies.findCatalogProduct({game, id}),
          dependencies.searchProducts({query: product.name}),
        ]);
        if (!current(request)) return;
        if (!mapping.ok) throw new Error(mapping.error.message);
        if (!search.ok) throw new Error(search.error.message);
        if (typeof mapping.found !== 'boolean' || mapping.found !== Boolean(mapping.product)
          || !Array.isArray(search.products) || typeof search.hasMore !== 'boolean') throw new Error('Shopify returned an incomplete product search. Retry before creating a product.');
        const matches = [...(mapping.product ? [mapping.product] : []), ...search.products];
        const existing = [...new Map(matches.map(item => [item.variantId, item])).values()];
        emit({kind: 'selected', product, existing, hasMoreExisting: search.hasMore, mapped: mapping.found, canRegister: !mapping.found && !search.hasMore});
      } catch (error) { if (current(request)) fail(error); }
      finally { if (current(request)) busy = false; }
    },
    reset() { revision++; busy = false; emit({kind: 'idle'}); },
    dispose() { disposed = true; revision++; busy = false; },
  };
}
