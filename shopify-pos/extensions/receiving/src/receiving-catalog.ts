import {text, validation} from './receiving-validation.ts';

export const RECEIVING_CATALOG_GAMES = {pokemon: 'Pokémon', onepiece: 'One Piece', riftbound: 'Riftbound', gundam: 'Gundam'} as const;
export type CatalogReference = {game: keyof typeof RECEIVING_CATALOG_GAMES; id: string};
export type ReceiptCatalog = CatalogReference & {name: string; setName: string; language: 'English'};

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) validation('Select a verified sealed catalog product.');
  return value as Record<string, unknown>;
}

export function normalizeCatalogReference(value: unknown): CatalogReference {
  const input = object(value);
  if (typeof input.game !== 'string' || !Object.hasOwn(RECEIVING_CATALOG_GAMES, input.game)) validation('Choose Pokémon, One Piece, Riftbound, or Gundam for the catalog product.');
  const id = text(input.id, 'Catalog ID', 100, true);
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,99}$/.test(id)) validation('Select a valid sealed catalog ID.');
  return {game: input.game as CatalogReference['game'], id};
}

export function receivingCatalogKey(value: CatalogReference): string {
  const catalog = normalizeCatalogReference(value);
  return `scrydex:${catalog.game}:${catalog.id}`;
}

export function normalizeReceiptCatalog(value: unknown, name: string, game: string): ReceiptCatalog {
  const input = object(value);
  if (Object.keys(input).some(key => !['game', 'id', 'name', 'setName', 'language'].includes(key))) validation('Catalog identity must not include prices or other receipt fields.');
  const reference = normalizeCatalogReference(input);
  const catalogName = text(input.name, 'Catalog product name', 300, true);
  if (typeof input.setName !== 'string') validation('The catalog set must be supplied.');
  const setName = text(input.setName, 'Catalog set', 300, true);
  if (/[\u0000-\u001f\u007f]/.test(catalogName + setName)) validation('Catalog names must be single-line text.');
  if (input.language !== 'English') validation('Only English sealed catalog products are supported.');
  const displayGame = RECEIVING_CATALOG_GAMES[reference.game];
  if (name !== catalogName || (game !== displayGame && !(reference.game === 'pokemon' && game === 'Pokemon'))) validation('Receipt name and game must match the selected catalog product.');
  return {...reference, name: catalogName, setName, language: 'English'};
}

export function receivingCardMetadata(catalog: ReceiptCatalog) {
  return {name: catalog.name, game: RECEIVING_CATALOG_GAMES[catalog.game], set: catalog.setName,
    language: catalog.language, condition: 'U', finish: 'Normal', scrydex_id: catalog.id};
}
