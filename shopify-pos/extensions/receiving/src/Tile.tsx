import {render} from 'preact';
import '@shopify/ui-extensions/preact';
import type {Api} from '@shopify/ui-extensions/pos.home.tile.render';

declare const shopify: Api;

export default async () => {
  render(<s-tile heading="Receive sealed stock" subheading="Scan • check • save"
    onClick={() => shopify.action.presentModal()} />, document.body);
};
