# Scan&Sign

Distribute PDFs from a web console to an iPhone, sign and stamp them from a
photo, and get the signed PDFs back — with the signature and stamp placed
exactly where the template says.

**One account, two clients.** You sign in on the web console and on the iPhone
app with the *same* credentials. Documents you send from the web land on that
account's phone; the phone sends the signed PDFs back to that same console.

Built entirely in TypeScript: Expo / React Native for iOS, React for the
console, Node + Hono for the API, Supabase for data and storage, `pdf-lib` for
PDF generation, and a small Dockerised Python service
([`fchaussin/signature-remove-bg`](https://github.com/fchaussin/signature-remove-bg), MIT)
for background removal. No Swift, no Vision/VisionKit.

---

## The workflow

```
CONSOLE (web)                 IPHONE (Expo)                BACKEND
─────────────                 ─────────────                ───────
sign in
create folder
import PDFs      ──────────►  (hash + template match)
place zones on the PDF
send to a device ──────────►  push notification
                              open folder
                              preview PDF
                              "Signer"
                              take one photo of a sheet
                              frame the signature
                              frame the stamp      ──────►  crop each region
                                                            signature-remove-bg
                                                            → transparent PNG
                                                            pdf-lib stamps the
                                                            original copy
                                                            → signed PDF
"Document terminé" ◄────────────────────────────────────── stored + notified
download the signed PDF
```

A folder holds several documents. Each document has its own template, its own
zones, its own status and its own final PDF, and they are processed
independently — one bad template does not block the others.

---

## Repository layout

```
apps/
  api/                    Hono + TypeScript backend (the only holder of secrets)
  admin/                  React + Vite + Tailwind console
  mobile/                 Expo SDK 54 + expo-router iPhone app
packages/
  shared/                 Types, statuses, Zod contracts shared by all three
  pdf/                    Coordinate maths, PDF inspection and generation (tested)
services/
  signature-remove-bg/    docker-compose for the extraction engine
supabase/
  migrations/             Schema, RLS policies, storage bucket
tools/
  smoke.mjs               End-to-end test of the whole product
  fixtures.mjs            Generates test contracts and a fake signature sheet
```

---

## Getting started

### 0. Requirements

- Node 20.19+ (24 recommended), `pnpm` 10+
- Docker (for the extraction engine — a Docker-free path is documented below)
- A Supabase project
- Xcode + an iPhone or simulator for the mobile app

### 1. Install

```bash
pnpm install
cp .env.example .env      # then fill it in — see the comments in the file
```

You need three values from **Supabase → Project Settings → API**:
`SUPABASE_URL`, `SUPABASE_ANON_KEY`, and `SUPABASE_SERVICE_ROLE_KEY`.
The service role key stays in the backend, always.

### 2. Database

```bash
pnpm db:push        # or: supabase db push --db-url "<your connection string>"
```

This creates the tables, the enums, the RLS policies and the private
`scansign` storage bucket.

### 3. Extraction engine

```bash
pnpm extractor:up
curl http://127.0.0.1:8000/health     # {"status":"ok"}
```

No Docker? See `services/signature-remove-bg/README.md` for the `uv` / venv
route — the engine is plain Python, FastAPI and Pillow.

> Use `127.0.0.1`, not `localhost`. On macOS `localhost` resolves to `::1`
> first while the engine binds IPv4 only, which looks exactly like an outage.

### 4. Backend

```bash
pnpm dev:api
curl http://localhost:8787/health
```

The response tells you whether the extraction engine is reachable.

### 5. Console

```bash
pnpm dev:admin        # http://localhost:5173
```

Create your account from the login screen ("Créer un compte"). That same
account is what you will use on the phone.

### 6. iPhone app

```bash
pnpm dev:mobile
```

Set `EXPO_PUBLIC_API_URL` in `.env` to your machine's **LAN IP** — a physical
iPhone cannot reach your Mac's `localhost`:

```bash
EXPO_PUBLIC_API_URL=http://192.168.1.42:8787
```

Sign in with the same account, name the device, and it appears in the console
under **Appareils**.

---

## Verify the whole thing works

```bash
pnpm fixtures                                   # optional: writes sample PDFs
node tools/smoke.mjs you@example.com yourpass
```

`smoke.mjs` drives the real HTTP API against the real Supabase project and the
real extraction engine: sign in → register a device → create a folder → import
two PDFs → build a template for each → send → acknowledge → upload a photo →
frame the regions → wait for processing → download the signed PDFs and check
they are valid. It fails loudly at the first step that does not work.

Unit tests:

```bash
pnpm test           # 52 tests: coordinate maths, PDF generation, image
                    # pipeline, extraction client, job queue
pnpm typecheck
```

---

## The parts worth understanding

### Coordinates

Three spaces, and confusing them is the classic way to put a signature in the
wrong corner:

| Space | Origin | Unit | Where |
| --- | --- | --- | --- |
| Screen / viewport | top-left | CSS px | template editor, phone region picker |
| **Normalized** | top-left | 0..1 | **what the database stores** |
| PDF user space | bottom-left | points | `pdf-lib` at generation time |

Only normalized coordinates are persisted, so a zone drawn on a 27" monitor is
the same zone on a phone. Conversion happens in `packages/pdf/src/geometry.ts`
and is unit-tested for all four page rotations, including replaying `pdf-lib`'s
own transform to assert where the image actually lands.

Page rotation (`/Rotate 90|180|270`) is handled: pdf.js renders the *rotated*
page, so the drawn zone is in viewport space, and the stamped image is spun so
it reads upright.

### Template matching

When a PDF is imported the backend computes its SHA-256 and looks for a
template in this order:

1. **exact file hash** — cannot be fooled by a rename;
2. **filename pattern AND matching page count** — both must agree;
3. nothing → the document sits in `awaiting_template` and the console says
   *« Ce document nécessite une configuration de signature. »*

A filename alone is never enough. When you configure a document by hand, the
backend back-fills the template's hash, so the next upload of that file matches
automatically.

### Swapping the extraction engine

`signature-remove-bg` is explicitly tuned for dark and blue handwritten ink.
Stamps are a harder case, and it makes no promises about them. So the backend
never talks to it directly — it talks to `ImageExtractionProvider`:

```ts
interface ImageExtractionProvider {
  readonly name: string;
  healthy(): Promise<boolean>;
  extractSignature(input: ExtractionInput): Promise<ExtractionResult>;
  extractStamp(input: ExtractionInput): Promise<ExtractionResult>;
}
```

`extractSignature` and `extractStamp` are separate methods precisely so the two
can use different engines later. To swap one in, implement the interface and
return it from `createExtractionProvider()` in
`apps/api/src/services/extraction/index.ts`. Nothing else changes.

In practice the engine handled a blue circular stamp cleanly in testing —
transparent background, no white halo. Verify against your own stamps before
relying on it.

---

## Security

- The **service role key never leaves the backend**. The console and the phone
  both authenticate through `POST /auth/login`, so neither bundle contains a
  Supabase key at all.
- Row Level Security is on for every table, scoped to `owner_id = auth.uid()`.
  The backend also filters by owner in code — RLS is the second line, not the
  only one.
- Storage is a **private** bucket. Clients only ever get short-lived signed URLs.
- Uploads are checked for size and for real content (PDF magic number, not just
  a `.pdf` name).
- Every meaningful action lands in `audit_logs`.
- The phone stores its session in `expo-secure-store` (Keychain).

### Data retention

Configurable in `.env`:

| Setting | Default | Effect |
| --- | --- | --- |
| `RETENTION_DELETE_PHOTO_AFTER_SUCCESS` | `true` | the raw capture photo is deleted once the folder is signed |
| `RETENTION_KEEP_CUTOUTS` | `true` | keep the transparent PNGs (lets you regenerate a PDF) |
| `RETENTION_PHOTO_MAX_AGE_DAYS` | `7` | hard cutoff for any leftover photo |

The final PDFs and the audit metadata are always kept. **Original PDFs are never
modified** — signing always writes a new file under `processed/`.

---

## Building for iOS with EAS

```bash
npm install -g eas-cli
eas login
cd apps/mobile
eas init                       # writes a real projectId into app.json
eas build --profile development --platform ios   # dev client for testing
eas build --profile production --platform ios
eas submit --platform ios
```

Set `EXPO_PUBLIC_API_URL` per profile in `apps/mobile/eas.json` — the
placeholder values there point at example hosts.

Push notifications need a real EAS `projectId` (`eas init` sets it) and, on
iOS, an APNs key configured in your Expo account. Without them the app still
works: folders are fetched when the app opens and on pull-to-refresh, so a
missing push token costs immediacy, not function.

## Deploying the backend

`pnpm --filter @scansign/api build` bundles the API to a single
`apps/api/dist/index.js` (esbuild; `sharp` stays external because it ships
native binaries). Run it with `node apps/api/dist/index.js`. It needs the same
`.env`, plus network access to Supabase and to the extraction engine.

---

## Useful commands

| Command | What it does |
| --- | --- |
| `pnpm dev` | API + console together |
| `pnpm dev:mobile` | Expo dev server |
| `pnpm extractor:up` / `:down` / `:logs` | the extraction engine |
| `pnpm db:push` | apply Supabase migrations |
| `pnpm test` | all unit tests |
| `pnpm typecheck` | typecheck every package |
| `pnpm build` | production build of API + console |
| `pnpm smoke <email> <pass>` | end-to-end test of the real stack |
| `pnpm account list \| create \| confirm \| password` | account admin |

## License

MIT.
