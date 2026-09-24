import '@shopify/ui-extensions/preact';
import type {Api} from '@shopify/ui-extensions/pos.home.tile.render';
import {render} from 'preact';

declare const shopify: Api;

export default function extension() {
  render(<s-tile heading="Pokémon Sealed" subheading="Scan for a live Scrydex price"
    onClick={() => shopify.action.presentModal()} />, document.body);
}
