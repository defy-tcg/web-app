import assert from "node:assert/strict";
import test from "node:test";
import { cardLanguageForGame, canonicalizeGame, gameCode, gameFromAlias, TCG_GAME_REGISTRY, tcgplayerCategoryIdForGame } from "../lib/tcg-games.ts";

test("Japanese Pokémon has a separate canonical game, category and SKU code", () => {
  for (const value of ["Pokémon (Japanese)", "pokemon-japanese", "Pokemon Japan", "Japanese Pokémon"]) {
    assert.equal(canonicalizeGame(value), "Pokémon (Japanese)");
    assert.equal(gameFromAlias(value)?.key, "pokemon-japanese");
    assert.equal(tcgplayerCategoryIdForGame(value), 85); assert.equal(gameCode(value), "PKJ");
    assert.equal(cardLanguageForGame(value), "Japanese");
  }
  assert.equal(TCG_GAME_REGISTRY.find(game => game.tcgplayerCategoryId === 85)?.name, "Pokémon (Japanese)");
  assert.equal(tcgplayerCategoryIdForGame("Pokémon"), 3); assert.equal(gameCode("Pokémon"), "PKM");
});

test("card language does not infer Japanese from unrelated titles, set labels, or unknown games", () => {
  for (const value of ["Pokémon", "Other", "Riftbound", "Charmander (Japanese)", "SV2a: Pokemon Card 151", "Japanese", undefined, null]) {
    assert.equal(cardLanguageForGame(value), "English");
  }
});
