import '@shopify/ui-extensions/preact';
import type {Api} from '@shopify/ui-extensions/pos.home.modal.render';
import {render} from 'preact';
import {useEffect, useRef, useState} from 'preact/hooks';
import {createPricingController, createScanGate, type PricingState} from './controller.ts';

declare const shopify: Api;

export default function extension() { render(<PricingModal />, document.body); }

function PricingModal() {
  const [code, setCode] = useState('');
  const [state, setState] = useState<PricingState>({kind: 'idle'});
  const [cameraAvailable, setCameraAvailable] = useState(shopify.scanner.sources.current.value.includes('camera'));
  const controllerRef = useRef<ReturnType<typeof createPricingController> | null>(null);
  const gate = useRef(createScanGate(shopify.scanner.scannerData.current.value.data));

  useEffect(() => {
    const controller = createPricingController({
      currency: () => shopify.session.currentSession.currency,
      getToken: () => shopify.session.getSessionToken(),
      request: fetch,
      getVariant: (id) => shopify.productSearch.fetchProductVariantWithId(id),
      cart: () => shopify.cart.current.value,
      add: (id, properties) => shopify.cart.addLineItem(id, 1, {properties}),
      remove: (uuid) => shopify.cart.removeLineItem(uuid),
      pause: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
      now: Date.now,
      uniqueId: () => `${Date.now()}-${Math.random().toString(36).slice(2)}`,
    }, setState);
    controllerRef.current = controller;
    const unsubscribeScan = shopify.scanner.scannerData.current.subscribe(({data}) => {
      if (controller.isBusy() || !gate.current.accept(data)) return;
      shopify.scanner.hideCameraScanner();
      const scanned = data!.trim();
      setCode(scanned);
      void controller.lookup(scanned);
    });
    const unsubscribeSources = shopify.scanner.sources.current.subscribe((sources) => setCameraAvailable(sources.includes('camera')));
    return () => {
      unsubscribeScan();
      unsubscribeSources();
      shopify.scanner.hideCameraScanner();
      controller.dispose();
      controllerRef.current = null;
    };
  }, []);

  const busy = state.kind === 'loading' || state.kind === 'adding';
  const quote = 'quote' in state ? state.quote : undefined;
  const lookup = () => {
    shopify.scanner.hideCameraScanner();
    void controllerRef.current?.lookup(code);
  };
  const scanAgain = () => {
    gate.current.reset();
    controllerRef.current?.reset();
    setCode('');
    if (cameraAvailable) shopify.scanner.showCameraScanner();
  };

  return (
    <s-page heading="Defy Pricing">
      <s-scroll-box>
        <s-stack direction="block" gap="base" padding="base">
          <s-text>Scan a SKU or barcode to get the customer selling price from Scrydex.</s-text>
          <s-text-field label="SKU or barcode" value={code} maxLength={128} disabled={busy}
            onInput={(event) => { setCode(event.currentTarget.value ?? ''); controllerRef.current?.reset(); }} />
          <s-button variant="primary" disabled={!code.trim() || busy} loading={state.kind === 'loading'} onClick={lookup}>Look up price</s-button>
          {cameraAvailable && <s-button disabled={busy} onClick={scanAgain}>Scan with camera</s-button>}
          {state.kind === 'loading' && <s-text>Fetching the price and syncing Shopify…</s-text>}
          {state.kind === 'error' && <s-banner heading="Price needs attention" tone="critical">{state.message}</s-banner>}
          {quote && (
            <s-section heading={quote.title}>
              <s-stack direction="block" gap="base">
                <s-text>{quote.sku ? `SKU: ${quote.sku}` : `Scanned code: ${code}`}</s-text>
                <s-text>Customer price: ${(quote.priceCents / 100).toFixed(2)} USD</s-text>
                {state.kind === 'quoted' && <s-button variant="primary" onClick={() => void controllerRef.current?.add()}>Add to cart</s-button>}
                {state.kind === 'adding' && <s-text>Checking the price in Shopify POS before adding…</s-text>}
                {state.kind === 'added' && <s-banner heading="Added to cart" tone="success">The selling price has been checked. Adjust quantity in the cart if needed.</s-banner>}
              </s-stack>
            </s-section>
          )}
          {!busy && state.kind !== 'idle' && <s-button onClick={() => { gate.current.reset(); controllerRef.current?.reset(); setCode(''); }}>Next card</s-button>}
        </s-stack>
      </s-scroll-box>
    </s-page>
  );
}
