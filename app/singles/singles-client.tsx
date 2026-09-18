"use client";

import Image from "next/image";
import Link from "next/link";
import { startTransition, useEffect, useMemo, useRef, useState } from "react";
import {
  SINGLES_CONDITIONS,
  type Catalog,
  type CatalogCard,
  type SinglesIntakeRow,
} from "@/lib/singles/types";
import { parseSinglesCsv, SINGLES_CSV_TEMPLATE } from "@/lib/singles/csv";
import ThemeToggle from "../theme-toggle";

type DraftRow = {
  id: string;
  cardKey: string;
  condition: SinglesIntakeRow["condition"];
  quantity: string;
  cost: string;
};
type Connection = {
  connected: boolean;
  shop: string;
  locationName: string;
  canPublish: boolean;
  currencyCode?: string;
  error?: string;
  blockers?: string[];
};
type Preview = {
  rows: (SinglesIntakeRow & {
    card: CatalogCard;
    sku: string;
    catalogId: string;
    pricing: { source: "scrydex"; marketCents: number };
  })[];
  totalQuantity: number;
  totalCostCents: number;
};
type PendingEntry = {
  requestId: string;
  rows: [SinglesIntakeRow];
  publish: boolean;
  card: CatalogCard;
  status: "queued" | "pending" | "complete" | "rejected";
  error?: string;
};
type PendingBatch = { version: 1; entries: PendingEntry[]; createdAt: string };
type Receipt = {
  status?: "complete" | "pending" | "rejected";
  requestId?: string;
  error?: string | { message?: string };
};
type CsvPreview = ReturnType<typeof parseSinglesCsv>;

const PENDING_KEY = "defy-riftbound-pending:v1";
const RECEIPT_KEY = "defy-riftbound-receipt:v1";
const PAGE_SIZE = 36;
const MAX_ROWS = 100;
const QUOTE_BATCH_SIZE = 10;
const money = (cents: number | null) =>
  cents === null
    ? "Unavailable"
    : new Intl.NumberFormat("en-US", {
        style: "currency",
        currency: "USD",
      }).format(cents / 100);
const dateTime = (value: string) => {
  const date = new Date(value);
  return Number.isNaN(date.valueOf())
    ? "Date unavailable"
    : date.toLocaleString();
};
const errorText = (value: unknown, fallback: string) => {
  if (typeof value === "string" && value) return value;
  if (
    value &&
    typeof value === "object" &&
    "message" in value &&
    typeof value.message === "string"
  )
    return value.message;
  return fallback;
};
const makeDraft = (row: SinglesIntakeRow): DraftRow => ({
  id: crypto.randomUUID(),
  cardKey: row.cardKey,
  condition: row.condition,
  quantity: String(row.quantity),
  cost: (row.costCents / 100).toFixed(2),
});

function readMoney(value: string, label: string) {
  if (!/^\d+(?:\.\d{1,2})?$/.test(value.trim()))
    throw new Error(
      `${label} must be a dollar amount with up to two decimal places. Enter 0 if none.`,
    );
  const cents = Math.round(Number(value) * 100);
  if (!Number.isSafeInteger(cents) || cents < 0)
    throw new Error(`${label} is outside the supported range.`);
  return cents;
}

function CardImage({
  card,
  small = false,
}: {
  card: CatalogCard;
  small?: boolean;
}) {
  return (
    <div className={small ? "singles-thumb" : "singles-card-art"}>
      {card.imageUrl ? (
        <Image
          src={card.imageUrl}
          alt={card.name}
          width={small ? 64 : 240}
          height={small ? 90 : 336}
          unoptimized
          loading="lazy"
        />
      ) : (
        <span aria-label="Image unavailable">◈</span>
      )}
    </div>
  );
}

export default function SinglesClient() {
  const [catalog, setCatalog] = useState<Catalog | null>(null);
  const [catalogError, setCatalogError] = useState("");
  const [loading, setLoading] = useState(true);
  const [connection, setConnection] = useState<Connection | null>(null);
  const [search, setSearch] = useState("");
  const [setFilter, setSetFilter] = useState("");
  const [finishFilter, setFinishFilter] = useState("");
  const [limit, setLimit] = useState(PAGE_SIZE);
  const [draft, setDraft] = useState<DraftRow[]>([]);
  const [publish, setPublish] = useState(false);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [previewing, setPreviewing] = useState(false);
  const [quoteProgress, setQuoteProgress] = useState(0);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [csvText, setCsvText] = useState("");
  const [csvPreview, setCsvPreview] = useState<CsvPreview | null>(null);
  const [pending, setPending] = useState<PendingBatch | null>(null);
  const [completedReceipt, setCompletedReceipt] = useState<PendingEntry[]>([]);
  const [storageProblem, setStorageProblem] = useState("");
  const [restored, setRestored] = useState(false);
  const [receiving, setReceiving] = useState(false);
  const [activeRequest, setActiveRequest] = useState("");
  const working = useRef(false);
  const previewInFlight = useRef(false);
  const reviewRef = useRef<HTMLElement>(null);
  const batchRef = useRef<HTMLElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  async function loadCatalog() {
    setLoading(true);
    setCatalogError("");
    try {
      const response = await fetch("/api/singles/catalog", {
        cache: "no-store",
      });
      const data = await response.json();
      if (!response.ok || !Array.isArray(data.cards))
        throw new Error(
          errorText(data.error, "The card catalog could not be loaded."),
        );
      setCatalog(data);
    } catch (reason) {
      setCatalogError(
        errorText(reason, "The card catalog could not be loaded."),
      );
    } finally {
      setLoading(false);
    }
  }

  async function loadConnection() {
    try {
      const response = await fetch("/api/singles/connection", {
        cache: "no-store",
      });
      const data = await response.json();
      if (!response.ok)
        throw new Error(
          errorText(data.error, "Shopify connection is unavailable."),
        );
      setConnection(data);
    } catch (reason) {
      setConnection({
        connected: false,
        shop: "",
        locationName: "",
        canPublish: false,
        error: errorText(reason, "Shopify connection is unavailable."),
      });
    }
  }

  useEffect(() => {
    startTransition(() => {
      try {
        const stored = window.localStorage.getItem(PENDING_KEY);
        if (stored) {
          const data = JSON.parse(stored) as PendingBatch;
          if (
            data.version !== 1 ||
            !Array.isArray(data.entries) ||
            !data.entries.length ||
            data.entries.some(
              (entry) =>
                !entry.requestId ||
                !Array.isArray(entry.rows) ||
                entry.rows.length !== 1 ||
                !entry.card ||
                !["queued", "pending", "complete", "rejected"].includes(
                  entry.status,
                ),
            )
          ) {
            throw new Error(
              "The saved receiving batch could not be read. Keep this browser data and contact the store administrator before receiving more cards.",
            );
          }
          setPending(data);
        }
        const receipt = window.localStorage.getItem(RECEIPT_KEY);
        if (receipt) {
          const entries = JSON.parse(receipt) as PendingEntry[];
          if (
            Array.isArray(entries) &&
            entries.every(
              (entry) =>
                entry.status === "complete" &&
                entry.card &&
                entry.rows?.length === 1,
            )
          )
            setCompletedReceipt(entries);
        }
      } catch (reason) {
        setStorageProblem(
          errorText(
            reason,
            "This browser cannot safely save a receiving request. Enable site storage before receiving stock.",
          ),
        );
      }
      setRestored(true);
      void loadCatalog();
      void loadConnection();
    });
  }, []);

  useEffect(() => {
    if (!pending?.entries.some((entry) => entry.status !== "complete")) return;
    const warn = (event: BeforeUnloadEvent) => {
      event.preventDefault();
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [pending]);

  useEffect(() => {
    function syncSavedBatch(event: StorageEvent) {
      if (event.key !== PENDING_KEY || working.current || !event.newValue)
        return;
      try {
        const saved = JSON.parse(event.newValue) as PendingBatch;
        if (
          saved.version === 1 &&
          Array.isArray(saved.entries) &&
          saved.entries.length
        ) {
          setPending(saved);
          setMessage(
            "A receiving batch was saved in another tab. Continue that batch here before starting another.",
          );
        }
      } catch {
        setStorageProblem(
          "The receiving batch changed in another tab and could not be read. Refresh this page before receiving more stock.",
        );
      }
    }
    window.addEventListener("storage", syncSavedBatch);
    return () => window.removeEventListener("storage", syncSavedBatch);
  }, []);

  const cardsByKey = useMemo(
    () => new Map(catalog?.cards.map((card) => [card.key, card]) ?? []),
    [catalog],
  );
  const sets = useMemo(
    () => [...new Set(catalog?.cards.map((card) => card.setName) ?? [])].sort(),
    [catalog],
  );
  const finishes = useMemo(
    () => [...new Set(catalog?.cards.map((card) => card.finish) ?? [])].sort(),
    [catalog],
  );
  const filtered = useMemo(() => {
    const terms = search.toLowerCase().trim().split(/\s+/).filter(Boolean);
    return (catalog?.cards ?? []).filter((card) => {
      if (setFilter && card.setName !== setFilter) return false;
      if (finishFilter && card.finish !== finishFilter) return false;
      const text =
        `${card.name} ${card.setName} ${card.setCode} ${card.number} ${card.rarity} ${card.finish} ${card.productId}`.toLowerCase();
      return terms.every((term) => text.includes(term));
    });
  }, [catalog, search, setFilter, finishFilter]);
  const locked =
    Boolean(pending) ||
    receiving ||
    previewing ||
    Boolean(storageProblem) ||
    !restored;
  const completed =
    pending?.entries.filter((entry) => entry.status === "complete").length ?? 0;
  const allComplete = Boolean(pending && completed === pending.entries.length);
  const canEditUnreceived = Boolean(
    pending?.entries.some((entry) => entry.status === "rejected") &&
    pending.entries.every((entry) => entry.status !== "pending"),
  );
  const missingPublishPrice = Boolean(
    publish && preview?.rows.some((row) => row.priceCents <= 0),
  );
  const totalMarketCents = preview?.rows.reduce(
    (total, row) => total + row.pricing.marketCents * row.quantity,
    0,
  ) ?? 0;

  function updateDraft(id: string, change: Partial<DraftRow>) {
    if (locked || previewInFlight.current) return;
    setDraft((rows) =>
      rows.map((row) => (row.id === id ? { ...row, ...change } : row)),
    );
    setPreview(null);
    setError("");
  }

  function addCard(card: CatalogCard) {
    if (locked || previewInFlight.current) return;
    if (draft.length >= MAX_ROWS) {
      setError(
        "A batch can contain up to 100 rows. Receive this batch before adding more.",
      );
      return;
    }
    setDraft((rows) => [
      ...rows,
      {
        id: crypto.randomUUID(),
        cardKey: card.key,
        condition: "Near Mint",
        quantity: "1",
        cost: "0.00",
      },
    ]);
    setPreview(null);
    setMessage(
      `${card.name} added to your batch. Set its condition and cost; review will show its Scrydex market price.`,
    );
    setError("");
  }

  function removeDraftRow(id: string) {
    if (locked || previewInFlight.current) return;
    setDraft((rows) => rows.filter((item) => item.id !== id));
    setPreview(null);
  }

  function currentRows() {
    if (!draft.length) throw new Error("Add at least one card to your batch.");
    const identities = new Set<string>();
    return draft.map((row, index): SinglesIntakeRow => {
      const label = `Row ${index + 1}`;
      if (
        !/^\d+$/.test(row.quantity) ||
        !Number.isSafeInteger(Number(row.quantity)) ||
        Number(row.quantity) < 1
      )
        throw new Error(`${label}: quantity must be a positive whole number.`);
      const identity = JSON.stringify([row.cardKey, row.condition]);
      if (identities.has(identity))
        throw new Error(`${label}: this card, finish, and condition is already in the batch. Combine its quantities first.`);
      identities.add(identity);
      return {
        cardKey: row.cardKey,
        condition: row.condition,
        quantity: Number(row.quantity),
        costCents: readMoney(row.cost, `${label} unit cost`),
        priceCents: 0,
      };
    });
  }

  async function reviewBatch() {
    if (locked || previewInFlight.current) return;
    previewInFlight.current = true;
    setError("");
    setMessage("");
    setPreview(null);
    setPreviewing(true);
    setQuoteProgress(0);
    try {
      const rows = currentRows();
      const combined: Preview = { rows: [], totalQuantity: 0, totalCostCents: 0 };
      for (let offset = 0; offset < rows.length; offset += QUOTE_BATCH_SIZE) {
        const chunk = rows.slice(offset, offset + QUOTE_BATCH_SIZE);
        const response = await fetch("/api/singles/intake", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action: "preview", rows: chunk, publish }),
        });
        const data = await response.json();
        if (!response.ok || !Array.isArray(data.rows) || data.rows.length !== chunk.length)
          throw new Error(errorText(data.error, "This batch could not be reviewed. Check the card details and try again."));
        combined.rows.push(...data.rows);
        combined.totalQuantity += data.totalQuantity;
        combined.totalCostCents += data.totalCostCents;
        setQuoteProgress(combined.rows.length);
      }
      setPreview(combined);
      requestAnimationFrame(() => reviewRef.current?.focus());
    } catch (reason) {
      setError(errorText(reason, "This batch could not be reviewed."));
    } finally {
      previewInFlight.current = false;
      setPreviewing(false);
    }
  }

  function persistBatch(batch: PendingBatch) {
    const saved = window.localStorage.getItem(PENDING_KEY);
    if (saved) {
      const existing = JSON.parse(saved) as PendingBatch;
      if (existing.entries?.[0]?.requestId !== batch.entries[0]?.requestId) {
        throw new Error(
          "another receiving batch is already saved in this browser; refresh to continue that batch first",
        );
      }
    }
    window.localStorage.setItem(PENDING_KEY, JSON.stringify(batch));
    setPending(batch);
  }

  async function receiveBatch(batch: PendingBatch) {
    if (working.current) return;
    working.current = true;
    setReceiving(true);
    setError("");
    let next = batch;
    try {
      // Save exact requests before sending; a network interruption must reuse the same IDs.
      persistBatch(next);
      for (let index = 0; index < next.entries.length; index += 1) {
        const entry = next.entries[index];
        if (entry.status === "complete") continue;
        if (entry.status === "rejected") break;
        next = {
          ...next,
          entries: next.entries.map((item, position) =>
            position === index
              ? { ...item, status: "pending", error: undefined }
              : item,
          ),
        };
        persistBatch(next);
        setActiveRequest(entry.requestId);
        try {
          const response = await fetch("/api/singles/intake", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              action: "receive",
              requestId: entry.requestId,
              rows: entry.rows,
              publish: entry.publish,
            }),
          });
          const result = (await response.json()) as Receipt;
          if (
            response.ok &&
            result.status === "rejected" &&
            result.requestId === entry.requestId
          ) {
            const detail = errorText(
              result.error,
              "This row was rejected before stock was added. Edit the unreceived rows to correct it.",
            );
            next = {
              ...next,
              entries: next.entries.map((item, position) =>
                position === index
                  ? { ...item, status: "rejected", error: detail }
                  : item,
              ),
            };
            persistBatch(next);
            setError(detail);
            break;
          }
          if (
            !response.ok ||
            result.status !== "complete" ||
            result.requestId !== entry.requestId
          )
            throw new Error(
              errorText(
                result.error,
                "This row has not been confirmed. Retry this saved batch to check it without adding stock twice.",
              ),
            );
          next = {
            ...next,
            entries: next.entries.map((item, position) =>
              position === index
                ? { ...item, status: "complete", error: undefined }
                : item,
            ),
          };
          persistBatch(next);
        } catch (reason) {
          const detail = errorText(
            reason,
            "The response was interrupted. This row may have been received. Retry the saved batch to check safely.",
          );
          next = {
            ...next,
            entries: next.entries.map((item, position) =>
              position === index ? { ...item, error: detail } : item,
            ),
          };
          persistBatch(next);
          setError(detail);
          break;
        }
      }
    } catch (reason) {
      setStorageProblem(
        `Receiving paused: ${errorText(reason, "this browser could not save the receiving progress")}. Keep this tab open and restore browser storage before retrying.`,
      );
    } finally {
      working.current = false;
      setReceiving(false);
      setActiveRequest("");
    }
  }

  function startReceiving() {
    if (
      !preview ||
      !connection?.connected ||
      (publish && !connection.canPublish) ||
      missingPublishPrice ||
      locked ||
      previewInFlight.current
    )
      return;
    const batch: PendingBatch = {
      version: 1,
      createdAt: new Date().toISOString(),
      entries: preview.rows.map(
        ({ card, cardKey, condition, quantity, costCents, priceCents }) => ({
          requestId: crypto.randomUUID(),
          rows: [{ cardKey, condition, quantity, costCents, priceCents }],
          publish,
          card,
          status: "queued",
        }),
      ),
    };
    void receiveBatch(batch);
  }

  function finishBatch() {
    if (!allComplete) return;
    try {
      window.localStorage.removeItem(PENDING_KEY);
      setPending(null);
      setDraft([]);
      setPreview(null);
      setCsvPreview(null);
      setCsvText("");
      setPublish(false);
      setError("");
      setMessage(
        "The completed batch has been saved. You can start your next batch.",
      );
    } catch {
      setStorageProblem(
        "This browser could not clear the completed batch. Restore browser storage and try again.",
      );
    }
  }

  function editUnreceivedRows() {
    if (!pending || !canEditUnreceived || receiving) return;
    try {
      const received = pending.entries.filter(
        (entry) => entry.status === "complete",
      );
      const unreceived = pending.entries.filter(
        (entry) => entry.status === "rejected" || entry.status === "queued",
      );
      const receipt = [...completedReceipt, ...received];
      window.localStorage.setItem(RECEIPT_KEY, JSON.stringify(receipt));
      window.localStorage.removeItem(PENDING_KEY);
      setCompletedReceipt(receipt);
      setDraft(unreceived.map((entry) => makeDraft(entry.rows[0])));
      setPublish(unreceived[0]?.publish ?? false);
      setPending(null);
      setPreview(null);
      setError("");
      setMessage(
        `${unreceived.length} unreceived rows are ready to edit. Completed rows stay in your receipt and will not be received again.`,
      );
      batchRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
    } catch {
      setStorageProblem(
        "This browser could not save the completed receipt. Keep this tab open and restore browser storage before editing unreceived rows.",
      );
    }
  }

  async function readCsv(file: File) {
    setError("");
    setCsvPreview(null);
    try {
      if (file.size > 1_000_000)
        throw new Error(
          "Choose a CSV file smaller than 1 MB, with no more than 100 card rows.",
        );
      setCsvText(await file.text());
    } catch (reason) {
      setError(errorText(reason, "The CSV file could not be read."));
    }
  }

  function previewCsv() {
    if (!catalog) return;
    setError("");
    try {
      setCsvPreview(parseSinglesCsv(csvText, catalog));
    } catch (reason) {
      setError(errorText(reason, "This CSV could not be read."));
    }
  }

  function addCsvRows() {
    if (
      !csvPreview ||
      csvPreview.errors.length ||
      locked ||
      previewInFlight.current
    )
      return;
    if (draft.length + csvPreview.rows.length > MAX_ROWS) {
      setError(
        "Your batch would exceed 100 rows. Split the CSV into smaller batches.",
      );
      return;
    }
    setDraft((rows) => [...rows, ...csvPreview.rows.map(makeDraft)]);
    setPreview(null);
    setMessage(`${csvPreview.rows.length} rows added to your batch.`);
    setCsvText("");
    setCsvPreview(null);
    batchRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
  }

  function downloadTemplate() {
    const url = URL.createObjectURL(
      new Blob([SINGLES_CSV_TEMPLATE], { type: "text/csv;charset=utf-8" }),
    );
    const link = document.createElement("a");
    link.href = url;
    link.download = "defy-riftbound-singles-template.csv";
    link.click();
    URL.revokeObjectURL(url);
  }

  return (
    <div className="singles-shell">
      <header className="singles-topbar">
        <Link href="/" className="singles-brand">
          <Image src="/defy-os-icon.png" alt="" width={38} height={38} />
          <span>
            DEFY <small>STORE OS</small>
          </span>
        </Link>
        <div className="singles-top-actions">
          <Link href="/" className="singles-back">
            ← Back to Defy OS
          </Link>
          <ThemeToggle />
        </div>
      </header>
      <main className="singles-main">
        <section className="singles-hero">
          <div>
            <p className="singles-eyebrow">RIFTBOUND · ENGLISH SINGLES</p>
            <h1>
              Find the card.
              <br />
              <span>Stock your store.</span>
            </h1>
            <p className="singles-intro">
              Search the reference catalog, then add only the cards you have on
              hand. Standard cards, alternate art, and promos stay distinct.
            </p>
            <p className="singles-help">
              <Link href="/shopify" className="singles-back">
                View Shopify stock &amp; orders →
              </Link>
            </p>
          </div>
          <div className="singles-steps" aria-label="Receiving steps">
            <div>
              <b>01</b>
              <span>
                Find your cards<small>Search or import a list</small>
              </span>
            </div>
            <div>
              <b>02</b>
              <span>
                Build your batch<small>Condition, count, and cost</small>
              </span>
            </div>
            <div>
              <b>03</b>
              <span>
                Review & receive<small>Add stock to Shopify</small>
              </span>
            </div>
          </div>
        </section>

        <div
          className={`singles-connection ${connection?.connected ? "is-connected" : ""}`}
        >
          <span className="singles-status-dot" aria-hidden="true" />
          <div>
            <strong>
              {connection === null
                ? "Checking Shopify connection…"
                : connection.connected
                  ? `Shopify connected${connection.locationName ? ` · ${connection.locationName}` : ""}`
                  : "Shopify receiving is not ready"}
            </strong>
            <span>
              {connection?.connected
                ? "Quantities add to stock already at this location. Catalog browsing does not change inventory."
                : connection?.error ||
                  "You can browse cards and prepare a batch while the store connection is checked."}
            </span>
          </div>
          {connection && !connection.connected && (
            <button
              type="button"
              className="singles-button is-subtle"
              onClick={() => void loadConnection()}
            >
              Check again
            </button>
          )}
        </div>
        <div aria-live="polite">
          {message && <p className="singles-notice">{message}</p>}
        </div>
        {error && (
          <p role="alert" className="singles-alert">
            {error}
          </p>
        )}
        {storageProblem && (
          <p role="alert" className="singles-alert">
            {storageProblem}
          </p>
        )}

        {completedReceipt.length > 0 && (
          <details className="singles-panel singles-receipt singles-completed-receipt">
            <summary>
              {completedReceipt.length} previously received rows — saved receipt
            </summary>
            <p className="singles-help">
              These rows are complete and are not included in your editable
              batch.
            </p>
            <ul className="singles-csv-matches">
              {completedReceipt.map((entry) => (
                <li key={entry.requestId}>
                  {entry.card.name}
                  <small>
                    {entry.card.setName} · {entry.card.finish} ·{" "}
                    {entry.rows[0].condition} · +{entry.rows[0].quantity} units
                    · {entry.publish ? "Received & published" : "Received"}
                  </small>
                </li>
              ))}
            </ul>
          </details>
        )}

        {pending && (
          <section
            className="singles-panel singles-receipt"
            aria-label="Receiving progress"
          >
            <div className="singles-section-heading">
              <div>
                <p className="singles-eyebrow">
                  {allComplete ? "BATCH COMPLETE" : "SAVED RECEIVING BATCH"}
                </p>
                <h2>
                  {allComplete
                    ? "Your cards have been received."
                    : receiving
                      ? "Receiving your cards…"
                      : canEditUnreceived
                        ? "Some rows need your attention"
                        : "Continue your saved batch"}
                </h2>
                <p>
                  {completed} of {pending.entries.length} rows confirmed.{" "}
                  {allComplete
                    ? "Stock is saved in Shopify."
                    : canEditUnreceived
                      ? "The rejected row did not add stock. Edit that row and the remaining unsent rows; completed rows stay received."
                      : "Keep this saved batch until every row is confirmed. Retrying uses the same request and will not add confirmed stock twice."}
                </p>
              </div>
              <strong className="singles-count">
                {completed}/{pending.entries.length}
              </strong>
            </div>
            <ol className="singles-progress-list">
              {pending.entries.map((entry) => (
                <li key={entry.requestId}>
                  <span
                    className={`singles-progress-icon ${entry.status === "complete" ? "is-done" : ""}`}
                  >
                    {entry.status === "complete"
                      ? "✓"
                      : activeRequest === entry.requestId
                        ? "…"
                        : "○"}
                  </span>
                  <div>
                    <strong>{entry.card.name}</strong>
                    <small>
                      {entry.card.setName} · {entry.card.finish} ·{" "}
                      {entry.rows[0].condition} · +{entry.rows[0].quantity}{" "}
                      units
                    </small>
                    {entry.error && entry.status !== "complete" && (
                      <p className="singles-row-error">{entry.error}</p>
                    )}
                  </div>
                  <span className="singles-progress-label">
                    {entry.status === "complete"
                      ? entry.publish
                        ? "Received & published"
                        : "Received"
                      : activeRequest === entry.requestId
                        ? "Receiving…"
                        : entry.status === "rejected"
                          ? "Not received"
                          : entry.status === "queued"
                            ? "Not sent"
                            : "Unconfirmed"}
                  </span>
                </li>
              ))}
            </ol>
            <div className="singles-panel-actions">
              {allComplete ? (
                <button
                  className="singles-button is-primary"
                  onClick={finishBatch}
                >
                  Start another batch
                </button>
              ) : canEditUnreceived ? (
                <button
                  className="singles-button is-primary"
                  disabled={receiving || Boolean(storageProblem)}
                  onClick={editUnreceivedRows}
                >
                  Edit unreceived rows
                </button>
              ) : (
                <button
                  className="singles-button is-primary"
                  disabled={
                    receiving ||
                    !connection?.connected ||
                    Boolean(storageProblem)
                  }
                  onClick={() => void receiveBatch(pending)}
                >
                  {receiving ? "Receiving…" : "Retry / continue saved batch"}
                </button>
              )}
            </div>
          </section>
        )}

        <div className="singles-workspace">
          <section
            className="singles-catalog"
            aria-label="English Riftbound card catalog"
          >
            <div className="singles-section-heading">
              <div>
                <p className="singles-eyebrow">REFERENCE CATALOG</p>
                <h2>Find your exact version</h2>
                <p>
                  These are available card references, not your on-hand
                  inventory.
                </p>
              </div>
              {catalog && (
                <span className="singles-tag">
                  {catalog.cards.length.toLocaleString()} versions
                </span>
              )}
            </div>
            <div className="singles-filters">
              <label className="singles-search">
                <span>Search cards</span>
                <input
                  type="search"
                  value={search}
                  placeholder="Card name, number, or set…"
                  onChange={(event) => {
                    setSearch(event.target.value);
                    setLimit(PAGE_SIZE);
                  }}
                />
              </label>
              <label>
                <span>Set</span>
                <select
                  value={setFilter}
                  onChange={(event) => {
                    setSetFilter(event.target.value);
                    setLimit(PAGE_SIZE);
                  }}
                >
                  <option value="">All sets & promos</option>
                  {sets.map((name) => (
                    <option key={name}>{name}</option>
                  ))}
                </select>
              </label>
              <label>
                <span>Finish</span>
                <select
                  value={finishFilter}
                  onChange={(event) => {
                    setFinishFilter(event.target.value);
                    setLimit(PAGE_SIZE);
                  }}
                >
                  <option value="">All finishes</option>
                  {finishes.map((finish) => (
                    <option key={finish}>{finish}</option>
                  ))}
                </select>
              </label>
            </div>
            {catalog && (
              <div className="singles-catalog-meta">
                <span>
                  {filtered.length.toLocaleString()} matching versions
                </span>
                <span>Catalog updated: {dateTime(catalog.sourceUpdatedAt)}</span>
              </div>
            )}
            {catalog?.warnings?.length ? (
              <details className="singles-data-notes">
                <summary>Catalog notes ({catalog.warnings.length})</summary>
                <ul>
                  {catalog.warnings.map((warning, index) => (
                    <li key={index}>{warning}</li>
                  ))}
                </ul>
              </details>
            ) : null}
            {loading && (
              <div className="singles-empty" role="status">
                <span className="singles-loading" />
                <h3>Loading the card catalog</h3>
                <p>Gathering English cards, alternate art, and promos.</p>
              </div>
            )}
            {catalogError && (
              <div className="singles-empty" role="alert">
                <h3>The catalog is unavailable</h3>
                <p>{catalogError}</p>
                <button
                  className="singles-button"
                  onClick={() => void loadCatalog()}
                >
                  Try again
                </button>
              </div>
            )}
            {!loading && !catalogError && !filtered.length && (
              <div className="singles-empty">
                <h3>No matching cards</h3>
                <p>Try a shorter name or a different set or finish.</p>
                <button
                  className="singles-button"
                  onClick={() => {
                    setSearch("");
                    setSetFilter("");
                    setFinishFilter("");
                  }}
                >
                  Clear filters
                </button>
              </div>
            )}
            <div className="singles-card-grid">
              {filtered.slice(0, limit).map((card) => (
                <article className="singles-card" key={card.key}>
                  <CardImage card={card} />
                  <div className="singles-card-copy">
                    <div className="singles-card-set">
                      {card.setCode || card.setName}
                      {card.number ? ` · #${card.number}` : ""}
                    </div>
                    <h3>{card.name}</h3>
                    <p title={card.setName}>{card.setName}</p>
                    <div className="singles-card-tags">
                      <span>{card.finish}</span>
                      {card.rarity && <span>{card.rarity}</span>}
                    </div>
                    <div className="singles-card-market">
                      <span>Scrydex market</span>
                      <strong>Available on review</strong>
                    </div>
                    <button
                      className="singles-button is-add"
                      disabled={locked || draft.length >= MAX_ROWS}
                      onClick={() => addCard(card)}
                      aria-label={`Add ${card.name}, ${card.finish}, ${card.setName} to batch`}
                    >
                      ＋ Add to batch
                    </button>
                    <a
                      className="singles-source-link"
                      href={card.productUrl}
                      target="_blank"
                      rel="noreferrer"
                    >
                      Card reference ↗
                    </a>
                  </div>
                </article>
              ))}
            </div>
            {filtered.length > limit && (
              <button
                className="singles-button singles-show-more"
                onClick={() => setLimit((value) => value + PAGE_SIZE)}
              >
                Show more cards ({filtered.length - limit} remaining)
              </button>
            )}
            {catalog && (
              <p className="singles-footnote">
                Card references come from TCGCSV / TCGplayer. Review your batch
                to get USD market prices from Scrydex for each exact finish and
                condition.
              </p>
            )}
          </section>

          <aside className="singles-batch-column">
            <section
              className="singles-panel singles-batch"
              ref={batchRef}
              aria-label="Your receiving batch"
            >
              <div className="singles-section-heading">
                <div>
                  <p className="singles-eyebrow">YOUR ON-HAND CARDS</p>
                  <h2>Receiving batch</h2>
                </div>
                <span className="singles-count">
                  {draft.length}
                  <small>/ 100</small>
                </span>
              </div>
              <p className="singles-help">
                Add the quantity you are receiving today. This increases
                existing stock; it does not replace the total.
              </p>
              {!draft.length ? (
                <div className="singles-batch-empty">
                  <span aria-hidden="true">＋</span>
                  <h3>Start with a card you own</h3>
                  <p>Add it from the catalog or import a CSV list below.</p>
                </div>
              ) : (
                <div className="singles-draft-list">
                  {draft.map((row, index) => {
                    const card = cardsByKey.get(row.cardKey);
                    return (
                      <article className="singles-draft" key={row.id}>
                        <div className="singles-draft-heading">
                          {card && <CardImage card={card} small />}
                          <div>
                            <strong>{card?.name || row.cardKey}</strong>
                            <small>
                              {card?.setName} ·{" "}
                              {card?.number && `#${card.number} · `}
                              {card?.finish}
                            </small>
                          </div>
                          <button
                            className="singles-icon-button"
                            disabled={locked || previewing}
                            aria-label={`Remove row ${index + 1}, ${card?.name || "card"}`}
                            onClick={() => removeDraftRow(row.id)}
                          >
                            ×
                          </button>
                        </div>
                        <fieldset
                          disabled={locked || previewing}
                          className="singles-row-fields"
                        >
                          <legend className="sr-only">
                            Row {index + 1}: {card?.name}
                          </legend>
                          <label className="singles-condition">
                            <span>Condition</span>
                            <select
                              value={row.condition}
                              onChange={(event) =>
                                updateDraft(row.id, {
                                  condition: event.target
                                    .value as SinglesIntakeRow["condition"],
                                })
                              }
                            >
                              {SINGLES_CONDITIONS.map((condition) => (
                                <option key={condition}>{condition}</option>
                              ))}
                            </select>
                          </label>
                          <label>
                            <span>Quantity to add</span>
                            <input
                              type="number"
                              inputMode="numeric"
                              min="1"
                              step="1"
                              value={row.quantity}
                              onChange={(event) =>
                                updateDraft(row.id, {
                                  quantity: event.target.value,
                                })
                              }
                            />
                          </label>
                          <label>
                            <span>Unit cost ($)</span>
                            <input
                              type="text"
                              inputMode="decimal"
                              placeholder="0.00"
                              value={row.cost}
                              onChange={(event) =>
                                updateDraft(row.id, {
                                  cost: event.target.value,
                                })
                              }
                            />
                          </label>
                          <label>
                            <span>Scrydex market ($)</span>
                            <input
                              type="text"
                              readOnly
                              placeholder="Available on review"
                              value={preview ? (preview.rows[index].pricing.marketCents / 100).toFixed(2) : ""}
                            />
                          </label>
                        </fieldset>
                      </article>
                    );
                  })}
                </div>
              )}
              <div className="singles-batch-footer">
                <p>
                  Foil, alternate art, and condition are kept separate. Prices
                  are per card in USD.
                </p>
                <button
                  className="singles-button is-primary"
                  disabled={!draft.length || locked || previewing || !catalog}
                  onClick={() => void reviewBatch()}
                >
                  {previewing
                    ? `Checking Scrydex prices… ${quoteProgress}/${draft.length}`
                    : `Review batch${draft.length ? ` (${draft.length})` : ""}`}
                </button>
              </div>
            </section>

            <details className="singles-panel singles-import">
              <summary>
                Have a list? Import a CSV <span>↓</span>
              </summary>
              <div className="singles-import-body">
                <p>
                  Upload or paste up to 100 card rows. Include the set and exact
                  finish to identify the right version. Sell Price is optional
                  and any supplied value is ignored. Review shows the verified
                  Scrydex market price.
                </p>
                <button
                  className="singles-text-button"
                  type="button"
                  onClick={downloadTemplate}
                >
                  Download CSV template ↗
                </button>
                <input
                  ref={fileRef}
                  type="file"
                  accept=".csv,text/csv"
                  hidden
                  onChange={(event) => {
                    const file = event.target.files?.[0];
                    if (file) void readCsv(file);
                    event.target.value = "";
                  }}
                />
                <button
                  className="singles-button"
                  disabled={locked}
                  onClick={() => fileRef.current?.click()}
                >
                  Choose CSV file
                </button>
                <label>
                  <span>Or paste CSV</span>
                  <textarea
                    value={csvText}
                    disabled={locked}
                    rows={6}
                    placeholder="Paste the header and card rows here…"
                    onChange={(event) => {
                      setCsvText(event.target.value);
                      setCsvPreview(null);
                    }}
                  />
                </label>
                <button
                  className="singles-button"
                  disabled={locked || !catalog || !csvText.trim()}
                  onClick={previewCsv}
                >
                  Preview matches
                </button>
                {csvPreview && (
                  <div className="singles-csv-preview">
                    <strong>
                      {csvPreview.rows.length} matched rows
                      {csvPreview.errors.length > 0 &&
                        ` · ${csvPreview.errors.length} issues`}
                    </strong>
                    {csvPreview.errors.length > 0 && (
                      <ul className="singles-csv-errors">
                        {csvPreview.errors.map((issue, index) => (
                          <li key={index}>
                            Row {issue.row}: {issue.message}
                          </li>
                        ))}
                      </ul>
                    )}
                    <ul className="singles-csv-matches">
                      {csvPreview.rows.slice(0, 8).map((row, index) => (
                        <li key={index}>
                          {cardsByKey.get(row.cardKey)?.name || row.cardKey}
                          <small>
                            {cardsByKey.get(row.cardKey)?.finish} ·{" "}
                            {row.condition} · {row.quantity} units
                          </small>
                        </li>
                      ))}
                    </ul>
                    {csvPreview.rows.length > 8 && (
                      <p>
                        Plus {csvPreview.rows.length - 8} more rows; all appear
                        in your batch.
                      </p>
                    )}
                    <button
                      className="singles-button is-primary"
                      disabled={
                        locked ||
                        Boolean(csvPreview.errors.length) ||
                        !csvPreview.rows.length ||
                        draft.length + csvPreview.rows.length > MAX_ROWS
                      }
                      onClick={addCsvRows}
                    >
                      Add matched rows to batch
                    </button>
                    {csvPreview.errors.length > 0 && (
                      <p>
                        Correct the issues above and preview again before adding
                        this file.
                      </p>
                    )}
                  </div>
                )}
              </div>
            </details>
          </aside>
        </div>

        {preview && !pending && (
          <section
            ref={reviewRef}
            tabIndex={-1}
            className="singles-panel singles-review"
            aria-label="Review batch before receiving"
          >
            <div className="singles-section-heading">
              <div>
                <p className="singles-eyebrow">FINAL REVIEW</p>
                <h2>Ready to add {preview.totalQuantity} cards?</h2>
                <p>
                  Confirm each version, condition, quantity, and Scrydex market
                  price before receiving. Market prices are per card in USD.
                </p>
              </div>
              <button
                className="singles-button is-subtle"
                onClick={() => {
                  setPreview(null);
                  batchRef.current?.scrollIntoView({ behavior: "smooth" });
                }}
              >
                Edit batch
              </button>
            </div>
            <div className="singles-review-table">
              <table>
                <thead>
                  <tr>
                    <th>Card & version</th>
                    <th>Condition</th>
                    <th>Add quantity</th>
                    <th>Unit cost</th>
                    <th>Scrydex market</th>
                  </tr>
                </thead>
                <tbody>
                  {preview.rows.map((row, index) => (
                    <tr key={`${row.cardKey}-${index}`}>
                      <td>
                        <strong>{row.card.name}</strong>
                        <small>
                          {row.card.setName} · {row.card.number} ·{" "}
                          {row.card.finish}
                        </small>
                      </td>
                      <td>{row.condition}</td>
                      <td>+{row.quantity}</td>
                      <td>{money(row.costCents)}</td>
                      <td>{money(row.pricing.marketCents)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="singles-review-bottom">
              <div>
                <label className="singles-publish">
                  <input
                    type="checkbox"
                    checked={publish}
                    disabled={locked || !connection?.canPublish}
                    onChange={(event) => {
                      if (locked || previewInFlight.current) return;
                      setPublish(event.target.checked);
                    }}
                  />
                  <span>
                    <strong>Publish to website and POS</strong>
                    <small>
                      Make these cards available for sale. Every row needs a
                      confirmed Scrydex price greater than zero.
                    </small>
                  </span>
                </label>
                {!connection?.canPublish && (
                  <p className="singles-help">
                    Publishing becomes available when both Shopify sales
                    channels are connected.
                  </p>
                )}
                {missingPublishPrice && (
                  <p className="singles-row-error" role="alert">
                    Every row needs a confirmed Scrydex price greater than zero
                    before publishing. Choose Edit batch and review prices again.
                  </p>
                )}
                <p className="singles-help">
                  {publish
                    ? "This batch will add stock and publish to Online Store and Point of Sale."
                    : "This batch will add stock. Existing product visibility is unchanged; new products will not be published."}
                </p>
              </div>
              <div className="singles-review-total">
                <span>
                  Total cost <strong>{money(preview.totalCostCents)}</strong>
                </span>
                <span>
                  Total market value{" "}
                  <strong>{money(totalMarketCents)}</strong>
                </span>
                <button
                  className="singles-button is-primary"
                  disabled={
                    locked ||
                    !connection?.connected ||
                    (publish && !connection.canPublish) ||
                    missingPublishPrice
                  }
                  onClick={startReceiving}
                >
                  {publish
                    ? "Receive & publish cards"
                    : "Receive cards into Shopify"}
                </button>
                {!connection?.connected && (
                  <small>Connect Shopify to receive this batch.</small>
                )}
              </div>
            </div>
          </section>
        )}
        <footer className="singles-footer">
          <span>DEFY TCG · RIFTBOUND SINGLES</span>
          <Link href="/">Return to store dashboard ↗</Link>
        </footer>
      </main>
      {draft.length > 0 && !pending && (
        <a
          className="singles-mobile-batch"
          href="#"
          onClick={(event) => {
            event.preventDefault();
            batchRef.current?.scrollIntoView({ behavior: "smooth" });
          }}
        >
          View batch <strong>{draft.length} rows →</strong>
        </a>
      )}
    </div>
  );
}
