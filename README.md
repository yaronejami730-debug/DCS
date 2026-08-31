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
pnpm dev:mobile          # always port 8083
pnpm dev:mobile:clear    # same, with Metro's cache cleared
```

The port is pinned so a second, stale Metro cannot end up serving the phone an
old module map — which looks exactly like a missing dependency.

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
pnpm test           # 134 tests: coordinate maths, PDF generation and
                    # annotation, selection geometry, image pipeline, ink
                    # detection, extraction client, realtime socket, job queue
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

### Marks, and how they are captured

A template places four kinds of mark: **signature**, **tampon**, the
**« Lu et approuvé »** mention some contracts require, and **tampon +
signature** for the very common case of a stamp pressed across the signature —
framing those two separately would cut each in half. Each has its own zones,
cutout and placement.

The photo can be taken with the camera or picked from the phone's library.

Handwritten marks are varied between documents and between zones, so a folder
does not carry one identical bitmap stamped repeatedly — a person signing five
documents produces five slightly different signatures.

The variation is **in the pen, not the letterforms**: stroke weight and ink
density, applied to coverage alone, plus a slight slant and a shallow drift of
the baseline. Two signings by the same hand differ mainly in how the pen was
loaded and how hard it was pressed — one comes out fuller and darker, the next
thinner and drier — while the shapes stay unmistakably the same.

Two approaches were tried and rejected on the way. Rotation and scale alone were
invisible: variants differed as files but not to the eye, because an affine
transform moves every point in lockstep. A strong displacement field made them
differ, but in the wrong way — the signature visibly rippled, which no hand
does. The drift that remains is slow and shallow enough to read as drift.

**One variant per document, chosen by the signer.** After framing a mark and
checking its cutout, the signer generates as many variants as the folder has
documents and decides which goes where — the invoice gets one signing, the quote
another. A variant is derived from its index alone, so the image approved on the
phone is exactly the image stamped on that document. Where nothing is assigned,
an index is derived from the document id so documents still differ. The waves stay slow enough to move the letterforms
without distorting them. A stamp is left alone: it is a physical die and
reproduces identically by design. Set `SIGNATURE_VARIANTS=false` to turn it off.
It is cosmetic — it changes how the marks sit on the page, not what the document
is.

The shutter is instant: the framing screen opens on the local photo file the
moment it is taken, and the upload, the server-side re-encode and the ink
detection all resolve behind it. A tap of haptic feedback marks the capture, so
nothing has to be waited on to know it worked.

The signer picks how to capture them, because neither way wins everywhere:

| Mode | What happens |
| --- | --- |
| **Une seule photo** | one sheet holding every mark, then frame each one |
| **Une photo par élément** | one photo per mark, used whole — nothing to frame |

The number of steps follows what the folder's templates actually ask for, taken
as the **union across its documents**: a folder holding an invoice that wants a
signed stamp and a balance sheet that wants a plain signature asks for both, and
each document then receives only what its own template calls for.

`GET /folders/:id/required-marks` is what the phone asks, and the order comes
from `CAPTURE_ORDER` in `@scansign/shared` — derived from `ZONE_TYPE` rather
than written out, with a compile-time check that nothing is missing. A
hand-written list had dropped `signature_stamp`, so a folder needing a signed
stamp was never asked for one and failed at processing.

### Ink quality

Photographed ink is mid-grey on beige under whatever light was in the room, and
the engine thresholds hard. Two artefacts follow, and both are corrected after
extraction, where the paper is already gone and only the strokes are touched:

- **washed out** — strokes keep the photo's grey. Measured at luminance 72 of
  255 on a dim capture; re-inking brings it to 45, keyed off the ink's mean
  rather than its darkest pixel, and preserves hue so a blue pen stays blue.
- **pixelated** — the threshold leaves an almost binary mask (1.2% of pixels at
  partial alpha), and a binary mask is a staircase. The cutout is upscaled with
  Lanczos and its alpha channel alone is softened, taking the edge gradient from
  8% to around 60% of the ink.

The engine's own `smoothing` option was tried and rejected: at every level it
blurs the whole mark rather than its edge, dropping opacity from 246 to 63 —
the washed-out problem back, worse.

### Checking the cutout before committing

Background removal is the step most likely to disappoint — a pale stamp, a
shadow across the paper, ink too light — and the photo gives the signer no way
to judge it. During framing, **Voir le résultat** runs the real pipeline and
shows the transparent cutout that will be stamped onto the contract, so the box
can be widened or the photo retaken while it still costs nothing.

### Notifications

Three layers, in order of what reaches the signer soonest:

| | When it works | What it needs |
| --- | --- | --- |
| **Live socket** | app open | nothing |
| **Local notification** | app running, foreground or background | notification permission |
| **Remote push** | app closed or killed | an EAS project + a development build |

The first two work today. The app holds a live socket, so when the console sends
a folder the device already knows — it raises the banner itself rather than
waiting on a push service. That is why alerts work in Expo Go, where remote push
does not.

Remote push is the only piece that needs setting up, and only for the
app-is-closed case:

```bash
cd apps/mobile
eas init            # writes a real projectId into app.json
eas build --profile development --platform ios
```

Until then the app says why on its home screen and the console says so under
**Appareils**, instead of recording a silent "skipped" nobody reads. Expo Go on
iOS cannot receive remote push at all since SDK 53 — that is a platform limit,
not a configuration mistake.


`apps/api/src/services/notify.ts` holds every server-sent message. Two rules
shape them: say what happened *and* what to do about it, and never send
something the recipient cannot act on. A failed extraction tells the signer to
retake the photo on a well-lit sheet rather than reporting a code.

Delivery is best-effort: a push that fails never fails the work it reports on,
and every attempt is recorded in `notifications` so the console can show what
got through.

### Reviewing a template

**Templates → Télécharger le PDF** (also in the editor) returns the document
with every zone drawn where the signature and stamp will actually land:
dashed box, colour per kind, labelled, with the template name in the footer.

It is generated by the same coordinate conversion the real signing step uses,
page rotation included — a preview drawn by separate code would be worth much
less, because the thing worth checking is precisely that conversion.

Use it to confirm placement before sending a folder out, to hand a colleague
proof of where a signature will go, or to archive what a template looked like.
It needs at least one document already using the template, since the zones have
to be drawn on something.

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

`npm start` brings up the API, the console and Metro together. It checks the
ports first: if something is already listening it says what, with its pid, and
what to do — rather than dying on a stack trace that only names the port. It
never kills anything, since a process on one of those ports may well be another
project.

| Command | What it does |
| --- | --- |
| `npm start` | API + console + Metro, with a port preflight |
| `pnpm dev` | API + console together |
| `pnpm dev:mobile` | Expo dev server |
| `pnpm extractor:up` / `:down` / `:logs` | the extraction engine |
| `pnpm db:push` | apply Supabase migrations |
| `pnpm test` | all unit tests |
| `pnpm typecheck` | typecheck every package |
| `pnpm build` | production build of API + console |
| `pnpm smoke <email> <pass>` | end-to-end test of the real stack |
| `node tools/smoke-three-marks.mjs <email> <pass>` | signature + stamp + mention, both capture modes |
| `node tools/smoke-combined.mjs <email> <pass>` | the combined tampon+signature mark and variants |
| `node tools/smoke-variants.mjs <email> <pass>` | one variant per document, assigned and verified |
| `node tools/smoke-per-mark.mjs <email> <pass>` | per-mark capture stays in one session |
| `node tools/smoke-mixed-marks.mjs <email> <pass>` | a folder whose documents want different marks |
| `node tools/browser-check.mjs <url>` | load the console in a real browser, report JS errors |
| `pnpm account list \| create \| confirm \| password` | account admin |

## License

MIT.
