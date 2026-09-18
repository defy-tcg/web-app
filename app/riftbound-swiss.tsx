"use client";

import { type FormEvent, useEffect, useState } from "react";
import "./riftbound-swiss.css";
import {
  createSwissRound,
  getSwissStandings,
  parsePlayerNames,
  parseSwissTournament,
  type SwissMatch,
  type SwissRound,
  type SwissTournament,
} from "@/lib/riftbound-swiss";

const STORAGE_KEY = "defy-riftbound-swiss:v1";

export default function RiftboundSwiss() {
  const [tournament, setTournament] = useState<SwissTournament | null>(null);
  const [ready, setReady] = useState(false);
  const [name, setName] = useState("Riftbound Swiss");
  const [roster, setRoster] = useState("");
  const [error, setError] = useState("");
  const [storageMessage, setStorageMessage] = useState("");
  const [savedSnapshot, setSavedSnapshot] = useState<string | null>(null);

  useEffect(() => {
    // Hydrate browser-only progress after the server and first client render agree.
    try {
      const saved = localStorage.getItem(STORAGE_KEY);
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setSavedSnapshot(saved);
      if (saved) setTournament(parseSwissTournament(saved));
    } catch {
      setStorageMessage(
        "Saved progress could not be restored. Starting a new tournament will replace it.",
      );
    }
    setReady(true);
  }, []);

  function save(next: SwissTournament | null) {
    setError("");
    try {
      const stored = localStorage.getItem(STORAGE_KEY);
      if (stored !== savedSnapshot) {
        // Refuse stale writes from another tab instead of losing its results.
        try {
          const latest = stored ? parseSwissTournament(stored) : null;
          setSavedSnapshot(stored);
          setTournament(latest);
          setError(
            "The tournament changed in another tab. Latest progress loaded; repeat your action.",
          );
        } catch {
          setError(
            "Saved progress changed and could not be read. Reload this page before making changes.",
          );
        }
        return;
      }
      const serialized = next ? JSON.stringify(next) : null;
      if (serialized) localStorage.setItem(STORAGE_KEY, serialized);
      else localStorage.removeItem(STORAGE_KEY);
      setSavedSnapshot(serialized);
      setStorageMessage("");
    } catch {
      setStorageMessage(
        "Browser storage is unavailable. Keep this screen open and download your results before leaving.",
      );
    }
    setTournament(next);
  }

  function start(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    try {
      const players = parsePlayerNames(roster).map((playerName) => ({
        id: crypto.randomUUID(),
        name: playerName,
      }));
      const next: SwissTournament = {
        version: 1,
        name: name.trim().replace(/\s+/g, " ") || "Riftbound Swiss",
        players,
        rounds: [createSwissRound(players, [])],
      };
      save(parseSwissTournament(JSON.stringify(next)));
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : "Could not generate pairings.",
      );
    }
  }

  function nextRound() {
    if (!tournament) return;
    try {
      save({
        ...tournament,
        rounds: [
          ...tournament.rounds,
          createSwissRound(tournament.players, tournament.rounds),
        ],
      });
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : "Could not generate pairings.",
      );
    }
  }

  function recordResult(table: number, result: SwissMatch["result"]) {
    if (!tournament) return;
    save({
      ...tournament,
      rounds: tournament.rounds.map((round, index) =>
        index === tournament.rounds.length - 1
          ? {
              ...round,
              matches: round.matches.map((match) =>
                match.table === table ? { ...match, result } : match,
              ),
            }
          : round,
      ),
    });
  }

  function undoRound() {
    if (
      !tournament ||
      !window.confirm(
        "Remove the current round and its results? You can then correct the previous round and generate new pairings.",
      )
    )
      return;
    save({ ...tournament, rounds: tournament.rounds.slice(0, -1) });
  }

  function reset() {
    if (
      !window.confirm(
        "Start a new tournament? This clears the saved roster, pairings, and results on this browser.",
      )
    )
      return;
    save(null);
    setRoster("");
    setName("Riftbound Swiss");
  }

  function downloadResults() {
    if (!tournament) return;
    const lines = [
      tournament.name,
      "",
      "Standings (match points; equal points share a place)",
      ...getSwissStandings(tournament.players, tournament.rounds).map(
        (player) =>
          `${player.name}: ${player.points} points · ${player.wins}W / ${player.losses}L / ${player.draws}D · ${player.byes} bye(s)`,
      ),
    ];
    for (const round of tournament.rounds) {
      lines.push("", `Round ${round.number}`);
      for (const match of round.matches) {
        lines.push(
          `Table ${match.table}: ${playerName(match.player1Id)} vs ${match.player2Id ? playerName(match.player2Id) : "BYE"} — ${resultLabel(match)}`,
        );
      }
    }
    const url = URL.createObjectURL(
      new Blob([lines.join("\n")], { type: "text/plain;charset=utf-8" }),
    );
    const link = document.createElement("a");
    link.href = url;
    link.download = "riftbound-swiss-results.txt";
    link.click();
    URL.revokeObjectURL(url);
  }

  function playerName(id: string) {
    return (
      tournament?.players.find((player) => player.id === id)?.name ??
      "Unknown player"
    );
  }

  function resultLabel(match: SwissMatch) {
    if (match.result === "bye") return "Bye · 3 points";
    if (match.result === "draw") return "Draw";
    if (match.result === "player1")
      return `${playerName(match.player1Id)} wins`;
    if (match.result === "player2" && match.player2Id)
      return `${playerName(match.player2Id)} wins`;
    return "Awaiting result";
  }

  function renderPairings(round: SwissRound, editable: boolean) {
    return (
      <div className="swiss-pairings">
        {round.matches.map((match) => {
          const rematch = tournament?.rounds
            .slice(0, round.number - 1)
            .some((previous) =>
              previous.matches.some(
                (pair) =>
                  match.player2Id !== null &&
                  ((pair.player1Id === match.player1Id &&
                    pair.player2Id === match.player2Id) ||
                    (pair.player1Id === match.player2Id &&
                      pair.player2Id === match.player1Id)),
              ),
            );
          return (
            <article className="swiss-match" key={match.table}>
              <span className="swiss-table">
                {match.player2Id ? `Table ${match.table}` : "Bye"}
              </span>
              <div className="swiss-opponents">
                <strong>{playerName(match.player1Id)}</strong>
                {match.player2Id && (
                  <>
                    <span>vs</span>
                    <strong>{playerName(match.player2Id)}</strong>
                  </>
                )}
                {rematch && (
                  <small className="swiss-rematch">
                    Repeat opponent — review pairing
                  </small>
                )}
              </div>
              {editable && match.player2Id ? (
                <label className="swiss-result">
                  <span>Match result</span>
                  <select
                    aria-label={`Table ${match.table} result`}
                    value={match.result ?? ""}
                    onChange={(event) =>
                      recordResult(
                        match.table,
                        (event.target.value || null) as SwissMatch["result"],
                      )
                    }
                  >
                    <option value="">Awaiting result</option>
                    <option value="player1">
                      {playerName(match.player1Id)} wins
                    </option>
                    <option value="player2">
                      {playerName(match.player2Id)} wins
                    </option>
                    <option value="draw">Draw</option>
                  </select>
                </label>
              ) : (
                <span className="swiss-result-text">{resultLabel(match)}</span>
              )}
            </article>
          );
        })}
      </div>
    );
  }

  const currentRound = tournament?.rounds.at(-1);
  const pending =
    currentRound?.matches.filter((match) => match.result === null).length ?? 0;
  const standings = tournament
    ? getSwissStandings(tournament.players, tournament.rounds)
    : [];

  return (
    <section className="panel swiss-panel" aria-labelledby="swiss-title">
      <header>
        <div>
          <h2 id="swiss-title">Riftbound Swiss randomizer</h2>
          <p>Pair players, record results, and run the next round.</p>
        </div>
        {tournament && (
          <button className="secondary-button" onClick={reset}>
            New tournament
          </button>
        )}
      </header>
      <div className="swiss-body">
        {error && (
          <p className="swiss-notice negative" role="alert">
            {error}
          </p>
        )}
        {storageMessage && (
          <p className="swiss-notice" role="status">
            {storageMessage}
          </p>
        )}
        {!ready ? (
          <p className="swiss-help">Loading saved tournament…</p>
        ) : !tournament ? (
          <form className="swiss-setup" onSubmit={start}>
            <div className="swiss-fields">
              <label htmlFor="swiss-name">Tournament name</label>
              <input
                id="swiss-name"
                maxLength={120}
                value={name}
                onChange={(event) => setName(event.target.value)}
              />
              <label htmlFor="swiss-roster">Players · one name per line</label>
              <textarea
                id="swiss-roster"
                rows={7}
                value={roster}
                onChange={(event) => setRoster(event.target.value)}
                placeholder={"Alex\nSam\nJordan\nTaylor"}
                aria-describedby="swiss-roster-help"
                required
              />
              <p id="swiss-roster-help" className="swiss-help">
                2–64 players. Use distinct names so results go to the right
                person.
              </p>
              <button className="primary-button" type="submit">
                Randomize round 1
              </button>
            </div>
            <div className="swiss-guide">
              <span className="eyebrow">READY TO PLAY</span>
              <h3>A fair start. A new matchup each round.</h3>
              <p>
                The first round is shuffled. Later rounds pair players with
                similar match points and try to avoid repeat opponents.
              </p>
              <p>
                An odd player count gets an automatic bye, with priority given
                to players who have received fewer byes and have fewer points.
              </p>
              <p>Win or bye: 3 points · Draw: 1 · Loss: 0</p>
            </div>
          </form>
        ) : (
          <>
            <div className="swiss-round-heading">
              <div>
                <h3>{tournament.name}</h3>
                <p className="swiss-help">
                  {tournament.players.length} players ·{" "}
                  {currentRound
                    ? `Round ${currentRound.number}`
                    : "Ready for round 1"}
                </p>
              </div>
              <button className="secondary-button" onClick={downloadResults}>
                Download results
              </button>
            </div>
            {currentRound && renderPairings(currentRound, true)}
            <div className="swiss-actions">
              <button
                className="primary-button"
                disabled={pending > 0}
                onClick={nextRound}
              >
                {currentRound
                  ? `Generate round ${currentRound.number + 1}`
                  : "Randomize round 1"}
              </button>
              {currentRound && (
                <button className="secondary-button" onClick={undoRound}>
                  Undo round {currentRound.number}
                </button>
              )}
              <p className="swiss-help" role="status">
                {pending
                  ? `${pending} match${pending === 1 ? "" : "es"} awaiting results`
                  : currentRound
                    ? "All results recorded. Ready for the next round."
                    : "Generate pairings to continue."}
              </p>
            </div>
            <h3 className="swiss-section-title">Standings</h3>
            <p className="swiss-help">
              Match points only; tied players share a place. Game-level
              tournament tiebreakers are not applied.
            </p>
            <div className="swiss-standings">
              <table>
                <thead>
                  <tr>
                    <th scope="col">Place</th>
                    <th scope="col">Player</th>
                    <th scope="col">W–L–D</th>
                    <th scope="col">Byes</th>
                    <th scope="col">Points</th>
                  </tr>
                </thead>
                <tbody>
                  {standings.map((player) => (
                    <tr key={player.id}>
                      <td>
                        {standings.findIndex(
                          (other) => other.points === player.points,
                        ) + 1}
                      </td>
                      <th scope="row">{player.name}</th>
                      <td>
                        {player.wins}–{player.losses}–{player.draws}
                      </td>
                      <td>{player.byes}</td>
                      <td>
                        <strong>{player.points}</strong>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {tournament.rounds.length > 1 && (
              <div className="swiss-history">
                <h3 className="swiss-section-title">Previous rounds</h3>
                {tournament.rounds.slice(0, -1).map((round) => (
                  <details key={round.number}>
                    <summary>Round {round.number}</summary>
                    {renderPairings(round, false)}
                  </details>
                ))}
              </div>
            )}
          </>
        )}
        <p className="swiss-storage">
          Progress is saved on this browser only. Download results to keep a
          separate copy.
        </p>
      </div>
    </section>
  );
}
