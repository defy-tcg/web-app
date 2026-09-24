import '@shopify/ui-extensions/preact';
import type {Api} from '@shopify/ui-extensions/pos.home.modal.render';
import {render} from 'preact';
import {useEffect, useRef, useState} from 'preact/hooks';
import {createSealedCatalogClient, type CatalogProduct} from '../../receiving/src/catalog-client.ts';
import {createSealedPricingClient} from './client.ts';
import {createSealedPricingController, createSealedScanGate, type SealedPricingState} from './controller.ts';

declare const shopify: Api;
type Controller = ReturnType<typeof createSealedPricingController>;

export default function extension() { render(<SealedPricingModal />, document.body); }

function hideCamera() {
  try { shopify.scanner.hideCameraScanner(); } catch { /* Scanner availability is advisory. */ }
}

function ProductDetails({product}: {product: CatalogProduct}) {
  return <s-stack direction="block" gap="base">
    {product.imageUrl && <s-box inlineSize="180px" blockSize="180px">
      {/* The pinned SDK omits the documented alt prop from its JSX type. */}
      <s-image src={product.imageUrl} inlineSize="fill" objectFit="contain"
        {...{alt: `${product.name}, ${product.setName}, English sealed product`}} />
    </s-box>}
    <s-text>{product.name}</s-text>
    <s-text>{product.setName} · {product.language}</s-text>
    <s-text>Package: {product.unit || 'Unit not listed — check the physical package'}</s-text>
  </s-stack>;
}

function SealedPricingModal() {
  const [state, setState] = useState<SealedPricingState>({kind: 'idle', code: ''});
  const [sources, setSources] = useState<string[]>([]);
  const [scannerMessage, setScannerMessage] = useState('');
  const controllerRef = useRef<Controller | null>(null);
  const gateRef = useRef<ReturnType<typeof createSealedScanGate> | null>(null);

  useEffect(() => {
    const transport = {getToken: () => shopify.session.getSessionToken(), request: fetch};
    const controller = createSealedPricingController({pricing: createSealedPricingClient(transport), catalog: createSealedCatalogClient(transport)}, setState);
    controllerRef.current = controller;
    let unsubscribeSources: (() => void) | undefined;
    let unsubscribeScans: (() => void) | undefined;
    try {
      setSources(shopify.scanner.sources.current.value || []);
      unsubscribeSources = shopify.scanner.sources.current.subscribe(setSources);
    } catch { setScannerMessage('Scanner availability is unknown. You can still scan into the code field or enter the code.'); }
    try {
      gateRef.current = createSealedScanGate(shopify.scanner.scannerData.current.value.data);
      unsubscribeScans = shopify.scanner.scannerData.current.subscribe(({data}) => {
        if (!gateRef.current?.accept(data)) return;
        hideCamera();
        void controller.lookup(data!);
      });
    } catch { setScannerMessage('Scan into the manufacturer code field, then tap Look up live price.'); }
    return () => {
      unsubscribeScans?.();
      unsubscribeSources?.();
      hideCamera();
      controller.dispose();
      controllerRef.current = null;
      gateRef.current = null;
    };
  }, []);

  const nextProduct = () => {
    gateRef.current?.reset();
    controllerRef.current?.reset();
    hideCamera();
  };
  const openCamera = () => {
    nextProduct();
    try { shopify.scanner.showCameraScanner(); }
    catch { setScannerMessage('The camera could not open. Scan into the code field or enter the manufacturer code.'); }
  };
  const catalog = state.kind === 'matching' ? state.catalog : undefined;
  const catalogBusy = catalog?.kind === 'searching' || catalog?.kind === 'checking' || catalog?.kind === 'saving';

  return <s-page heading="Pokémon Sealed">
    <s-scroll-box>
      <s-stack direction="block" gap="base" padding="base">
        <s-text>Scan the manufacturer SKU, UPC, or EAN for a live English Pokémon sealed market price.</s-text>
        {sources.includes('external') && <s-text>Hardware scanner ready</s-text>}
        {scannerMessage && <s-text>{scannerMessage}</s-text>}
        <s-text-field label="Manufacturer SKU or barcode" value={state.code} maxLength={128}
          onInput={(event) => controllerRef.current?.editCode(event.currentTarget.value ?? '')} />
        <s-button variant="primary" disabled={!state.code.trim() || state.kind === 'loading'} loading={state.kind === 'loading'}
          onClick={() => { hideCamera(); void controllerRef.current?.lookup(state.code); }}>Look up live price</s-button>
        {sources.includes('camera') && <s-button onClick={openCamera}>Scan with camera</s-button>}
        {state.kind === 'loading' && <s-text>Fetching the latest price from Scrydex…</s-text>}
        {state.kind === 'error' && <>
          <s-banner heading="Live price unavailable" tone="critical" />
          <s-text>{state.message}</s-text>
          {state.match && <s-button onClick={() => controllerRef.current?.changeMatch()}>Change matched product</s-button>}
        </>}
        {state.kind === 'quoted' && <>
          <s-heading>{state.quote.product.marketCents === null ? 'Price unavailable' : `$${(state.quote.product.marketCents / 100).toFixed(2)} USD`}</s-heading>
          <s-text>Scrydex market price · per {state.quote.product.unit || 'catalog package'}</s-text>
          <ProductDetails product={state.quote.product} />
          {state.quote.product.marketCents === null && <s-text>Scrydex has no current market price for this package. Try refreshing later.</s-text>}
          <s-text>Fetched from Scrydex: {new Date(state.quote.fetchedAt).toLocaleString()}</s-text>
          <s-text>Check the exact product and package. Some tins share a manufacturer barcode.</s-text>
          <s-button variant="primary" onClick={() => void controllerRef.current?.refresh()}>Refresh price</s-button>
          <s-button onClick={() => controllerRef.current?.changeMatch()}>Change matched product</s-button>
        </>}
        {state.kind === 'matching' && <s-section heading="Match this sealed package">
          <s-stack direction="block" gap="base">
            <s-text>Search Scrydex by product name, then confirm the exact English product and package in your hands. The confirmed match is saved for future scans of this code.</s-text>
            <s-text>Some tins and assortments share barcodes. Check the artwork, set, and package unit; do not guess from the barcode alone.</s-text>
            <s-text-field label="Pokémon sealed product name" value={state.query} maxLength={100} disabled={catalog?.kind === 'saving'}
              onInput={(event) => controllerRef.current?.editQuery(event.currentTarget.value ?? '')} />
            <s-button disabled={state.query.trim().length < 3 || catalogBusy} loading={catalog?.kind === 'searching'}
              onClick={() => void controllerRef.current?.search()}>Search Scrydex</s-button>
            {catalog?.kind === 'results' && <>
              {catalog.products.length === 0 && <s-text>No matching sealed products found. Try a set name and package type.</s-text>}
              {catalog.hasMore && <s-text>More results are available. Refine the name if the exact package is missing.</s-text>}
              {catalog.products.map((product) => <s-section key={product.id} heading={product.name}>
                <s-stack direction="block" gap="base">
                  <s-text>{product.setName} · English · {product.unit || 'Check package unit'}</s-text>
                  <s-button onClick={() => void controllerRef.current?.select(product.id)}>Review this package</s-button>
                </s-stack>
              </s-section>)}
            </>}
            {catalog?.kind === 'checking' && <s-text>Checking the selected Scrydex product…</s-text>}
            {catalog?.kind === 'selected' && <>
              <ProductDetails product={catalog.product} />
              <s-text>Manufacturer code: {state.code}</s-text>
              <s-choice-list multiple values={catalog.packageConfirmed ? ['confirmed'] : []}
                onChange={(event) => controllerRef.current?.confirmPackage(catalog.selectionKey, event.currentTarget.values?.includes('confirmed') ?? false)}>
                <s-choice value="confirmed">I checked the physical package: this is the exact English product, set, artwork, and selling unit.</s-choice>
              </s-choice-list>
              <s-button variant="primary" disabled={!catalog.packageConfirmed}
                onClick={() => void controllerRef.current?.confirm(catalog.selectionKey)}>Confirm product &amp; save match</s-button>
              <s-button onClick={() => controllerRef.current?.clearSelection()}>Choose another package</s-button>
            </>}
            {catalog?.kind === 'saving' && <s-text>Saving the confirmed match and fetching a live price…</s-text>}
            {catalog?.kind === 'error' && <>
              <s-banner heading="Match needs attention" tone="warning" />
              <s-text>{catalog.message}</s-text>
            </>}
          </s-stack>
        </s-section>}
        {(state.code || state.kind !== 'idle') && <s-button onClick={nextProduct}>Next product</s-button>}
        <s-text>Market reference only. Prices are shown in USD.</s-text>
      </s-stack>
    </s-scroll-box>
  </s-page>;
}
