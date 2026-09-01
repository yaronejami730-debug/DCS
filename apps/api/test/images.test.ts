import { describe, expect, it } from 'vitest';
import sharp from 'sharp';
import {
  cropNormalizedRegion,
  imageSize,
  normalizeCapturePhoto,
  trimTransparentBorder,
} from '../src/services/images.js';

/** A landscape image with a distinctive red block in its top-left quarter. */
const makePhoto = (width: number, height: number, orientation?: number) => {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">
    <rect width="100%" height="100%" fill="#ffffff"/>
    <rect x="0" y="0" width="${width / 2}" height="${height / 2}" fill="#ff0000"/>
  </svg>`;
  const pipeline = sharp(Buffer.from(svg)).jpeg();
  return orientation ? pipeline.withMetadata({ orientation }).toBuffer() : pipeline.toBuffer();
};

const averageColour = async (bytes: Uint8Array) => {
  const { data } = await sharp(Buffer.from(bytes)).raw().toBuffer({ resolveWithObject: true });
  let r = 0;
  let g = 0;
  let b = 0;
  const channels = 3;
  const pixels = data.length / channels;
  for (let i = 0; i < data.length; i += channels) {
    r += data[i]!;
    g += data[i + 1]!;
    b += data[i + 2]!;
  }
  return { r: r / pixels, g: g / pixels, b: b / pixels };
};

describe('normalizeCapturePhoto', () => {
  it('re-encodes to JPEG and reports the displayed dimensions', async () => {
    const photo = await normalizeCapturePhoto(new Uint8Array(await makePhoto(800, 600)));
    expect(photo.contentType).toBe('image/jpeg');
    expect(photo.width).toBe(800);
    expect(photo.height).toBe(600);
  });

  it('bakes EXIF orientation into the pixels, so later crops match what the user saw', async () => {
    // Orientation 6 = rotate 90 CW on display: a stored 800x600 shows as 600x800.
    const rotated = await normalizeCapturePhoto(new Uint8Array(await makePhoto(800, 600, 6)));
    expect(rotated.width).toBe(600);
    expect(rotated.height).toBe(800);
  });

  it('rejects a file that is not an image', async () => {
    await expect(normalizeCapturePhoto(new Uint8Array([1, 2, 3, 4, 5]))).rejects.toMatchObject({
      code: 'IMAGE_PROCESSING_FAILED',
    });
  });
});

describe('cropNormalizedRegion', () => {
  it('cuts out the region the user framed', async () => {
    const photo = await normalizeCapturePhoto(new Uint8Array(await makePhoto(800, 600)));

    const topLeft = await cropNormalizedRegion(
      photo.bytes,
      { x: 0.05, y: 0.05, width: 0.35, height: 0.35 },
      photo.width,
      photo.height,
    );
    const bottomRight = await cropNormalizedRegion(
      photo.bytes,
      { x: 0.6, y: 0.6, width: 0.35, height: 0.35 },
      photo.width,
      photo.height,
    );

    // Top-left of the fixture is red, bottom-right is white.
    const red = await averageColour(topLeft);
    const white = await averageColour(bottomRight);
    expect(red.r).toBeGreaterThan(200);
    expect(red.g).toBeLessThan(60);
    expect(white.r).toBeGreaterThan(200);
    expect(white.g).toBeGreaterThan(200);
  });

  it('produces a crop of the expected pixel size', async () => {
    const photo = await normalizeCapturePhoto(new Uint8Array(await makePhoto(1000, 500)));
    const crop = await cropNormalizedRegion(
      photo.bytes,
      { x: 0.1, y: 0.2, width: 0.4, height: 0.5 },
      photo.width,
      photo.height,
    );
    const size = await imageSize(crop);
    expect(size.width).toBe(400);
    expect(size.height).toBe(250);
  });

  it('refuses a selection too small to contain anything useful', async () => {
    const photo = await normalizeCapturePhoto(new Uint8Array(await makePhoto(800, 600)));
    await expect(
      cropNormalizedRegion(
        photo.bytes,
        { x: 0.5, y: 0.5, width: 0.002, height: 0.002 },
        photo.width,
        photo.height,
      ),
    ).rejects.toMatchObject({ code: 'IMAGE_PROCESSING_FAILED' });
  });
});

describe('trimTransparentBorder', () => {
  it('removes the transparent margin around the ink', async () => {
    const png = await sharp({
      create: {
        width: 400,
        height: 400,
        channels: 4,
        background: { r: 0, g: 0, b: 0, alpha: 0 },
      },
    })
      .composite([
        {
          input: await sharp({
            create: { width: 80, height: 40, channels: 4, background: { r: 10, g: 20, b: 60, alpha: 1 } },
          })
            .png()
            .toBuffer(),
          left: 160,
          top: 180,
        },
      ])
      .png()
      .toBuffer();

    const trimmed = await trimTransparentBorder(new Uint8Array(png), 'SIGNATURE_EXTRACTION_FAILED');
    // The margin is gone, so the aspect ratio is that of the ink alone. Exact
    // pixel sizes are not asserted: restoration upscales for smoothness, and
    // the reported dimensions describe the image actually returned.
    expect(trimmed.width / trimmed.height).toBeCloseTo(80 / 40, 1);

    // Without restoration the trim is exact, which is what this test is about.
    const raw = await trimTransparentBorder(
      new Uint8Array(png),
      'SIGNATURE_EXTRACTION_FAILED',
      { restore: false },
    );
    expect(raw.width).toBe(80);
    expect(raw.height).toBe(40);
  });

  it('treats a fully transparent cutout as an extraction failure', async () => {
    const blank = await sharp({
      create: { width: 200, height: 200, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } },
    })
      .png()
      .toBuffer();

    await expect(
      trimTransparentBorder(new Uint8Array(blank), 'STAMP_EXTRACTION_FAILED'),
    ).rejects.toMatchObject({ code: 'STAMP_EXTRACTION_FAILED' });
  });
});

/**
 * A capture that holds no picture. This is not hypothetical: a real session
 * uploaded an all-black frame, background removal thresholded it into noise,
 * and the signer got a confetti "signature" followed by an unexplained
 * processing failure two steps later.
 */
describe('blank captures', () => {
  const solid = async (r: number, g: number, b: number) =>
    new Uint8Array(
      await sharp({ create: { width: 240, height: 320, channels: 3, background: { r, g, b } } })
        .jpeg()
        .toBuffer(),
    );

  it('rejects an all-black frame instead of extracting noise from it', async () => {
    await expect(normalizeCapturePhoto(await solid(0, 0, 0))).rejects.toMatchObject({
      status: 422,
      code: 'IMAGE_PROCESSING_FAILED',
    });
  });

  it('rejects a frame with no contrast at all', async () => {
    await expect(normalizeCapturePhoto(await solid(255, 255, 255))).rejects.toMatchObject({
      status: 422,
    });
    await expect(normalizeCapturePhoto(await solid(128, 128, 130))).rejects.toMatchObject({
      status: 422,
    });
  });

  it('accepts an ordinary photograph of ink on paper', async () => {
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="400" height="300">
      <rect width="400" height="300" fill="#efeadf"/>
      <path d="M 40 220 C 120 60, 200 260, 280 100 S 360 180, 390 140"
        fill="none" stroke="#232838" stroke-width="9"/>
    </svg>`;
    const photo = new Uint8Array(await sharp(Buffer.from(svg)).jpeg().toBuffer());
    const normalised = await normalizeCapturePhoto(photo);
    expect(normalised.width).toBe(400);
    expect(normalised.contentType).toBe('image/jpeg');
  });
});
