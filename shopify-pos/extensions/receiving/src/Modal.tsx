import {render} from 'preact';
import {useEffect, useRef, useState} from 'preact/hooks';
import '@shopify/ui-extensions/preact';
import type {Api} from '@shopify/ui-extensions/pos.home.modal.render';
import {findProduct, findCatalogProduct, searchProducts, saveReceipt, loadPendingReceipt} from './receiving-service';
import {subscribeToExternalScanner} from './scanner';
import {CATALOG_GAMES, catalogIdentity, createSealedCatalogClient, type CatalogGame, type CatalogIdentity} from './catalog-client';
import {createCatalogController, type CatalogState} from './catalog-controller';

declare const shopify: Api;

type Product = {
  sku: string; barcode: string; name: string; game: string; unit: string;
  barcodeNeedsReview?: boolean; variantId?: string; price?: string;
};
type ReceiptInput = {
  requestId: string; barcode: string; sku?: string; name: string; game: string;
  unit: string; quantity: string | number; unitCost: string; storePrice?: string; supplier: string;
  notes: string; receivedDate: string; replaceInvalidBarcode: boolean;
  locationId?: string; locationName?: string; currencyCode?: string;
  catalog?: CatalogIdentity;
};
type Form = Omit<ReceiptInput, 'requestId' | 'quantity' | 'storePrice'> & {quantity: string; storePrice: string};
type Phase = 'loading' | 'scan' | 'lookup' | 'search' | 'catalog' | 'ready' | 'unknown' | 'saving' | 'recovery' | 'success' | 'blocked';
type Notice = {heading: string; text: string; tone: 'info' | 'success' | 'warning' | 'critical'};
const UNITS = ['Booster pack', 'Booster box', 'Booster bundle', 'Collection box', 'Elite Trainer Box', 'Tin', 'Deck', 'Display', 'Case', 'Other sealed unit'];
const isEditable = (phase: Phase) => ['scan', 'ready', 'unknown'].includes(phase);
const localDate = () => {
  const today = new Date();
  return `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
};
const emptyForm = (): Form => ({barcode: '', sku: '', name: '', game: '', unit: '', quantity: '', unitCost: '', storePrice: '', supplier: '', notes: '', receivedDate: localDate(), replaceInvalidBarcode: false});
const createRequestId = () => globalThis.crypto?.randomUUID?.() || `pos-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}-${Math.random().toString(36).slice(2)}`;
const validation = (form: Form, product: Product | null, registering: boolean) => {
  if (!product && !registering) return 'Find an existing product or choose Register new sealed product.';
  if (!form.barcode.trim()) return 'Scan the manufacturer barcode first.';
  if (!form.name.trim() || !form.game.trim()) return 'Enter the product name and game.';
  if (!form.unit) return 'Choose the selling unit that matches the scanned package.';
  if (!/^\d+$/.test(form.quantity) || !Number.isSafeInteger(Number(form.quantity)) || Number(form.quantity) < 1) return 'Enter a whole quantity of at least 1.';
  if (!/^\d+(?:\.\d{1,2})?$/.test(form.unitCost)) return 'Enter the cost per unit with up to two decimals. Use 0 only for a zero-cost acquisition.';
  if (Number(form.unitCost) > 1000000) return 'Cost per unit must be no more than 1,000,000.';
  if (form.storePrice.trim() && !/^\d+(?:\.\d{1,2})?$/.test(form.storePrice.trim())) return 'Enter a store price of 0 or more with up to two decimals, or leave it blank to keep the current price.';
  if (Number(form.storePrice) > 1000000) return 'Store price must be no more than 1,000,000.';
  if (!/^\d{4}-\d{2}-\d{2}$/.test(form.receivedDate)) return 'Enter the received date as YYYY-MM-DD.';
  const date = new Date(`${form.receivedDate}T00:00:00Z`);
  if (Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== form.receivedDate) return 'Enter a valid received date.';
  if (product?.barcodeNeedsReview && !form.replaceInvalidBarcode) return 'Confirm that this scan replaces the invalid historical barcode.';
  return '';
};

export default async () => { render(<ReceivingModal />, document.body); };

export function ReceivingModal() {
  const [phase, setPhase] = useState<Phase>('loading');
  const phaseRef = useRef<Phase>('loading');
  const [form, setForm] = useState<Form>(emptyForm);
  const formRef = useRef(form);
  const [product, setProduct] = useState<Product | null>(null);
  const productRef = useRef<Product | null>(null);
  const [registering, setRegistering] = useState(false);
  const registeringRef = useRef(false);
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<Product[]>([]);
  const [searched, setSearched] = useState(false);
  const [catalogGame, setCatalogGame] = useState<CatalogGame | ''>('');
  const [catalogQuery, setCatalogQuery] = useState('');
  const [catalogState, setCatalogState] = useState<CatalogState>({kind: 'idle'});
  const [packageConfirmed, setPackageConfirmed] = useState(false);
  const catalogController = useRef<ReturnType<typeof createCatalogController> | null>(null);
  const [scannerSources, setScannerSources] = useState<string[]>([]);
  const [lastScanSource, setLastScanSource] = useState('');
  const [scannerError, setScannerError] = useState('');
  const scannerCleanup = useRef<(() => void) | undefined>();
  const [notice, setNotice] = useState<Notice>({heading: 'Opening receiving', text: 'Checking for an unfinished receipt…', tone: 'info'});
  const pendingRef = useRef<ReceiptInput | null>(null);
  const mounted = useRef(true);
  const lookupRef = useRef<(barcode: string) => void>(() => {});

  const transition = (next: Phase) => { phaseRef.current = next; setPhase(next); };
  const updateForm = (next: Form) => { formRef.current = next; setForm(next); };
  const assignProduct = (next: Product | null) => { productRef.current = next; setProduct(next); };
  const setRegistration = (next: boolean) => { registeringRef.current = next; setRegistering(next); };
  const alert = (heading: string, text: string, tone: Notice['tone'] = 'critical') => setNotice({heading, text, tone});
  const edit = (key: keyof Form, value: string | boolean) => {
    if (!isEditable(phaseRef.current)) return;
    if (formRef.current.catalog && (key === 'name' || key === 'game')) return;
    updateForm({...formRef.current, [key]: value});
  };
  const resetCatalog = () => {
    catalogController.current?.reset();
    setCatalogGame(''); setCatalogQuery(''); setPackageConfirmed(false);
  };
  const clearIdentity = (barcode: string) => {
    resetCatalog();
    assignProduct(null); setRegistration(false); setResults([]); setSearched(false); setQuery('');
    const next = {...formRef.current, barcode, sku: '', name: '', game: '', unit: '', quantity: '', unitCost: '', storePrice: '', notes: '', replaceInvalidBarcode: false};
    delete next.catalog;
    updateForm(next);
  };
  const changeBarcode = (value: string) => {
    if (!isEditable(phaseRef.current)) return;
    clearIdentity(value); transition('scan');
    alert('Find the product', 'Scan its selling unit or enter the barcode, then tap Find product.', 'info');
  };
  const selectProduct = (next: Product) => {
    if (!isEditable(phaseRef.current)) return;
    resetCatalog();
    assignProduct(next); setRegistration(false); setResults([]);
    const selected = {...formRef.current, sku: next.sku, name: next.name, game: next.game, unit: next.unit || '', quantity: '', unitCost: '', storePrice: '', replaceInvalidBarcode: false};
    delete selected.catalog;
    updateForm(selected);
    transition('ready');
    alert('Check the package', 'Confirm the selling unit, quantity received, and cost per unit. Enter your store price to update the Shopify selling price when you save.', 'info');
  };
  const restoreRequest = (request: ReceiptInput) => {
    resetCatalog();
    pendingRef.current = request;
    updateForm({...request, quantity: String(request.quantity), storePrice: request.storePrice ?? ''});
    assignProduct(request.sku ? {sku: request.sku, barcode: request.barcode, name: request.name, game: request.game, unit: request.unit} : null);
    setRegistration(!request.sku);
    setResults([]); setSearched(false); setQuery('');
    transition('recovery');
  };

  async function initialize() {
    if (!['loading', 'blocked'].includes(phaseRef.current)) return;
    transition('loading');
    alert('Opening receiving', 'Checking for an unfinished receipt…', 'info');
    try {
      const result = await loadPendingReceipt();
      if (!mounted.current) return;
      if (!result?.ok) {
        transition('blocked');
        alert('Receiving unavailable', result?.error?.message || 'Setup or receipt recovery could not be checked. Try again before receiving stock.');
        return;
      }
      if (result.request) {
        restoreRequest(result.request as ReceiptInput);
        alert('Unfinished receipt', 'Review the saved details below, then check or retry this exact receipt. Do not enter the delivery again.', 'warning');
      } else {
        transition('scan');
        alert('Ready to receive', 'Scan the manufacturer barcode on the selling unit. Scanning only finds the product.', 'info');
      }
    } catch {
      if (!mounted.current) return;
      transition('blocked');
      alert('Receiving unavailable', 'Could not check saved receipt recovery. Check your connection and try again.');
    }
  }

  function connectScanner() {
    scannerCleanup.current?.();
    scannerCleanup.current = undefined;
    setScannerError(''); setScannerSources([]); setLastScanSource('');
    try {
      scannerCleanup.current = subscribeToExternalScanner(shopify.scanner, {
        canAccept: () => isEditable(phaseRef.current),
        onScan: (barcode) => lookupRef.current(barcode),
        onSources: (sources) => { if (mounted.current) setScannerSources(sources); },
        onSourcesError: () => { if (mounted.current) setScannerError('POS scanner status is unavailable. Scan input is still listening.'); },
        onScanSource: (source) => { if (mounted.current) setLastScanSource(source || 'unspecified'); },
      });
    } catch { setScannerError('Scan input could not be opened. Tap Check scanner connection or enter the barcode manually.'); }
  }

  useEffect(() => {
    mounted.current = true;
    catalogController.current = createCatalogController({
      client: createSealedCatalogClient({getToken: () => shopify.session.getSessionToken(), request: fetch}),
      findCatalogProduct, searchProducts,
    }, (next) => { if (mounted.current) setCatalogState(next); });
    void initialize();
    connectScanner();
    return () => { mounted.current = false; scannerCleanup.current?.(); catalogController.current?.dispose(); };
  }, []);

  async function lookup(raw: string) {
    if (!isEditable(phaseRef.current)) return;
    const barcode = raw.trim();
    clearIdentity(barcode);
    if (!barcode) { transition('scan'); alert('Barcode required', 'Scan or enter the manufacturer barcode.'); return; }
    transition('lookup');
    alert('Finding product', 'Looking up the scanned barcode…', 'info');
    try {
      const result = await findProduct({barcode});
      if (!mounted.current) return;
      if (!result?.ok) {
        transition('scan'); alert('Lookup failed', result?.error?.message || 'Could not look up this barcode. Try again.'); return;
      }
      if (result.found && result.product) {
        transition('ready'); selectProduct(result.product);
      } else if (result.found === false) {
        transition('unknown');
        alert('Barcode not mapped', 'Search your existing catalog before registering a new sealed product.', 'warning');
      } else {
        transition('scan'); alert('Lookup failed', 'The catalog returned an incomplete result. Try again.');
      }
    } catch {
      if (!mounted.current) return;
      transition('scan'); alert('Lookup failed', 'Check your connection and try again. No product was selected.');
    }
  }
  lookupRef.current = (barcode) => { void lookup(barcode); };

  async function search() {
    if (!isEditable(phaseRef.current) || !query.trim()) return;
    const previous = phaseRef.current;
    transition('search'); setResults([]); setSearched(false);
    try {
      const result = await searchProducts({query: query.trim()});
      if (!mounted.current) return;
      transition(previous);
      if (!result?.ok) { alert('Search failed', result?.error?.message || 'Try the catalog search again.'); return; }
      setResults(result.products || []); setSearched(result.hasMore === false);
      alert('Select the exact product', result.hasMore ? 'More Shopify matches exist. Narrow the search before registering a new product.' : result.products?.length ? 'Check the package and SKU before selecting.' : 'No catalog match. Check the search terms or register a new sealed product.', 'info');
    } catch {
      if (!mounted.current) return;
      transition(previous); alert('Search failed', 'Check your connection and try the catalog search again.');
    }
  }

  async function searchCatalog() {
    if (phaseRef.current !== 'unknown' || !catalogGame || !catalogController.current) return;
    const controller = catalogController.current;
    setPackageConfirmed(false); transition('catalog');
    await controller.search(catalogGame, catalogQuery);
    if (mounted.current && catalogController.current === controller) transition('unknown');
  }

  async function selectCatalog(game: CatalogGame, id: string) {
    if (phaseRef.current !== 'unknown' || !catalogController.current) return;
    const controller = catalogController.current;
    setResults([]); setSearched(false);
    setPackageConfirmed(false); transition('catalog');
    await controller.select(game, id);
    if (mounted.current && catalogController.current === controller) transition('unknown');
  }

  function registerCatalogProduct() {
    if (phaseRef.current !== 'unknown' || catalogState.kind !== 'selected' || !catalogState.canRegister || !packageConfirmed) return;
    const selected = catalogState.product;
    assignProduct(null); setRegistration(true); setResults([]); setSearched(false);
    updateForm({...formRef.current, sku: '', name: selected.name, game: CATALOG_GAMES[selected.game], unit: '', quantity: '', unitCost: '', storePrice: '',
      replaceInvalidBarcode: false, catalog: catalogIdentity(selected)});
    transition('ready');
    alert('Confirm the selling unit', 'Catalog name and game are locked. Choose the actual package unit, then enter quantity, acquisition cost, and your store price. Saving creates a draft; review its details and POS availability before selling.', 'info');
  }

  async function submit() {
    const recovery = phaseRef.current === 'recovery';
    if (!recovery && phaseRef.current !== 'ready') return;
    let request = pendingRef.current;
    if (!request) {
      const error = validation(formRef.current, productRef.current, registeringRef.current);
      if (error) { alert('Check receipt details', error); return; }
      request = {...formRef.current, requestId: createRequestId(), barcode: formRef.current.barcode.trim(), name: formRef.current.name.trim(), game: formRef.current.game.trim()};
      pendingRef.current = request;
    }
    transition('saving');
    alert(recovery ? 'Checking receipt' : 'Saving receipt', 'Wait for confirmation before entering the next product.', 'info');
    try {
      // The service persists this exact payload before its first network write.
      const result = await saveReceipt(request);
      if (!mounted.current) return;
      if (result?.ok) {
        const savedProduct = result.product as Product;
        const receipt = result.receipt;
        if (!savedProduct?.sku || !receipt) throw new Error('Incomplete receipt confirmation');
        assignProduct(savedProduct);
        updateForm({...formRef.current, sku: savedProduct.sku, name: savedProduct.name, game: savedProduct.game, unit: savedProduct.unit || request.unit,
          storePrice: receipt.storePrice ?? '', locationId: receipt.locationId, locationName: receipt.locationName, currencyCode: receipt.currencyCode});
        pendingRef.current = null;
        transition('success');
        const price = receipt.storePrice !== undefined ? ` Store price saved: ${receipt.currencyCode} ${receipt.storePrice} per ${receipt.unit}.` : '';
        const staged = result.staged ? ` Stock is recorded. This product still needs ${receipt.storePrice === undefined ? 'a retail price review, ' : ''}activation and availability in POS before it can be sold.` : '';
        alert(result.duplicate ? 'Receipt already saved' : 'Receipt saved', `${receipt.quantity ?? request.quantity} × ${savedProduct.name} · SKU ${savedProduct.sku}. Receipt ${receipt.requestId || request.requestId}.${price}${staged}`, 'success');
      } else if (result?.error?.code === 'RECEIVING_BUSY' && result.error.definitelyUncommitted === true && result.pendingRequest) {
        restoreRequest(result.pendingRequest as ReceiptInput);
        alert('Finish the saved receipt first', 'This delivery was not started. Finish the saved receipt below, then enter this delivery again.', 'warning');
      } else if (result?.error?.code === 'VALIDATION' && result.error.retryable === false && result.error.committedPossible === false) {
        pendingRef.current = null;
        transition('ready'); alert('Check receipt details', result.error.message);
      } else {
        transition('recovery');
        alert('Receipt needs confirmation', result?.error?.message || 'Keep these details unchanged. Check or retry this receipt to confirm its status.', 'warning');
      }
    } catch {
      if (!mounted.current) return;
      transition('recovery');
      alert('Receipt not confirmed', 'The save may have completed. Check or retry this exact receipt; do not create another for the same delivery.', 'warning');
    }
  }

  const editable = isEditable(phase);
  const detailsVisible = !!product || registering || ['recovery', 'success', 'saving'].includes(phase);
  const total = /^\d+$/.test(form.quantity) && /^\d+(?:\.\d{1,2})?$/.test(form.unitCost)
    ? (Number(form.quantity) * Math.round(Number(form.unitCost) * 100) / 100).toFixed(2) : '';
  const currency = form.currencyCode || shopify.session?.currentSession?.currency || '';
  return <s-page heading="Receive sealed stock">
    <s-scroll-box>
      <s-stack direction="block" gap="base" padding="base">
        <s-banner heading={notice.heading} tone={notice.tone} />
        <s-text>{notice.text}</s-text>
        {form.locationId && <s-text>Receiving location: {form.locationName || String(form.locationId)}</s-text>}
        {phase === 'blocked' && <s-button onClick={() => void initialize()}>Check setup again</s-button>}
        <s-text>{scannerSources.includes('external') ? 'Connected scanner ready' : lastScanSource ? 'Scan input received' : 'POS has not reported a connected scanner to this app. Try scanning, or tap the barcode field and scan again.'}</s-text>
        {scannerError && <s-text>{scannerError}</s-text>}
        <s-button disabled={!editable} onClick={connectScanner}>Check scanner connection</s-button>
        <s-text-field label="Manufacturer barcode" value={form.barcode} disabled={!editable}
          details="Scan the pack, box, display, or case you receive." onInput={(event) => changeBarcode((event.currentTarget.value ?? ''))} />
        <s-button disabled={!editable || !form.barcode.trim()} loading={phase === 'lookup'} onClick={() => void lookup(formRef.current.barcode)}>Find product</s-button>

        {(phase === 'unknown' || phase === 'catalog') && <s-section heading="Find a sealed product in Scrydex">
          <s-stack direction="block" gap="base">
            <s-text>Search by product name, then match the English product and package in your hands. Scrydex does not verify this manufacturer barcode.</s-text>
            <s-text>Game</s-text>
            <s-choice-list values={catalogGame ? [catalogGame] : []} onChange={(event) => {
              if (!editable) return;
              const next = event.currentTarget.values?.[0] as CatalogGame | undefined;
              if (next && Object.hasOwn(CATALOG_GAMES, next)) { setCatalogGame(next); catalogController.current?.reset(); setPackageConfirmed(false); }
            }}>
              {Object.entries(CATALOG_GAMES).map(([value, name]) => <s-choice key={value} value={value} disabled={!editable}>{name}</s-choice>)}
            </s-choice-list>
            <s-text-field label="Sealed product name" maxLength={100} value={catalogQuery} disabled={!editable} onInput={(event) => {
              if (!editable) return;
              setCatalogQuery(event.currentTarget.value ?? ''); catalogController.current?.reset(); setPackageConfirmed(false);
            }} />
            <s-button disabled={!editable || !catalogGame || catalogQuery.trim().length < 3} loading={catalogState.kind === 'searching'} onClick={() => void searchCatalog()}>Search Scrydex</s-button>
            {catalogState.kind === 'checking' && <s-text>Verifying the selected product and checking existing Shopify SKUs…</s-text>}
            {catalogState.kind === 'error' && <><s-banner heading="Catalog needs attention" tone="warning" /><s-text>{catalogState.message} You can still search Shopify manually below.</s-text></>}
            {catalogState.kind === 'results' && <>
              {catalogState.products.length === 0 && <s-text>No sealed products found. Try another name or use the Shopify search below.</s-text>}
              {catalogState.hasMore && <s-text>More catalog results exist. Refine the product name if the exact package is missing.</s-text>}
              {catalogState.products.map((item) => <s-section key={item.id} heading={item.name}>
                <s-stack direction="block" gap="small">
                  <s-text>{item.setName || 'Set not listed'} · English · {item.unit || 'Package unit needs confirmation'}</s-text>
                  {item.marketCents !== null && <s-text>Market reference: ${(item.marketCents / 100).toFixed(2)} USD. This is not your unit cost or an applied retail price.</s-text>}
                  <s-button disabled={!editable} onClick={() => void selectCatalog(item.game, item.id)}>Check this product</s-button>
                </s-stack>
              </s-section>)}
            </>}
            {catalogState.kind === 'selected' && <>
              {catalogState.product.imageUrl && <s-box inlineSize="180px" blockSize="180px">
                {/* The pinned SDK omits the documented alt prop from its JSX type. */}
                <s-image src={catalogState.product.imageUrl} inlineSize="fill" objectFit="contain" {...{alt: `${catalogState.product.name}, ${catalogState.product.setName}, English sealed product`}} />
              </s-box>}
              <s-text>{catalogState.product.name}</s-text>
              <s-text>{catalogState.product.setName || 'Set not listed'} · English · Catalog package: {catalogState.product.unit || 'Confirm the actual unit'}</s-text>
              {catalogState.product.marketCents !== null && <s-text>Market reference: ${(catalogState.product.marketCents / 100).toFixed(2)} USD. Enter your acquisition cost separately; review retail pricing before selling.</s-text>}
              <s-choice-list multiple values={packageConfirmed ? ['confirmed'] : []} onChange={(event) => { if (editable) setPackageConfirmed(event.currentTarget.values?.includes('confirmed') ?? false); }}>
                <s-choice value="confirmed" disabled={!editable}>I checked the physical package: this is the exact English product, set, and selling unit.</s-choice>
              </s-choice-list>
              {catalogState.existing.length > 0 && <s-text>Possible existing Shopify products. Select the exact package to keep its current SKU.</s-text>}
              {catalogState.existing.map((item) => <s-button key={item.variantId} disabled={!editable || !packageConfirmed} onClick={() => selectProduct(item)}>{item.name} · SKU {item.sku || 'not set'} · {item.unit || 'confirm unit'} · Barcode {item.barcode || 'not set'}</s-button>)}
              {catalogState.mapped && <s-text>This catalog identity is already linked to Shopify. Use its existing product or ask the owner to review that mapping.</s-text>}
              {catalogState.hasMoreExisting && <s-text>The Shopify search has more matches. Search Shopify below with more specific terms before creating a new product.</s-text>}
              {catalogState.canRegister && <s-button disabled={!editable || !packageConfirmed} onClick={registerCatalogProduct}>{catalogState.existing.length ? 'None match — register this as a new draft' : 'Register this as a new draft'}</s-button>}
              <s-button disabled={!editable} onClick={() => { catalogController.current?.reset(); setPackageConfirmed(false); }}>Choose another catalog product or use manual entry</s-button>
            </>}
          </s-stack>
        </s-section>}

        {(phase === 'unknown' || phase === 'search' || (!product && registering)) && <>
          <s-text-field label="Search existing catalog" value={query} disabled={!editable} onInput={(event) => { setQuery((event.currentTarget.value ?? '')); setSearched(false); setResults([]); }} />
          <s-button disabled={!editable || !query.trim()} loading={phase === 'search'} onClick={() => void search()}>Search by product name or SKU</s-button>
          {results.map((item) => <s-button key={item.sku} disabled={!editable} onClick={() => selectProduct(item)}>{item.name} · {item.sku}</s-button>)}
          {!registering && searched && catalogState.kind !== 'selected' && <s-button disabled={!editable} onClick={() => {
            if (!isEditable(phaseRef.current)) return;
            resetCatalog();
            setRegistration(true); transition('ready');
            alert('Register new sealed product', 'Enter the exact product and selling unit. A permanent store SKU is assigned when the receipt saves.', 'info');
          }}>Register new sealed product</s-button>}
        </>}

        {detailsVisible && <>
          <s-divider />
          {product && <s-text>Store SKU: {product.sku}</s-text>}
          {form.catalog && <s-text>Verified Scrydex product: {form.catalog.name} · {form.catalog.setName || 'Set not listed'} · {form.catalog.language}. Enter your store price below. This draft still needs activation and POS availability before selling.</s-text>}
          <s-text-field label="Product name" value={form.name} required disabled={!editable || !!product || !!form.catalog} onInput={(event) => edit('name', (event.currentTarget.value ?? ''))} />
          <s-text-field label="Game" value={form.game} required disabled={!editable || !!product?.game || !!form.catalog} onInput={(event) => edit('game', (event.currentTarget.value ?? ''))} />
          <s-text>Selling unit</s-text>
          {product?.unit || !editable ? <s-text>{form.unit || 'Not selected'}</s-text> : <s-choice-list values={form.unit ? [form.unit] : []} onChange={(event) => edit('unit', event.currentTarget.values?.[0] || '')}>
            {UNITS.map((unit) => <s-choice key={unit} value={unit} disabled={!editable}>{unit}</s-choice>)}
          </s-choice-list>}
          {product?.barcodeNeedsReview && <s-choice-list multiple values={form.replaceInvalidBarcode ? ['replace'] : []} onChange={(event) => edit('replaceInvalidBarcode', event.currentTarget.values?.includes('replace') ?? false)}>
            <s-choice value="replace" disabled={!editable}>This physical scan replaces the invalid historical barcode {product.barcode}.</s-choice>
          </s-choice-list>}
          <s-number-field label="Quantity received" value={form.quantity} controls="none" inputMode="numeric" required disabled={!editable} onInput={(event) => edit('quantity', (event.currentTarget.value ?? ''))} />
          <s-number-field label={`Cost per selling unit (${currency})`} value={form.unitCost} controls="none" inputMode="decimal" required disabled={!editable}
            details="Enter acquisition cost. Enter 0 only when this stock cost nothing." onInput={(event) => edit('unitCost', (event.currentTarget.value ?? ''))} />
          {total && <s-text>Total receipt cost: {currency} {total}</s-text>}
          {editable && product?.price !== undefined && <s-text>Current Shopify price: {currency} {product.price} per {form.unit || 'selling unit'}</s-text>}
          <s-number-field label={`Store price per selling unit (${currency})`} value={form.storePrice} controls="none" inputMode="decimal" min={0} max={1000000} disabled={!editable}
            details="Optional. Sets this product's Shopify selling price when you save. Leave blank to keep the current price. Enter 0 only to sell it for free."
            onInput={(event) => edit('storePrice', (event.currentTarget.value ?? ''))} />
          <s-date-field label="Received date" value={form.receivedDate} disabled={!editable} onInput={(event) => edit('receivedDate', (event.currentTarget.value ?? ''))} />
          <s-text-field label="Supplier / invoice (optional)" value={form.supplier} disabled={!editable} onInput={(event) => edit('supplier', (event.currentTarget.value ?? ''))} />
          <s-text-area label="Notes (optional)" value={form.notes} disabled={!editable} onInput={(event) => edit('notes', (event.currentTarget.value ?? ''))} />
        </>}
        {phase === 'ready' && <s-button variant="primary" onClick={() => void submit()}>Save receipt</s-button>}
        {phase === 'saving' && <s-button variant="primary" loading>Saving receipt</s-button>}
        {phase === 'recovery' && <>
          <s-text>Receipt ID: {pendingRef.current?.requestId}</s-text>
          <s-button variant="primary" onClick={() => void submit()}>Check / retry this receipt</s-button>
        </>}
        {phase === 'success' && <s-button variant="primary" onClick={() => {
          if (phaseRef.current !== 'success') return;
          resetCatalog();
          const next = emptyForm(); next.supplier = formRef.current.supplier;
          updateForm(next); assignProduct(null); setRegistration(false); setQuery(''); setResults([]); setSearched(false);
          transition('scan'); alert('Ready for next product', 'Scan the manufacturer barcode on the next selling unit.', 'info');
        }}>Scan next product</s-button>}
      </s-stack>
    </s-scroll-box>
  </s-page>;
}
