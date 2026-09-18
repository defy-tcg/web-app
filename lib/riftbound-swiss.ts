export type SwissPlayer = { id: string; name: string };

export type SwissMatch = {
  table: number;
  player1Id: string;
  player2Id: string | null;
  result: "player1" | "player2" | "draw" | "bye" | null;
};

export type SwissRound = { number: number; matches: SwissMatch[] };

export type SwissStanding = SwissPlayer & {
  points: number;
  wins: number;
  losses: number;
  draws: number;
  byes: number;
};

export type SwissTournament = {
  version: 1;
  name: string;
  players: SwissPlayer[];
  rounds: SwissRound[];
};

const MAX_PLAYERS = 64;
const MAX_ROUNDS = 128;
const PAIRING_SEARCH_BUDGET = 40_000;
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/;

function nameKey(name: string) {
  return name.normalize("NFKC").replace(/\s+/g, " ").toLocaleLowerCase("en-US");
}

export function parsePlayerNames(text: string): string[] {
  const names = text
    .split(/\r?\n/)
    .map((name) => name.trim().replace(/\s+/g, " "))
    .filter(Boolean);
  if (names.length < 2)
    throw new Error("Enter at least 2 players, one per line.");
  if (names.length > MAX_PLAYERS)
    throw new Error(`Use no more than ${MAX_PLAYERS} players.`);
  const seen = new Set<string>();
  for (const name of names) {
    if (name.length > 80 || CONTROL_CHARACTERS.test(name)) {
      throw new Error(
        "Player names must be 80 characters or fewer and contain no control characters.",
      );
    }
    const key = nameKey(name);
    if (seen.has(key))
      throw new Error(
        `Duplicate player: ${name}. Add a distinguishing name or initial.`,
      );
    seen.add(key);
  }
  return names;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasKeys(value: Record<string, unknown>, keys: string[]) {
  return (
    Object.keys(value).length === keys.length &&
    keys.every((key) => Object.hasOwn(value, key))
  );
}

function validText(value: unknown, maximum: number): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= maximum &&
    value === value.trim() &&
    !CONTROL_CHARACTERS.test(value)
  );
}

function validatePlayers(value: unknown): asserts value is SwissPlayer[] {
  if (!Array.isArray(value) || value.length < 2 || value.length > MAX_PLAYERS) {
    throw new Error(`A Swiss tournament needs 2–${MAX_PLAYERS} players.`);
  }
  const ids = new Set<string>();
  const names = new Set<string>();
  for (const player of value) {
    if (
      !isRecord(player) ||
      !hasKeys(player, ["id", "name"]) ||
      !validText(player.id, 128) ||
      !validText(player.name, 80)
    ) {
      throw new Error("The saved player roster is invalid.");
    }
    if (ids.has(player.id) || names.has(nameKey(player.name))) {
      throw new Error("The saved player roster contains duplicate players.");
    }
    ids.add(player.id);
    names.add(nameKey(player.name));
  }
}

function validateRounds(
  value: unknown,
  players: SwissPlayer[],
): asserts value is SwissRound[] {
  if (!Array.isArray(value) || value.length > MAX_ROUNDS) {
    throw new Error("The saved round history is invalid.");
  }
  const playerIds = new Set(players.map((player) => player.id));
  value.forEach((round: unknown, roundIndex) => {
    if (
      !isRecord(round) ||
      !hasKeys(round, ["number", "matches"]) ||
      round.number !== roundIndex + 1 ||
      !Array.isArray(round.matches) ||
      round.matches.length !== Math.ceil(players.length / 2)
    ) {
      throw new Error("The saved round history is invalid.");
    }
    const appearances = new Set<string>();
    let byes = 0;
    round.matches.forEach((match: unknown, matchIndex: number) => {
      if (
        !isRecord(match) ||
        !hasKeys(match, ["table", "player1Id", "player2Id", "result"]) ||
        match.table !== matchIndex + 1 ||
        typeof match.player1Id !== "string" ||
        !playerIds.has(match.player1Id) ||
        appearances.has(match.player1Id)
      ) {
        throw new Error(
          "The saved pairings contain an invalid or repeated player.",
        );
      }
      appearances.add(match.player1Id);
      if (match.player2Id === null) {
        if (match.result !== "bye")
          throw new Error("A bye must have its automatic win recorded.");
        byes += 1;
      } else {
        if (
          typeof match.player2Id !== "string" ||
          !playerIds.has(match.player2Id) ||
          appearances.has(match.player2Id) ||
          !["player1", "player2", "draw", null].includes(
            match.result as string | null,
          )
        ) {
          throw new Error("The saved pairings or results are invalid.");
        }
        appearances.add(match.player2Id);
        if (match.result === null && roundIndex !== value.length - 1) {
          throw new Error(
            "Finish all results in a round before starting the next round.",
          );
        }
      }
    });
    if (appearances.size !== players.length || byes !== players.length % 2) {
      throw new Error(
        "Every player must appear exactly once per round, with a bye only for an odd roster.",
      );
    }
  });
}

/** Rebuild known fields after validating untrusted browser storage or a backup. */
export function parseSwissTournament(raw: string): SwissTournament {
  if (raw.length > 1_000_000)
    throw new Error("The saved tournament is too large.");
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new Error("The saved tournament is not valid JSON.");
  }
  if (
    !isRecord(value) ||
    !hasKeys(value, ["version", "name", "players", "rounds"]) ||
    value.version !== 1 ||
    !validText(value.name, 120)
  ) {
    throw new Error("The saved tournament format is invalid.");
  }
  validatePlayers(value.players);
  validateRounds(value.rounds, value.players);
  return {
    version: 1,
    name: value.name,
    players: value.players.map(({ id, name }) => ({ id, name })),
    rounds: value.rounds.map(({ number, matches }) => ({
      number,
      matches: matches.map(({ table, player1Id, player2Id, result }) => ({
        table,
        player1Id,
        player2Id,
        result,
      })),
    })),
  };
}

export function getSwissStandings(
  players: SwissPlayer[],
  rounds: SwissRound[],
): SwissStanding[] {
  validatePlayers(players);
  validateRounds(rounds, players);
  const standings = players.map((player) => ({
    ...player,
    points: 0,
    wins: 0,
    losses: 0,
    draws: 0,
    byes: 0,
  }));
  const byId = new Map(standings.map((standing) => [standing.id, standing]));
  for (const round of rounds) {
    for (const match of round.matches) {
      if (match.result === null) continue;
      const first = byId.get(match.player1Id)!;
      if (match.result === "bye") {
        first.points += 3;
        first.wins += 1;
        first.byes += 1;
        continue;
      }
      const second = byId.get(match.player2Id!)!;
      if (match.result === "draw") {
        first.points += 1;
        second.points += 1;
        first.draws += 1;
        second.draws += 1;
      } else {
        const [winner, loser] =
          match.result === "player1" ? [first, second] : [second, first];
        winner.points += 3;
        winner.wins += 1;
        loser.losses += 1;
      }
    }
  }
  // Stable sorting preserves roster order for tied points; no hidden tiebreaker.
  return standings.sort((first, second) => second.points - first.points);
}

function shuffled<T>(items: T[], random: () => number): T[] {
  const result = [...items];
  for (let index = result.length - 1; index > 0; index -= 1) {
    const sample = random();
    if (!Number.isFinite(sample) || sample < 0 || sample >= 1) {
      throw new Error(
        "The random source must return a number from 0 up to, but not including, 1.",
      );
    }
    const target = Math.floor(sample * (index + 1));
    [result[index], result[target]] = [result[target], result[index]];
  }
  return result;
}

type Pair = [SwissStanding, SwissStanding];

export function createSwissRound(
  players: SwissPlayer[],
  rounds: SwissRound[],
  random: () => number = Math.random,
): SwissRound {
  const standings = getSwissStandings(players, rounds);
  if (
    rounds.some((round) => round.matches.some((match) => match.result === null))
  ) {
    throw new Error(
      "Record every match result before generating the next round.",
    );
  }
  if (rounds.length >= MAX_ROUNDS)
    throw new Error(
      `This tournament has reached the ${MAX_ROUNDS}-round limit.`,
    );

  const ordered = shuffled(standings, random).sort(
    (first, second) => second.points - first.points,
  );
  let bye: SwissStanding | undefined;
  let byeCandidates: SwissStanding[] = [];
  if (ordered.length % 2 === 1) {
    // Least prior byes first, then lowest points, with randomized ties.
    bye = [...ordered].sort(
      (first, second) =>
        first.byes - second.byes || first.points - second.points,
    )[0];
    byeCandidates = ordered.filter(
      (player) => player.byes === bye!.byes && player.points === bye!.points,
    );
  }
  const active = ordered.filter((player) => player !== bye);
  const opponents = new Map(
    players.map((player) => [player.id, new Map<string, number>()]),
  );
  for (const round of rounds) {
    for (const match of round.matches) {
      if (match.player2Id === null) continue;
      const first = opponents.get(match.player1Id)!;
      const second = opponents.get(match.player2Id)!;
      first.set(match.player2Id, (first.get(match.player2Id) ?? 0) + 1);
      second.set(match.player1Id, (second.get(match.player1Id) ?? 0) + 1);
    }
  }
  const timesPlayed = (first: SwissStanding, second: SwissStanding) =>
    opponents.get(first.id)!.get(second.id) ?? 0;
  let nodes = 0;

  // Explore close-score opponents first, backtracking when a greedy choice
  // would strand the remaining players. The cap keeps large rosters responsive.
  function withoutRematches(remaining: SwissStanding[]): Pair[] | null {
    if (remaining.length === 0) return [];
    if (nodes >= PAIRING_SEARCH_BUDGET) return null;
    nodes += 1;
    const [first, ...rest] = remaining;
    const candidates = rest
      .filter((second) => timesPlayed(first, second) === 0)
      .sort(
        (left, right) =>
          Math.abs(first.points - left.points) -
          Math.abs(first.points - right.points),
      );
    for (const second of candidates) {
      if (nodes >= PAIRING_SEARCH_BUDGET) break;
      const others = rest.filter((player) => player !== second);
      // An isolated player cannot complete this branch.
      if (
        others.some(
          (player) =>
            !others.some(
              (opponent) =>
                player !== opponent && timesPlayed(player, opponent) === 0,
            ),
        )
      )
        continue;
      const tail = withoutRematches(others);
      if (tail) return [[first, second], ...tail];
    }
    return null;
  }

  let pairs = withoutRematches(active);
  if (!pairs) {
    for (const alternateBye of byeCandidates) {
      if (alternateBye === bye || nodes >= PAIRING_SEARCH_BUDGET) continue;
      const alternative = withoutRematches(
        ordered.filter((player) => player !== alternateBye),
      );
      if (alternative) {
        bye = alternateBye;
        pairs = alternative;
        break;
      }
    }
  }
  if (!pairs) {
    // An exhausted opponent pool (or search budget) still needs a usable round.
    // Prefer fewer previous meetings before comparing the score gap.
    pairs = [];
    const remaining = [...active];
    while (remaining.length) {
      const first = remaining.shift()!;
      remaining.sort(
        (left, right) =>
          timesPlayed(first, left) - timesPlayed(first, right) ||
          Math.abs(first.points - left.points) -
            Math.abs(first.points - right.points),
      );
      pairs.push([first, remaining.shift()!]);
    }
  }
  const matches: SwissMatch[] = pairs.map(([first, second], index) => ({
    table: index + 1,
    player1Id: first.id,
    player2Id: second.id,
    result: null,
  }));
  if (bye)
    matches.push({
      table: matches.length + 1,
      player1Id: bye.id,
      player2Id: null,
      result: "bye",
    });
  return { number: rounds.length + 1, matches };
}
