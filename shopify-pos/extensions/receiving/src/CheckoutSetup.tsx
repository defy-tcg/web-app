import {useRef, useState} from 'preact/hooks';
import {makeAvailableAtCheckout, type CheckoutInput} from './receiving-checkout';
import type {Product} from './receiving-service';

type Props = {
  product: {productId: string; variantId: string; sku: string; name: string; price?: string};
  barcode: string;
  currency: string;
  initialPrice: string;
  onReady: (product: Product) => void;
  onClose: () => void;
};

export function CheckoutSetup({product, barcode, currency, initialPrice, onReady, onClose}: Props) {
  const [price, setPrice] = useState(initialPrice);
  const [busy, setBusy] = useState(false);
  const [ready, setReady] = useState(false);
  const [message, setMessage] = useState('Confirm the selling price, then make this package available in Shopify POS. This does not change stock or save a receipt.');
  const [failed, setFailed] = useState(false);
  const pending = useRef<CheckoutInput | null>(null);
  const running = useRef(false);

  async function prepare() {
    if (running.current || ready) return;
    if (!pending.current) {
      const entered = price.trim();
      if (entered && (!/^\d+(?:\.\d{1,2})?$/.test(entered) || Number(entered) <= 0 || Number(entered) > 1000000)) {
        setFailed(true); setMessage('Enter a store price greater than 0 with up to two decimals, or leave it blank to use the current Shopify price.');
        return;
      }
      pending.current = {
        requestId: globalThis.crypto?.randomUUID?.() || `checkout-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`,
        productId: product.productId, variantId: product.variantId, sku: product.sku, barcode,
        ...(entered ? {storePrice: entered} : {}),
      };
    }
    running.current = true; setBusy(true); setFailed(false);
    setMessage('Checking the barcode, selling price, and Point of Sale availability…');
    try {
      const result = await makeAvailableAtCheckout(pending.current);
      if (result.ok) {
        setReady(true); onReady(result.product);
        setMessage(`Ready in Shopify POS at ${currency} ${result.product.price}. Scan the original package barcode in the cart after POS finishes syncing. Stock was not changed.`);
      } else {
        setFailed(true); setMessage(`${result.error.message} Stock was not changed.`);
        if (!result.error.committedPossible) pending.current = null;
      }
    } catch {
      setFailed(true);
      setMessage('Checkout setup was not confirmed. Retry this same setup to check the result. Stock was not changed.');
    } finally {
      running.current = false; setBusy(false);
    }
  }

  return <s-section heading="Make available at checkout">
    <s-stack direction="block" gap="base">
      <s-text>{product.name} · SKU {product.sku}</s-text>
      <s-text>Package barcode: {barcode}</s-text>
      {product.price !== undefined && <s-text>Current Shopify price: {currency} {product.price}</s-text>}
      <s-banner heading={ready ? 'Ready for checkout' : failed ? 'Checkout setup needs attention' : 'Checkout availability'} tone={ready ? 'success' : failed ? 'warning' : 'info'} />
      <s-text>{message}</s-text>
      {!ready && <>
        <s-number-field label={`Store price per selling unit (${currency})`} value={price} controls="none" inputMode="decimal" min={0.01} max={1000000}
          disabled={busy || !!pending.current}
          details="Leave blank to keep the current Shopify price. A positive selling price is required for checkout setup."
          onInput={(event) => setPrice(event.currentTarget.value ?? '')} />
        <s-text>This activates eligible received products and makes them available to the Point of Sale channel.</s-text>
        <s-button variant="primary" loading={busy} disabled={busy} onClick={() => void prepare()}>{pending.current ? 'Check / retry checkout setup' : 'Make available at checkout'}</s-button>
      </>}
      <s-button disabled={busy} onClick={onClose}>Return to stock</s-button>
    </s-stack>
  </s-section>;
}
