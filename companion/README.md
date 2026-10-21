# Rift Warehouse Scanner — Mac companion 0.1.0

**Pilot source installer, not a signed/notarized downloadable binary.** Native OpenCV handles recognition on the Mac. A private loopback interface opens in your normal browser. This is not a wrapper that sends local recognition to Vercel. The existing website remains the authoritative inventory and fulfillment system.

## Install

Requirements: macOS 13+, Apple Silicon or Intel, native Python 3.11–3.13, internet for initial installation and catalog download. The code has not been executed on the owner's Mac; macOS launch, Keychain and scanner acceptance still require a pilot. Do not buy hardware based on an unmeasured speedup.

1. Extract this folder. Open `Install.command`. If Finder cannot run a command file, open Terminal, enter `bash `, drag `Install.command` into the Terminal window, and press Return. Review the source before running it. Install a supported Python from python.org when the installer requests it.
2. Installation creates `~/Applications/Rift Warehouse Scanner.app`, a private Python environment, and user-local draft storage. No administrator access, login item, firewall changes or Gatekeeper disabling is requested. Launch the app or `Start Scanner.command` to reopen it.
3. Sign into Warehouse OS and open `/warehouse/scanner`. Create a scanner key for this Mac. Paste it into the companion's connection field. The key is stored in macOS Keychain, not a settings file. Do not share it or paste it into a chat.
4. Click **Update catalog & references** once. This reads the existing cloud Mastersheet and confirmed learning examples; it creates no stock. Reference features are cached locally and reused. Source failures stay visible as missing references; **Resume preparation** retries unavailable images.
5. Create a foil/non-foil batch. Choose your Epson output folder and click **Start watching**. Export one cropped card-front JPG, PNG or WebP per physical copy. Existing files are ignored unless you explicitly check **Import existing files too**. Never include card backs as separate fronts.

To approve or renew credentials, use your existing authorized Defy login. Renewal must be on the same device entry so deterministic upload IDs remain unchanged. The key expires after 30 days and can be revoked on the website. Revocation blocks cloud access, but cannot remotely erase previously cached local files.

## Receive, review and synchronize

The companion waits for files to settle, copies them into its private draft store without altering Epson originals, and processes them in natural filename order. One worker with bounded native threads prioritizes accuracy and keeps resource use predictable. Every cached eligible exact reference is considered; finish and language filters remain enforced.

**Local queues are not warehouse stock or final cloud approval.** `Strong local match` means detailed native evidence supports the suggestion. `Human confirmed` means you explicitly selected the exact printing. Correcting an unsynchronized selection replaces its local learning example; exclusion removes the label. Native scores are not calibrated probabilities and are not fed directly into the website's existing 90% gate.

Click **Sync batch to Warehouse** when ready. Stable batch/scan identities make interrupted retries idempotent. Original scan order and the pinned catalog version are retained. Unconfirmed scans undergo the website's existing independent detailed verification and 90% gate; manually confirmed scans are validated against the exact printing/finish/language and duplicate safeguards and imported as human approvals. Initial sync still runs cloud recognition for unconfirmed cards: this pilot does not claim to eliminate all cloud processing.

Then open Warehouse OS for remaining review, finalization, serial/location assignment, whole-batch putaway and fulfillment. The companion cannot finalize stock, assign warehouse locations, ship orders, modify Shopify stock, or erase inventory.

An identical file imported twice in the same local batch is skipped. Separate physical copies should have separate captures, not copied image files. Identical files across batches require explicit physical-copy confirmation for manual approval. The cloud can also detect duplicates from other devices.

## Offline and recovery

After initial reference caching, folder intake, local recognition and manual review work offline. Drafts remain local until a successful synchronization response. Reopening preserves drafts and reference caches. If interrupted during extraction, use **Recheck local queue**. A network failure does not mark a scan synchronized; retry Sync. If cloud finalization has closed the batch, stop adding to it and create a new batch.

Local data: `~/Library/Application Support/Rift Warehouse Scanner/data`.
Runtime: `~/Library/Application Support/Rift Warehouse Scanner/releases/0.1.0`.
Logs: `~/Library/Application Support/Rift Warehouse Scanner/logs/scanner.log`.
Back up the complete data folder while the app is stopped; SQLite WAL files can contain recent drafts. Never substitute the local database for the cloud operational database. Local images and catalog caches are private files, not encrypted by the app; use normal macOS account security/FileVault as appropriate.

Use **Stop scanner** in the interface to release the process. Closing the browser alone does not stop the watcher. macOS sleep pauses local work; the shared cloud website continues independently. No scheduled login agent is installed.

## Security

The UI binds only to 127.0.0.1 on a random port. A per-launch secret, HttpOnly SameSite cookie, exact Host/Origin checks and CSRF token protect the local API. Only explicitly selected folders are watched; no recursive disk indexing occurs. Cloud requests go only to the fixed Defy website, refuse redirects, and use a revocable scoped device token. The app never receives database credentials, Shopify credentials or your Defy password.

The local page has access to its own saved scan originals to compute the same browser preprocessing used by the existing cloud 90% gate. This keeps the old score definition separate from the native evidence. Credentials and private scans must never be committed to GitHub.

## Validation and limitations

See `VALIDATION.md` for checks actually run. The Mac-specific installer, Keychain, Finder launch and real ES-400 II folder workflow require testing on a Mac. No GPU/Neural Engine acceleration, OCR, foil detection, authenticity grading, unattended accuracy guarantee or measured Mac speedup is claimed. Epson software still controls the scanner.

Future release gates: benchmark native and cloud on the same held-out Epson captures; measure exact-printing errors, wrong auto-approvals, review rate, cold/warm latency and RAM. Only after validation should native-only automatic approvals replace cloud verification.

## Development

`python3 -m venv .venv && .venv/bin/python -m pip install -r requirements.txt`

`PYTHONPATH=. .venv/bin/python -m unittest discover -s tests -v`

`PYTHONPATH=. .venv/bin/python -m rift_scanner.server`

The cloud adapter lives in the same GitHub repository under `lib/warehouse/scanner*.ts`, `app/api/warehouse-companion`, and `app/warehouse/scanner`. Device administration remains session-protected; only the exact bearer-token API path is exempted from cookie middleware.
