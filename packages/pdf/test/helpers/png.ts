import { deflateSync } from 'node:zlib';

const crcTable = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

const crc32 = (buf: Buffer): number => {
  let c = 0xffffffff;
  for (const byte of buf) c = crcTable[(c ^ byte) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};

const chunk = (type: string, data: Buffer): Buffer => {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
};

/**
 * Minimal RGBA PNG encoder, so the PDF tests can build fixture cutouts without
 * pulling an image library into the test run.
 */
export const makeRgbaPng = (
  width: number,
  height: number,
  pixel: (x: number, y: number) => [number, number, number, number],
): Uint8Array => {
  const raw = Buffer.alloc(height * (1 + width * 4));
  let o = 0;
  for (let y = 0; y < height; y++) {
    raw[o++] = 0; // filter type: none
    for (let x = 0; x < width; x++) {
      const [r, g, b, a] = pixel(x, y);
      raw[o++] = r;
      raw[o++] = g;
      raw[o++] = b;
      raw[o++] = a;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // colour type RGBA
  return new Uint8Array(
    Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      chunk('IHDR', ihdr),
      chunk('IDAT', deflateSync(raw)),
      chunk('IEND', Buffer.alloc(0)),
    ]),
  );
};

/** An opaque black bar on a transparent field — stands in for a signature cutout. */
export const fixtureSignaturePng = (width = 300, height = 100): Uint8Array =>
  makeRgbaPng(width, height, (_x, y) =>
    y > height * 0.4 && y < height * 0.6 ? [0, 0, 0, 255] : [0, 0, 0, 0],
  );

/** A transparent-background ring — stands in for a stamp cutout. */
export const fixtureStampPng = (size = 200): Uint8Array =>
  makeRgbaPng(size, size, (x, y) => {
    const d = Math.hypot(x - size / 2, y - size / 2);
    return d > size * 0.35 && d < size * 0.45 ? [0, 0, 200, 255] : [0, 0, 0, 0];
  });
