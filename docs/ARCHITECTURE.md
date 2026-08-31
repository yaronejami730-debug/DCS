# Architecture

## Why this shape

The product is small: a handful of PDFs move to a phone, a photo comes back, a
library stamps images onto pages. The architecture is deliberately boring — one
API, one database, one image service — because everything hard about this
product is in the *coordinates* and the *statuses*, not in the topology.

There is no queue broker, no GraphQL, no Kubernetes, no per-resource permission
system. When throughput actually demands them they can be added behind the
seams that already exist.

## Trust boundaries

```
┌────────────────┐        ┌────────────────┐
│  Admin console │        │  iPhone (Expo) │
│  React + Vite  │        │  expo-router   │
└───────┬────────┘        └───────┬────────┘
        │  Bearer <supabase access token>  │
        └───────────────┬──────────────────┘
                        ▼
              ┌───────────────────┐
              │   API (Hono)      │  ← the ONLY holder of secrets
              │   service role    │
              └───┬───────────┬───┘
                  │           │
       ┌──────────▼───┐   ┌───▼─────────────────────┐
       │   Supabase   │   │  signature-remove-bg    │
       │ PG + Storage │   │  (Docker, MIT, no ML)   │
       └──────────────┘   └─────────────────────────┘
```

Neither client bundle contains a Supabase key. Both call `POST /auth/login`,
which the backend proxies to Supabase Auth with the *anon* key, and both then
send the returned access token as a bearer. One account, two clients — this is
what makes "send it from the web, it appears on the phone" work with no pairing
step.

## Data model

`owner_id` on every table is the account. RLS enforces `owner_id = auth.uid()`;
the backend, which runs as service role and therefore bypasses RLS, filters by
owner in code as well.

```
profiles ─┬─ devices ────────────┐
          ├─ templates ─ template_zones
          ├─ folders ─┬─ documents ── (template_id)
          │           └─ signing_sessions
          ├─ notifications
          └─ audit_logs
```

| Table | Notes |
| --- | --- |
| `devices` | unique on `(owner_id, installation_id)` so relaunching the app updates rather than duplicates |
| `templates` | `document_hash` unique per owner; `filename_pattern` + `page_count` is the fallback matcher |
| `template_zones` | normalized 0..1 rect, `CHECK` constrained to stay inside the page |
| `folders` | `reference` from a sequence, shown as `DOSSIER #000123` |
| `documents` | one row per PDF; independent status and `final_pdf_path` |
| `signing_sessions` | one capture per folder; produces one signature and (optionally) one stamp |

## Storage

One **private** bucket, five prefixes:

```
originals/<owner>/<documentId>.pdf     immutable source
processed/<owner>/<documentId>.pdf     signed output
signatures/<owner>/<sessionId>.png     transparent cutout
stamps/<owner>/<sessionId>.png         transparent cutout
photos/<owner>/<sessionId>.jpg         raw capture, deleted after success
```

Nothing binary is ever stored in Postgres. Clients receive short-lived signed
URLs, never bucket credentials.

## Status machines

**Folder**: `pending → delivered → in_progress → processing → completed`,
with `error` reachable from `processing`.

**Document**: `awaiting_template → ready → processing → completed`, with
`error`. Documents advance independently inside a folder.

**Session**: `awaiting_photo → awaiting_regions → processing → completed | error`.

Every failure carries a code from a closed set (`ERROR_CODE` in
`packages/shared/src/status.ts`) with a French label, so the console can explain
what went wrong without the operator reading a stack trace.

## The three coordinate spaces

This is the part that repays careful reading.

| # | Space | Origin | Unit | Produced by |
| --- | --- | --- | --- | --- |
| 1 | Screen / viewport | top-left | CSS px | template editor canvas, phone region picker |
| 2 | **Normalized** | top-left | 0..1 | **the only form persisted** |
| 3 | PDF user space | bottom-left | points (1/72") | `pdf-lib` |

`pdf.js` renders the page with its `/Rotate` already applied, so what the
operator draws on is *viewport* space. `normalizedToPdfRect()` maps viewport →
user space per rotation:

| Rotation | viewport (dx, dy) → user |
| --- | --- |
| 0 | `x = dx`, `y = H − dy − dh` |
| 90 | `x = dy`, `y = dx` (width/height swap) |
| 180 | `x = W − dx − dw`, `y = dy` |
| 270 | `x = W − dy − dh`, `y = H − dx − dw` (swap) |

`computeImagePlacement()` goes further: it fits the cutout inside the zone
without distortion, centres it, and returns the anchor plus a rotation angle,
because `pdf-lib` rotates about the draw origin rather than the box centre. The
tests replay that transform to assert the drawn bounds match
`normalizedToPdfRect` exactly — the property that actually matters.

The photo has the same hazard: an iPhone stores it landscape with an EXIF
"rotate me" tag and *displays* it rotated. `normalizeCapturePhoto()` bakes the
orientation into the pixels on upload, so the rectangle the user framed refers
to the same pixels the server crops.

## Processing pipeline

`apps/api/src/services/processing.ts`, run off-request through a small
in-process queue:

1. resolve every document's zones **before touching the photo** — if nothing has
   a template, fail immediately with a clear message;
2. if any template wants a stamp and no stamp region was framed, fail before
   doing work;
3. crop the signature region → extract → trim → store;
4. same for the stamp, if present;
5. per document: download the original, `generateSignedPdf()`, upload to
   `processed/`, mark completed. Failures are per-document;
6. folder completes only if every document did;
7. retention: delete the photo, optionally the cutouts;
8. notify, and write the audit trail.

The queue is in-process and serial on purpose: durable state lives in Postgres,
so a restart mid-job leaves a visibly stuck `processing` row rather than
silently losing work. That is a better failure than a lost job, and it is
honest about what the system is.

## Extraction seam

```
processing.ts → ImageExtractionProvider → SignatureRemoveBgProvider → HTTP
```

`extractSignature()` and `extractStamp()` are separate methods so the two can
diverge. The client calls `/analyze` for per-image parameters and feeds them
into `/extract`; a failing `/analyze` is non-fatal and falls back to `auto`.
Note the asymmetry in the upstream API — `/analyze` *returns* steps as objects
but `/extract` *expects* them as `"effect:value,effect:value"`. The client
handles the translation; a test pins it.

## What is deliberately not here

- **No automatic signature detection.** The user frames two rectangles. It is
  boring, and it works on every sheet, in every light.
- **No Claude Vision / VisionKit.** The template already says *where*; the
  engine says *how* to remove the background. Nothing needs to be inferred.
- **No native code.** Everything is JavaScript/TypeScript, buildable with EAS.
