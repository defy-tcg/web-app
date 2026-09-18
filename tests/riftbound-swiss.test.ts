import assert from "node:assert/strict";
import test from "node:test";

import {
  createSwissRound,
  getSwissStandings,
  parsePlayerNames,
  parseSwissTournament,
  type SwissPlayer,
  type SwissRound,
  type SwissTournament,
} from "../lib/riftbound-swiss.ts";

function roster(count: number): SwissPlayer[] {
  return Array.from({ length: count }, (_, index) => ({
    id: `p${index + 1}`,
    name: `Player ${index + 1}`,
  }));
}

function complete(
  round: SwissRound,
  result: "player1" | "player2" | "draw" = "player1",
): SwissRound {
  return {
    ...round,
    matches: round.matches.map((match) => ({
      ...match,
      result: match.player2Id === null ? "bye" : result,
    })),
  };
}

function pairKey(first: string, second: string) {
  return [first, second].sort().join("/");
}

function assertCoverage(players: SwissPlayer[], round: SwissRound) {
  const paired = round.matches.flatMap((match) =>
    match.player2Id === null
      ? [match.player1Id]
      : [match.player1Id, match.player2Id],
  );
  assert.deepEqual(
    [...paired].sort(),
    players.map((player) => player.id).sort(),
  );
  assert.equal(new Set(paired).size, players.length);
  assert.equal(
    round.matches.filter((match) => match.player2Id === null).length,
    players.length % 2,
  );
  assert.deepEqual(
    round.matches.map((match) => match.table),
    Array.from({ length: round.matches.length }, (_, index) => index + 1),
  );
}

test("Swiss rosters normalize blank lines and reject duplicate or invalid names", () => {
  assert.deepEqual(parsePlayerNames("  Alice  Nguyen \r\n\nBob\n"), [
    "Alice Nguyen",
    "Bob",
  ]);
  assert.throws(() => parsePlayerNames("Alice"), /at least 2/);
  assert.throws(() => parsePlayerNames("Alice\nalice"), /Duplicate/);
  assert.throws(
    () => parsePlayerNames(`${"x".repeat(81)}\nBob`),
    /80 characters/,
  );
  assert.throws(
    () =>
      parsePlayerNames(
        Array.from({ length: 65 }, (_, index) => `P${index}`).join("\n"),
      ),
    /64 players/,
  );
});

test("opening rounds shuffle without mutating the roster, covering even and odd sizes", () => {
  for (const size of [2, 3, 4, 7, 32, 63, 64]) {
    const players = roster(size);
    const original = structuredClone(players);
    const first = createSwissRound(players, [], () => 0);
    const alternate = createSwissRound(players, [], () => 0.999);
    assertCoverage(players, first);
    assertCoverage(players, alternate);
    assert.deepEqual(players, original);
    assert.notDeepEqual(
      first.matches.map((match) => match.player1Id),
      alternate.matches.map((match) => match.player1Id),
    );
    for (const match of first.matches)
      assert.equal(match.result, match.player2Id === null ? "bye" : null);
  }
});

test("standings award three points per win or bye and one per draw, preserving tied roster order", () => {
  const players = roster(5);
  const rounds: SwissRound[] = [
    {
      number: 1,
      matches: [
        { table: 1, player1Id: "p1", player2Id: "p2", result: "player2" },
        { table: 2, player1Id: "p3", player2Id: "p4", result: "draw" },
        { table: 3, player1Id: "p5", player2Id: null, result: "bye" },
      ],
    },
  ];
  const standings = getSwissStandings(players, rounds);
  assert.deepEqual(
    standings.map(({ id, points, wins, losses, draws, byes }) => ({
      id,
      points,
      wins,
      losses,
      draws,
      byes,
    })),
    [
      { id: "p2", points: 3, wins: 1, losses: 0, draws: 0, byes: 0 },
      { id: "p5", points: 3, wins: 1, losses: 0, draws: 0, byes: 1 },
      { id: "p3", points: 1, wins: 0, losses: 0, draws: 1, byes: 0 },
      { id: "p4", points: 1, wins: 0, losses: 0, draws: 1, byes: 0 },
      { id: "p1", points: 0, wins: 0, losses: 1, draws: 0, byes: 0 },
    ],
  );
  const next = createSwissRound(players, rounds, () => 0.999);
  assert.equal(
    next.matches.find((match) => match.result === "bye")?.player1Id,
    "p1",
  );
});

test("later pairings group equal scores and avoid previous opponents", () => {
  const players = roster(8);
  const first = complete(createSwissRound(players, [], () => 0.999));
  const next = createSwissRound(players, [first], () => 0.999);
  const points = new Map(
    getSwissStandings(players, [first]).map((player) => [
      player.id,
      player.points,
    ]),
  );
  const previousPairs = new Set(
    first.matches.map((match) => pairKey(match.player1Id, match.player2Id!)),
  );
  assertCoverage(players, next);
  for (const match of next.matches) {
    assert.equal(points.get(match.player1Id), points.get(match.player2Id!));
    assert.equal(
      previousPairs.has(pairKey(match.player1Id, match.player2Id!)),
      false,
    );
  }
});

test("pairing search backs out of a greedy rematch trap", () => {
  const players = roster(6);
  const history: SwissRound[] = [
    {
      number: 1,
      matches: [
        { table: 1, player1Id: "p1", player2Id: "p3", result: "draw" },
        { table: 2, player1Id: "p2", player2Id: "p5", result: "draw" },
        { table: 3, player1Id: "p4", player2Id: "p6", result: "draw" },
      ],
    },
    {
      number: 2,
      matches: [
        { table: 1, player1Id: "p1", player2Id: "p4", result: "draw" },
        { table: 2, player1Id: "p2", player2Id: "p6", result: "draw" },
        { table: 3, player1Id: "p3", player2Id: "p5", result: "draw" },
      ],
    },
    {
      number: 3,
      matches: [
        { table: 1, player1Id: "p1", player2Id: "p5", result: "draw" },
        { table: 2, player1Id: "p2", player2Id: "p4", result: "draw" },
        { table: 3, player1Id: "p3", player2Id: "p6", result: "draw" },
      ],
    },
  ];
  // p1-p2 looks available, but it leaves p3-p4 and p5-p6 as the only
  // completion in this graph. Record p5-p6 to make that branch impossible.
  history.push({
    number: 4,
    matches: [
      { table: 1, player1Id: "p1", player2Id: "p3", result: "draw" },
      { table: 2, player1Id: "p2", player2Id: "p4", result: "draw" },
      { table: 3, player1Id: "p5", player2Id: "p6", result: "draw" },
    ],
  });
  const next = createSwissRound(players, history, () => 0.999);
  const previousPairs = new Set(
    history.flatMap((round) =>
      round.matches.map((match) => pairKey(match.player1Id, match.player2Id!)),
    ),
  );
  assertCoverage(players, next);
  for (const match of next.matches)
    assert.equal(
      previousPairs.has(pairKey(match.player1Id, match.player2Id!)),
      false,
    );
  assert.notEqual(next.matches[0].player2Id, "p2");
});

test("byes rotate before repeating and exhausted opponent pools still produce a complete round", () => {
  const players = roster(3);
  const history: SwissRound[] = [];
  const byes = new Set<string>();
  for (let index = 0; index < 3; index += 1) {
    const round = complete(createSwissRound(players, history, () => 0.999));
    assertCoverage(players, round);
    byes.add(round.matches.find((match) => match.result === "bye")!.player1Id);
    history.push(round);
  }
  assert.equal(byes.size, 3);
  assertCoverage(
    players,
    createSwissRound(players, history, () => 0.999),
  );

  const pair = roster(2);
  const first = complete(createSwissRound(pair, [], () => 0.999));
  assertCoverage(
    pair,
    createSwissRound(pair, [first], () => 0.999),
  );
});

test("equally eligible bye recipients are reconsidered to avoid a repeat pairing", () => {
  const players = roster(5);
  const history: SwissRound[] = [
    {
      number: 1,
      matches: [
        { table: 1, player1Id: "p3", player2Id: "p1", result: "player2" },
        { table: 2, player1Id: "p4", player2Id: "p2", result: "draw" },
        { table: 3, player1Id: "p5", player2Id: null, result: "bye" },
      ],
    },
    {
      number: 2,
      matches: [
        { table: 1, player1Id: "p5", player2Id: "p1", result: "player1" },
        { table: 2, player1Id: "p3", player2Id: "p2", result: "player2" },
        { table: 3, player1Id: "p4", player2Id: null, result: "bye" },
      ],
    },
    {
      number: 3,
      matches: [
        { table: 1, player1Id: "p5", player2Id: "p2", result: "player1" },
        { table: 2, player1Id: "p3", player2Id: "p1", result: "player1" },
        { table: 3, player1Id: "p4", player2Id: null, result: "bye" },
      ],
    },
  ];
  // p1 and p3 each have three points and no byes. Giving p1 the bye
  // forces a repeat; giving p3 the bye permits p1-p2 and p4-p5.
  const next = createSwissRound(players, history, () => 0.999);
  assertCoverage(players, next);
  assert.equal(
    next.matches.find((match) => match.result === "bye")?.player1Id,
    "p3",
  );
  const previousPairs = new Set(
    history.flatMap((round) =>
      round.matches
        .filter((match) => match.player2Id !== null)
        .map((match) => pairKey(match.player1Id, match.player2Id!)),
    ),
  );
  for (const match of next.matches) {
    if (match.player2Id !== null)
      assert.equal(
        previousPairs.has(pairKey(match.player1Id, match.player2Id)),
        false,
      );
  }
});

test("incomplete results cannot advance the round or award pending points", () => {
  const players = roster(4);
  const first = createSwissRound(players, [], () => 0.999);
  assert.throws(() => createSwissRound(players, [first]), /every match result/);
  assert.deepEqual(
    getSwissStandings(players, [first]).map((player) => player.points),
    [0, 0, 0, 0],
  );
});

test("saved tournaments round-trip while preserving pending final-round results", () => {
  const players = roster(5);
  const first = complete(createSwissRound(players, [], () => 0.999));
  const state: SwissTournament = {
    version: 1,
    name: "Friday Riftbound",
    players,
    rounds: [first, createSwissRound(players, [first], () => 0.999)],
  };
  assert.deepEqual(parseSwissTournament(JSON.stringify(state)), state);
  assert.deepEqual(
    parseSwissTournament(JSON.stringify({ ...state, rounds: [] })).rounds,
    [],
  );
});

test("saved tournament validation rejects malformed data and corrupt history", () => {
  const players = roster(4);
  const first = complete(createSwissRound(players, [], () => 0.999));
  const state: SwissTournament = {
    version: 1,
    name: "Friday Riftbound",
    players,
    rounds: [first],
  };
  const corrupted: unknown[] = [
    null,
    { ...state, version: 2 },
    { ...state, name: "" },
    { ...state, extra: true },
    { ...state, players: [players[0], players[0]] },
    { ...state, players: [players[0], { id: "second", name: "player 1" }] },
    {
      ...state,
      players: [{ ...players[0], name: "x".repeat(81) }, ...players.slice(1)],
    },
    { ...state, rounds: [{ ...first, number: 2 }] },
    { ...state, rounds: [{ ...first, matches: first.matches.slice(0, 1) }] },
    {
      ...state,
      rounds: [
        {
          ...first,
          matches: [
            { ...first.matches[0], player2Id: "missing" },
            first.matches[1],
          ],
        },
      ],
    },
    {
      ...state,
      rounds: [
        {
          ...first,
          matches: [{ ...first.matches[0], player2Id: "p1" }, first.matches[1]],
        },
      ],
    },
    {
      ...state,
      rounds: [
        {
          ...first,
          matches: [{ ...first.matches[0], table: 2 }, first.matches[1]],
        },
      ],
    },
    {
      ...state,
      rounds: [
        {
          ...first,
          matches: [{ ...first.matches[0], result: "bye" }, first.matches[1]],
        },
      ],
    },
    {
      ...state,
      rounds: [
        {
          ...first,
          matches: [
            { ...first.matches[0], result: "invalid" },
            first.matches[1],
          ],
        },
      ],
    },
    {
      ...state,
      rounds: [
        createSwissRound(players, [], () => 0.999),
        { ...first, number: 2 },
      ],
    },
  ];
  for (const invalid of corrupted)
    assert.throws(() => parseSwissTournament(JSON.stringify(invalid)));
  assert.throws(() => parseSwissTournament("not json"), /valid JSON/);
  assert.throws(() => parseSwissTournament(" ".repeat(1_000_001)), /too large/);

  const oddPlayers = roster(3);
  const oddRound = createSwissRound(oddPlayers, [], () => 0.999);
  oddRound.matches[1].result = null;
  assert.throws(
    () =>
      parseSwissTournament(
        JSON.stringify({ ...state, players: oddPlayers, rounds: [oddRound] }),
      ),
    /bye/,
  );
});
