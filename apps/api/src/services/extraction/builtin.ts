import sharp, { type OutputInfo } from 'sharp';
import { HttpError } from '../../lib/errors.js';
import type { ExtractionInput, ExtractionResult, ImageExtractionProvider } from './provider.js';

/**
 * Ink on paper, cut out by arithmetic — no service, no model, no network.
 *
 * The hosted engines are built for photographs of objects. Handed a clean scan
 * of a signature — black strokes on white — remove.bg answers "could not
 * identify foreground", and the on-premises containers need Docker, which this
 * deployment does not have. Yet the input here is the easiest case in image
 * processing: a light, roughly uniform paper and darker (or coloured) marks on
 * it. That is a threshold, not a segmentation.
 *
 * Per pixel, "inkness" is the larger of two signals: how far below the paper
 * level its luminance falls (pen, pencil, printed toner) and how saturated it
 * is (a red or blue stamp on white paper is not much darker than the paper,
 * but it is very much more colourful). A soft ramp between two levels gives an
 * anti-aliased edge instead of a staircase. The colour of the stroke is kept,
 * so blue ink stays blue; the pipeline's `restoreInk` darkens it afterwards
 * the same way it does for every other engine.
 *
 * Paper level comes from the image itself — a high percentile of luminance —
 * so a photograph of a cream sheet under warm light works as well as a scan.
 * What this does NOT do is remove a desk, a shadow edge or a neighbouring
 * word: it assumes the box the operator (or the sheet's markers) framed holds
 * paper and ink and little else. That is exactly what the capture sheet
 * guarantees, and it is why this engine is the fallback that is always there.
 */

/** Below this share of pixels marked as ink, the box held nothing to cut out. */
const MIN_INK_SHARE = 0.0005;
/** Above this share, the "paper" is not paper: a dark desk, a photo of a hand. */
const MAX_INK_SHARE = 0.6;

const percentile = (histogram: Uint32Array, total: number, p: number): number => {
  const target = total * p;
  let seen = 0;
  for (let v = 0; v < 256; v++) {
    seen += histogram[v]!;
    if (seen >= target) return v;
  }
  return 255;
};

const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);

export class BuiltinInkProvider implements ImageExtractionProvider {
  readonly name = 'builtin-ink';

  /** Always: there is nothing to be down. */
  async healthy(): Promise<boolean> {
    return true;
  }

  extractSignature(input: ExtractionInput): Promise<ExtractionResult> {
    return this.extract(input, 'SIGNATURE_EXTRACTION_FAILED');
  }

  extractStamp(input: ExtractionInput): Promise<ExtractionResult> {
    return this.extract(input, 'STAMP_EXTRACTION_FAILED');
  }

  private async extract(input: ExtractionInput, failureCode: string): Promise<ExtractionResult> {
    let raw: { data: Buffer; info: OutputInfo };
    try {
      raw = await sharp(Buffer.from(input.image), { failOn: 'none' })
        .removeAlpha()
        .raw()
        .toBuffer({ resolveWithObject: true });
    } catch (cause) {
      throw new HttpError(400, "L'image à détourer est illisible.", failureCode, {
        cause: String(cause),
      });
    }
    const { data, info } = raw;
    const { width, height, channels } = info;
    const pixels = width * height;

    // Luminance and chroma per pixel, plus the luminance histogram the paper
    // level is read from.
    const lum = new Uint8Array(pixels);
    const chroma = new Uint8Array(pixels);
    const histogram = new Uint32Array(256);
    for (let i = 0; i < pixels; i++) {
      const o = i * channels;
      const r = data[o]!;
      const g = channels > 1 ? data[o + 1]! : r;
      const b = channels > 2 ? data[o + 2]! : r;
      const l = (r * 299 + g * 587 + b * 114) / 1000;
      lum[i] = l;
      chroma[i] = Math.max(r, g, b) - Math.min(r, g, b);
      histogram[Math.round(l)]! += 1;
    }

    // The paper is the bright bulk. A high percentile rather than the maximum,
    // so a glint or a white border cannot drag it up; not the median, so a box
    // half full of ink still reads its paper correctly.
    const paper = percentile(histogram, pixels, 0.85);
    // How much darker than the paper a pixel must be to count as ink. Scaled
    // with the paper level so a dim photograph still separates, floored so JPEG
    // ripple on white never does.
    const inkStart = Math.max(14, paper * 0.08);
    const inkFull = Math.max(inkStart + 18, paper * 0.3);
    // Colour: printed paper has almost none; a stamp has plenty.
    const chromaStart = 28;
    const chromaFull = 70;

    const rgba = Buffer.alloc(pixels * 4);
    let inkCount = 0;
    for (let i = 0; i < pixels; i++) {
      const dark = clamp01((paper - lum[i]! - inkStart) / (inkFull - inkStart));
      const colour = clamp01((chroma[i]! - chromaStart) / (chromaFull - chromaStart));
      const inkness = Math.max(dark, colour);
      // Hermite ramp for a soft, anti-aliased edge.
      const alpha = inkness * inkness * (3 - 2 * inkness);
      const o = i * channels;
      const q = i * 4;
      rgba[q] = data[o]!;
      rgba[q + 1] = channels > 1 ? data[o + 1]! : data[o]!;
      rgba[q + 2] = channels > 2 ? data[o + 2]! : data[o]!;
      rgba[q + 3] = Math.round(alpha * 255);
      if (alpha > 0.5) inkCount += 1;
    }

    const share = inkCount / pixels;
    if (share < MIN_INK_SHARE) {
      throw new HttpError(
        422,
        "Aucune trace d'encre détectée dans la zone sélectionnée.",
        failureCode,
        { engine: this.name, share },
      );
    }
    if (share > MAX_INK_SHARE) {
      throw new HttpError(
        422,
        'La zone sélectionnée est trop sombre pour distinguer l’encre du papier. Recadrez sur le papier.',
        failureCode,
        { engine: this.name, share },
      );
    }

    const png = await sharp(rgba, { raw: { width, height, channels: 4 } }).png().toBuffer();
    return {
      png: new Uint8Array(png),
      meta: { engine: this.name, paper, inkShare: Number(share.toFixed(4)) },
    };
  }
}
