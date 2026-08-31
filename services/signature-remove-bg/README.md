# Extraction engine

Wraps [`fchaussin/signature-remove-bg`](https://github.com/fchaussin/signature-remove-bg) (MIT).

## API used by the backend

| Method | Path | Notes |
| --- | --- | --- |
| `POST` | `/extract?mode=auto\|dark\|blue&steps=…&format=png&output=binary` | multipart `file` → transparent PNG |
| `POST` | `/analyze` | multipart `file` → `{ mode, steps: [{effect, value}] }` |
| `GET` | `/health` | `{"status":"ok"}` |

The backend calls `/analyze` first (`SIGNATURE_USE_ANALYZE=true`) and feeds the
returned parameters into `/extract`. If `/analyze` fails the call still goes
through with the configured mode — `auto` is designed for exactly that.

## Running

```bash
pnpm extractor:up      # docker compose up -d
curl http://localhost:8000/health
```

Requires Docker Desktop (or any Docker engine). If `docker` is not installed,
see "Running without Docker" below.

## Running without Docker

```bash
git clone https://github.com/fchaussin/signature-remove-bg.git upstream
cd upstream
python3 -m venv .venv && . .venv/bin/activate
pip install -r requirements.txt
python -m uvicorn app.main:app --host 0.0.0.0 --port 8000
```

`upstream/` is gitignored.

## Stamps

Upstream is explicitly tuned for dark/blue handwritten ink. Stamps — coloured,
ringed, sometimes faint — are a harder case and are **not** something the
project claims to solve.

This is why the backend talks to an `ImageExtractionProvider` interface
(`apps/api/src/services/extraction/provider.ts`) rather than to this service
directly. If stamp quality is not good enough:

1. implement `ImageExtractionProvider` against another engine;
2. return it from `createExtractionProvider()` in
   `apps/api/src/services/extraction/index.ts`.

Nothing else changes. `extractSignature()` and `extractStamp()` are separate
methods precisely so the two can use different engines.
