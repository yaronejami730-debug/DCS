import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { SignatureRemoveBgProvider } from '../src/services/extraction/signature-remove-bg.js';
import { HttpError } from '../src/lib/errors.js';

const PNG_BYTES = Buffer.from(
  '89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000a49444154789c6360000002000100' +
    '05fe02fa0000000049454e44ae426082',
  'hex',
);

interface Recorded {
  path: string;
  contentType: string;
  bodyLength: number;
}

/** Stand-in for the real engine, so the client contract is tested end to end. */
const startFakeEngine = (
  handler: (req: { url: string }, res: import('node:http').ServerResponse) => void,
): Promise<{ url: string; server: Server; calls: Recorded[] }> =>
  new Promise((resolve) => {
    const calls: Recorded[] = [];
    const server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c) => chunks.push(c as Buffer));
      req.on('end', () => {
        calls.push({
          path: req.url ?? '',
          contentType: req.headers['content-type'] ?? '',
          bodyLength: Buffer.concat(chunks).length,
        });
        handler({ url: req.url ?? '' }, res);
      });
    });
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as AddressInfo;
      resolve({ url: `http://127.0.0.1:${port}`, server, calls });
    });
  });

describe('SignatureRemoveBgProvider', () => {
  let engine: Awaited<ReturnType<typeof startFakeEngine>>;

  beforeAll(async () => {
    engine = await startFakeEngine((req, res) => {
      if (req.url.startsWith('/health')) {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ status: 'ok' }));
        return;
      }
      if (req.url.startsWith('/analyze')) {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(
          JSON.stringify({
            mode: 'blue',
            steps: [
              { effect: 'threshold', value: 195 },
              { effect: 'contrast', value: 12 },
            ],
          }),
        );
        return;
      }
      if (req.url.startsWith('/extract')) {
        res.writeHead(200, { 'content-type': 'image/png' });
        res.end(PNG_BYTES);
        return;
      }
      res.writeHead(404).end();
    });
  });

  afterAll(() => {
    engine.server.close();
  });

  it('reports health from GET /health', async () => {
    const provider = new SignatureRemoveBgProvider(engine.url);
    expect(await provider.healthy()).toBe(true);
  });

  it('feeds the /analyze result into /extract as compact steps', async () => {
    const provider = new SignatureRemoveBgProvider(engine.url);
    const result = await provider.extractSignature({
      image: PNG_BYTES,
      contentType: 'image/png',
    });

    expect(result.png.byteLength).toBe(PNG_BYTES.byteLength);

    const extract = engine.calls.find((c) => c.path.startsWith('/extract'));
    expect(extract).toBeDefined();
    const params = new URLSearchParams(extract!.path.split('?')[1]);
    // The mode the analyzer chose must win over the configured default.
    expect(params.get('mode')).toBe('blue');
    // The service returns steps as objects but expects "effect:value" on input.
    expect(params.get('steps')).toBe('threshold:195,contrast:12');
    expect(params.get('format')).toBe('png');
    expect(params.get('output')).toBe('binary');
    expect(extract!.contentType).toContain('multipart/form-data');
    expect(extract!.bodyLength).toBeGreaterThan(PNG_BYTES.byteLength);
  });

  it('uses separate methods for signature and stamp so engines can diverge', async () => {
    const provider = new SignatureRemoveBgProvider(engine.url);
    await expect(
      provider.extractStamp({ image: PNG_BYTES, contentType: 'image/png' }),
    ).resolves.toMatchObject({ meta: { provider: 'signature-remove-bg' } });
  });

  it('surfaces an engine error as STAMP_EXTRACTION_FAILED, not a raw 500', async () => {
    const failing = await startFakeEngine((req, res) => {
      if (req.url.startsWith('/analyze')) {
        res.writeHead(500).end();
        return;
      }
      res.writeHead(400, { 'content-type': 'text/plain' });
      res.end('IMAGE_TOO_LARGE');
    });
    try {
      const provider = new SignatureRemoveBgProvider(failing.url);
      const promise = provider.extractStamp({ image: PNG_BYTES, contentType: 'image/png' });
      await expect(promise).rejects.toBeInstanceOf(HttpError);
      await expect(promise).rejects.toMatchObject({ code: 'STAMP_EXTRACTION_FAILED' });
    } finally {
      failing.server.close();
    }
  });

  it('says the engine is unreachable rather than timing out silently', async () => {
    const provider = new SignatureRemoveBgProvider('http://127.0.0.1:1', 500);
    expect(await provider.healthy()).toBe(false);
    await expect(
      provider.extractSignature({ image: PNG_BYTES, contentType: 'image/png' }),
    ).rejects.toMatchObject({ code: 'SIGNATURE_EXTRACTION_FAILED', status: 503 });
  });

  it('returns an empty-image failure instead of stamping nothing', async () => {
    const empty = await startFakeEngine((req, res) => {
      if (req.url.startsWith('/analyze')) {
        res.writeHead(500).end();
        return;
      }
      res.writeHead(200, { 'content-type': 'image/png' });
      res.end(Buffer.alloc(0));
    });
    try {
      const provider = new SignatureRemoveBgProvider(empty.url);
      await expect(
        provider.extractSignature({ image: PNG_BYTES, contentType: 'image/png' }),
      ).rejects.toMatchObject({ code: 'SIGNATURE_EXTRACTION_FAILED' });
    } finally {
      empty.server.close();
    }
  });
});
