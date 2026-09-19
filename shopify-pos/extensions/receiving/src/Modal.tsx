import {render} from 'preact';
import {useEffect, useRef, useState} from 'preact/hooks';
import '@shopify/ui-extensions/preact';
import type {Api} from '@shopify/ui-extensions/pos.home.modal.render';
import {findProduct, searchProducts, saveReceipt, loadPendingReceipt} from './receiving-service';
import {subscribeToExternalScanner} from './scanner';

declare const shopify: Api;

type Product = {
  sku: string; barcode: string; name: string; game: string; unit: string;
  barcodeNeedsReview?: boolean; variantId?: string;
};
type ReceiptInput = {
  requestId: string; barcode: string; sku?: string; name: string; game: string;
  unit: string; quantity: string | number; unitCost: string; supplier: string;
  notes: string; receivedDate: string; replaceInvalidBarcode: boolean;
  locationId?: string; locationName?: string; currencyCode?: string;
};
type Form = Omit<ReceiptInput, 'requestId' | 'quantity'> & {quantity: string};
type Phase = 'loading' | 'scan' | 'lookup' | 'search' | 'ready' | 'unknown' | 'saving' | 'recovery' | 'success' | 'blocked';
type Notice = {heading: string; text: string; tone: 'info' | 'success' | 'warning' | 'critical'};
const UNITS = ['Booster pack', 'Booster box', 'Booster bundle', 'Collection box', 'Elite Trainer Box', 'Tin', 'Deck', 'Display', 'Case', 'Other sealed unit'];
const isEditable = (phase: Phase) => ['scan', 'ready', 'unknown'].includes(phase);
const localDate = () => {
  const today = new Date();
  return `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
};
const emptyForm = (): Form => ({barcode: '', sku: '', name: '', game: '', unit: '', quantity: '', unitCost: '', supplier: '', notes: '', receivedDate: localDate(), replaceInvalidBarcode: false});
const createRequestId = () => globalThis.crypto?.randomUUID?.() || `pos-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}-${Math.random().toString(36).slice(2)}`;
const validation = (form: Form, product: Product | null, registering: boolean) => {
  if (!product && !registering) return 'Find an existing product or choose Register new sealed product.';
  if (!form.barcode.trim()) return 'Scan the manufacturer barcode first.';
  if (!form.name.trim() || !form.game.trim()) return 'Enter the product name and game.';
  if (!form.unit) return 'Choose the selling unit that matches the scanned package.';
  if (!/^\d+$/.test(form.quantity) || !Number.isSafeInteger(Number(form.quantity)) || Number(form.quantity) < 1) return 'Enter a whole quantity of at least 1.';
  if (!/^\d+(?:\.\d{1,2})?$/.test(form.unitCost)) return 'Enter the cost per unit with up to two decimals. Use 0 only for a zero-cost acquisition.';
  if (Number(form.unitCost) > 1000000) return 'Cost per unit must be no more than 1,000,000.';
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
    updateForm({...formRef.current, [key]: value});
  };
  const clearIdentity = (barcode: string) => {
    assignProduct(null); setRegistration(false); setResults([]); setSearched(false); setQuery('');
    updateForm({...formRef.current, barcode, sku: '', name: '', game: '', unit: '', quantity: '', unitCost: '', notes: '', replaceInvalidBarcode: false});
  };
  const changeBarcode = (value: string) => {
    if (!isEditable(phaseRef.current)) return;
    clearIdentity(value); transition('scan');
    alert('Find the product', 'Scan its selling unit or enter the barcode, then tap Find product.', 'info');
  };
  const selectProduct = (next: Product) => {
    if (!isEditable(phaseRef.current)) return;
    assignProduct(next); setRegistration(false); setResults([]);
    updateForm({...formRef.current, sku: next.sku, name: next.name, game: next.game, unit: next.unit || '', quantity: '', unitCost: '', replaceInvalidBarcode: false});
    transition('ready');
    alert('Check the package', 'Confirm the selling unit, quantity received, and cost per unit.', 'info');
  };
  const restoreRequest = (request: ReceiptInput) => {
    pendingRef.current = request;
    updateForm({...request, quantity: String(request.quantity)});
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
    void initialize();
    connectScanner();
    return () => { mounted.current = false; scannerCleanup.current?.(); };
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
      setResults(result.products || []); setSearched(true);
      alert('Select the exact product', result.products?.length ? 'Check the package and SKU before selecting.' : 'No catalog match. Check the search terms or register a new sealed product.', 'info');
    } catch {
      if (!mounted.current) return;
      transition(previous); alert('Search failed', 'Check your connection and try the catalog search again.');
    }
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
          locationId: receipt.locationId, locationName: receipt.locationName, currencyCode: receipt.currencyCode});
        pendingRef.current = null;
        transition('success');
        const staged = result.staged ? ' Stock is recorded. This product still needs a retail price, activation, and availability in POS before it can be sold.' : '';
        alert(result.duplicate ? 'Receipt already saved' : 'Receipt saved', `${receipt.quantity ?? request.quantity} × ${savedProduct.name} · SKU ${savedProduct.sku}. Receipt ${receipt.requestId || request.requestId}.${staged}`, 'success');
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
        <s-text>Scanner check rc3 · POS inputs: {scannerSources.join(', ') || 'none reported'} · Last scan: {lastScanSource || 'none received'}</s-text>
        <s-button disabled={!editable} onClick={connectScanner}>Check scanner connection</s-button>
        <s-text-field label="Manufacturer barcode" value={form.barcode} disabled={!editable}
          details="Scan the pack, box, display, or case you receive." onInput={(event) => changeBarcode((event.currentTarget.value ?? ''))} />
        <s-button disabled={!editable || !form.barcode.trim()} loading={phase === 'lookup'} onClick={() => void lookup(formRef.current.barcode)}>Find product</s-button>

        {(phase === 'unknown' || phase === 'search' || (!product && registering)) && <>
          <s-text-field label="Search existing catalog" value={query} disabled={!editable} onInput={(event) => { setQuery((event.currentTarget.value ?? '')); setSearched(false); setResults([]); }} />
          <s-button disabled={!editable || !query.trim()} loading={phase === 'search'} onClick={() => void search()}>Search by product name or SKU</s-button>
          {results.map((item) => <s-button key={item.sku} disabled={!editable} onClick={() => selectProduct(item)}>{item.name} · {item.sku}</s-button>)}
          {!registering && searched && <s-button disabled={!editable} onClick={() => {
            if (!isEditable(phaseRef.current)) return;
            setRegistration(true); transition('ready');
            alert('Register new sealed product', 'Enter the exact product and selling unit. A permanent store SKU is assigned when the receipt saves.', 'info');
          }}>Register new sealed product</s-button>}
        </>}

        {detailsVisible && <>
          <s-divider />
          {product && <s-text>Store SKU: {product.sku}</s-text>}
          <s-text-field label="Product name" value={form.name} required disabled={!editable || !!product} onInput={(event) => edit('name', (event.currentTarget.value ?? ''))} />
          <s-text-field label="Game" value={form.game} required disabled={!editable || !!product?.game} onInput={(event) => edit('game', (event.currentTarget.value ?? ''))} />
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
          const next = emptyForm(); next.supplier = formRef.current.supplier;
          updateForm(next); assignProduct(null); setRegistration(false); setQuery(''); setResults([]); setSearched(false);
          transition('scan'); alert('Ready for next product', 'Scan the manufacturer barcode on the next selling unit.', 'info');
        }}>Scan next product</s-button>}
      </s-stack>
    </s-scroll-box>
  </s-page>;
}
