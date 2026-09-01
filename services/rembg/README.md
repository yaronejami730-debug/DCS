# rembg — moteur de détourage local

Free, unmetered, MIT, and nothing leaves this machine. It replaced a hosted API
that billed per image and uploaded every photographed signature to a third
party — for a signing product, both were real costs and neither was necessary.

## Running it

There is no Docker on this machine, and the sibling extractor already runs from
a Python virtualenv, so rembg does too. `docker-compose.yml` is kept for a
server that does have Docker.

```
cd services/rembg
uv venv --python 3.11 .venv
VIRTUAL_ENV=.venv uv pip install "rembg[cpu,cli]"
.venv/bin/rembg s --host 127.0.0.1 --port 7001 --no-ui
```

Or, from the repo root, `pnpm rembg:serve`.

**Port 7001, not the 7000 rembg documents.** On macOS 7000 belongs to AirPlay
Receiver (ControlCenter), which answers 403 to everything — rembg then looks
like it is running badly rather than not running at all.

`--no-ui` disables the Gradio interface, which otherwise burns CPU at idle for
a page nobody opens.

## Settings that matter

Both live in `.env`:

- `REMBG_MODEL=birefnet-general` — resolves thin strokes and faint ink far
  better than the default `isnet-general-use`, which is what a signature is made
  of. Bigger one-time download, slower per call.
- `REMBG_ALPHA_MATTING=true` — segmentation returns a near-binary mask, and a
  binary mask around a pen stroke is a staircase. Matting re-estimates the
  boundary as real coverage.

## Measured, on a real capture

| engine | time | opacity | ink pixels |
|---|---|---|---|
| rembg (birefnet + matting) | 8.4 s | **245** | 137 187 |
| local (signature-remove-bg) | 1.1 s | 233 | 149 345 |
| remove.bg (hosted, metered) | 1.3 s | 228 | 113 793 |

rembg gives the fullest ink and, unlike the local engine, no desk shadow
survives into the cutout. It is the slowest of the three; the first call of all
is slower still, because it downloads the model weights.

## If it is not running

The signing pipeline falls back to the local engine on its own — see
`FallbackExtractionProvider`. A missing rembg degrades quality; it does not stop
anyone signing.
