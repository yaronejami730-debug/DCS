import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { SignatureRemoveBgProvider } from '../src/services/extraction/signature-remove-bg.js';
import { RemoveBgProvider } from '../src/services/extraction/remove-bg.js';
import { FallbackExtractionProvider } from '../src/services/extraction/fallback.js';
import type { ImageExtractionProvider } from '../src/services/extraction/provider.js';
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
              // The real /analyze proposes this on nearly every image.
              { effect: 'smoothing', value: 28 },
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
    //
    // Smoothing is dropped and pinned to 0 whatever the analyzer asked for: the
    // engine's smoothing blurs the whole mark rather than its edge, which took
    // mean opacity from 220 to 96 on a real capture — grey strokes under a
    // haze, the washed-out cutout users complain about. The edge gradient is
    // added afterwards by smoothEdges, where it stays on the boundary.
    expect(params.get('steps')).toBe('threshold:195,contrast:12,smoothing:0');
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

/**
 * remove.bg is a paid, off-premises API, so the client is exercised against a
 * stub. What matters is that it never calls out without a key, that it sends
 * the key where the service expects it, and that a refusal comes back as
 * something an operator can act on rather than a bare status code.
 */
describe('RemoveBgProvider', () => {
  const startStub = (
    respond: (res: import('node:http').ServerResponse) => void,
  ): Promise<{ url: string; server: Server; headers: Record<string, string>[] }> =>
    new Promise((resolve) => {
      const headers: Record<string, string>[] = [];
      const server = createServer((req, res) => {
        const chunks: Buffer[] = [];
        req.on('data', (c) => chunks.push(c as Buffer));
        req.on('end', () => {
          headers.push(req.headers as Record<string, string>);
          respond(res);
        });
      });
      server.listen(0, '127.0.0.1', () => {
        const { port } = server.address() as AddressInfo;
        resolve({ url: `http://127.0.0.1:${port}`, server, headers });
      });
    });

  it('refuses to call out at all when no key is configured', async () => {
    // Empty string, not undefined: `undefined` falls through to the default
    // parameter and picks up whatever REMOVEBG_API_KEY the machine happens to
    // have, so the test would pass or fail depending on the .env beside it.
    const provider = new RemoveBgProvider('', 'auto', 5000, 'http://127.0.0.1:1');
    expect(await provider.healthy()).toBe(false);
    await expect(
      provider.extractSignature({ image: PNG_BYTES, contentType: 'image/png' }),
    ).rejects.toMatchObject({ status: 503, code: 'SIGNATURE_EXTRACTION_FAILED' });
  });

  it('sends the key as X-Api-Key and returns the cutout', async () => {
    const stub = await startStub((res) => {
      res.writeHead(200, { 'content-type': 'image/png', 'x-credits-charged': '1' });
      res.end(PNG_BYTES);
    });
    try {
      const provider = new RemoveBgProvider('test-key', 'auto', 5000, stub.url);
      const result = await provider.extractStamp({ image: PNG_BYTES, contentType: 'image/png' });

      expect(result.png.byteLength).toBe(PNG_BYTES.byteLength);
      expect(result.meta?.provider).toBe('remove.bg');
      expect(result.meta?.creditsCharged).toBe('1');
      expect(stub.headers[0]?.['x-api-key']).toBe('test-key');
      expect(stub.headers[0]?.['content-type']).toContain('multipart/form-data');
    } finally {
      stub.server.close();
    }
  });

  it('names the reason a call was refused, so it can be acted on', async () => {
    const stub = await startStub((res) => {
      res.writeHead(402, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ errors: [{ title: 'Insufficient credits' }] }));
    });
    try {
      const provider = new RemoveBgProvider('test-key', 'auto', 5000, stub.url);
      await expect(
        provider.extractSignature({ image: PNG_BYTES, contentType: 'image/png' }),
      ).rejects.toThrow(/crédits épuisés.*Insufficient credits/);
    } finally {
      stub.server.close();
    }
  });

  it('reports a rejected key distinctly from an exhausted balance', async () => {
    const stub = await startStub((res) => {
      res.writeHead(403, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ errors: [{ title: 'Invalid API Key' }] }));
    });
    try {
      const provider = new RemoveBgProvider('bad-key', 'auto', 5000, stub.url);
      await expect(
        provider.extractSignature({ image: PNG_BYTES, contentType: 'image/png' }),
      ).rejects.toThrow(/clé API refusée/);
    } finally {
      stub.server.close();
    }
  });

  it('treats an empty body as a failure rather than an empty signature', async () => {
    const stub = await startStub((res) => {
      res.writeHead(200, { 'content-type': 'image/png' });
      res.end();
    });
    try {
      const provider = new RemoveBgProvider('test-key', 'auto', 5000, stub.url);
      await expect(
        provider.extractSignature({ image: PNG_BYTES, contentType: 'image/png' }),
      ).rejects.toBeInstanceOf(HttpError);
    } finally {
      stub.server.close();
    }
  });
});

/**
 * With a metered third-party engine in the signing pipeline, the question that
 * matters is what happens when it will not answer. A lapsed card must not be
 * able to stop a signature mid-session — but a genuinely empty frame must still
 * reach the signer as an empty frame.
 */
describe('FallbackExtractionProvider', () => {
  const stub = (name: string, behaviour: () => Promise<never> | null): ImageExtractionProvider => ({
    name,
    healthy: async () => true,
    extractSignature: async () => behaviour() ?? { png: PNG_BYTES, meta: { provider: name } },
    extractStamp: async () => behaviour() ?? { png: PNG_BYTES, meta: { provider: name } },
  });

  const input = { image: PNG_BYTES, contentType: 'image/png' };

  it('uses the second engine when the first cannot be reached', async () => {
    const provider = new FallbackExtractionProvider(
      stub('primary', () => {
        throw new HttpError(503, 'remove.bg injoignable.', 'SIGNATURE_EXTRACTION_FAILED');
      }),
      stub('secondary', () => null),
    );

    const result = await provider.extractSignature(input);
    expect(result.meta?.engine).toBe('secondary');
    expect(result.meta?.fellBack).toBe(true);
    expect(result.meta?.fellBackFrom).toBe('primary');
  });

  it('falls back when the first engine is out of credits', async () => {
    const provider = new FallbackExtractionProvider(
      stub('primary', () => {
        throw new HttpError(502, 'remove.bg : crédits épuisés.', 'SIGNATURE_EXTRACTION_FAILED');
      }),
      stub('secondary', () => null),
    );
    await expect(provider.extractStamp(input)).resolves.toMatchObject({
      meta: { fellBack: true },
    });
  });

  it('does NOT fall back when the engine says there is no ink in the frame', async () => {
    // 422 is a verdict about the photograph, not a fault of the service.
    // Retrying elsewhere would bury a real problem under a worse cutout, and
    // the signer would never learn to widen the box.
    let secondaryCalls = 0;
    const provider = new FallbackExtractionProvider(
      stub('primary', () => {
        throw new HttpError(422, "Aucune trace d'encre.", 'SIGNATURE_EXTRACTION_FAILED');
      }),
      stub('secondary', () => {
        secondaryCalls += 1;
        return null;
      }),
    );

    await expect(provider.extractSignature(input)).rejects.toMatchObject({ status: 422 });
    expect(secondaryCalls).toBe(0);
  });

  it('records the engine that answered when nothing went wrong', async () => {
    const provider = new FallbackExtractionProvider(
      stub('primary', () => null),
      stub('secondary', () => null),
    );
    const result = await provider.extractSignature(input);
    expect(result.meta?.engine).toBe('primary');
    expect(result.meta?.fellBack).toBe(false);
  });
});
