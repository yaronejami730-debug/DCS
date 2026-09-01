/**
 * Signature synthesis lab.
 *
 * Renders a cutout's traced trajectory and a spread of Sigma-Lognormal variants
 * to disk, so the generator can be judged by looking at it rather than by
 * reading its parameters.
 *
 *   pnpm variants:lab <signature.png> [count] [--out DIR] [--motion-only]
 *
 * Input is any image; a transparent PNG cutout — what the extraction step
 * produces — gives the truest picture, since that is what actually gets stamped
 * on a document. Writes:
 *
 *   trace.png          the recovered pen path, coloured by stroke
 *   original.png       the input, for side-by-side comparison
 *   variant-N.png      each variant
 *   contact-sheet.png  all of them stacked, which is how you actually judge it
 *
 * Reads no environment and touches no database: it imports the synthesis
 * module directly.
 */

import sharp from 'sharp';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import {
  modelSignature,
  synthesizeVariant,
  type SignatureModel,
  type Trajectory,
} from '../src/services/synsig/index.js';

const args = process.argv.slice(2);
const flags = new Set(args.filter((a) => a.startsWith('--')));
const positional = args.filter((a) => !a.startsWith('--'));

const outFlagIndex = args.indexOf('--out');
const outDir = resolve(outFlagIndex >= 0 ? (args[outFlagIndex + 1] ?? 'variants-lab') : 'variants-lab');

const input = positional[0];
if (!input) {
  console.error('usage: pnpm variants:lab <signature.png> [count] [--out DIR] [--motion-only]');
  process.exit(1);
}

const count = Math.max(1, Math.min(12, Number(positional[1] ?? 5) || 5));
const motionOnly = flags.has('--motion-only');

/** Draw the recovered trajectory: one colour per pen-down run, dots per sample. */
const drawTrace = async (trajectory: Trajectory): Promise<Buffer> => {
  const palette = ['#e6194b', '#3cb44b', '#4363d8', '#f58231', '#911eb4', '#008080', '#9a6324'];
  const paths = trajectory.strokes
    .map((stroke, i) => {
      const d = stroke.samples
        .map((p, k) => `${k === 0 ? 'M' : 'L'} ${p.x.toFixed(2)} ${p.y.toFixed(2)}`)
        .join(' ');
      const colour = palette[i % palette.length]!;
      const start = stroke.samples[0]!;
      return (
        `<path d="${d}" fill="none" stroke="${colour}" stroke-width="1.6" opacity="0.95"/>` +
        `<circle cx="${start.x.toFixed(2)}" cy="${start.y.toFixed(2)}" r="3.2" fill="${colour}"/>`
      );
    })
    .join('');

  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${trajectory.width}" height="${trajectory.height}">${paths}</svg>`;
  return sharp(Buffer.from(svg)).png().toBuffer();
};

/** Stack labelled rows on white, so variants can be compared at a glance. */
const contactSheet = async (rows: Array<{ label: string; png: Uint8Array }>): Promise<Buffer> => {
  const decoded = await Promise.all(
    rows.map(async (row) => {
      const meta = await sharp(Buffer.from(row.png)).metadata();
      return { ...row, width: meta.width ?? 1, height: meta.height ?? 1 };
    }),
  );

  const pad = 18;
  const labelWidth = 130;
  const width = Math.max(...decoded.map((d) => d.width)) + labelWidth + pad * 2;
  const rowHeights = decoded.map((d) => d.height + pad);
  const height = rowHeights.reduce((a, b) => a + b, 0) + pad;

  const labels = decoded
    .map((d, i) => {
      const top = rowHeights.slice(0, i).reduce((a, b) => a + b, pad) + d.height / 2;
      return `<text x="${pad}" y="${top}" font-family="ui-monospace,monospace" font-size="15" fill="#333">${d.label}</text>`;
    })
    .join('');

  const base = sharp({
    create: { width, height, channels: 4, background: { r: 255, g: 255, b: 255, alpha: 1 } },
  });

  return base
    .composite([
      {
        input: Buffer.from(
          `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">${labels}</svg>`,
        ),
        top: 0,
        left: 0,
      },
      ...decoded.map((d, i) => ({
        input: Buffer.from(d.png),
        top: rowHeights.slice(0, i).reduce((a, b) => a + b, pad),
        left: labelWidth,
      })),
    ])
    .png()
    .toBuffer();
};

const describe = (model: SignatureModel): string => {
  const components = model.runs.reduce((n, run) => n + run.components.length, 0);
  const sigmas = model.runs.flatMap((run) => run.components.map((c) => c.sigma));
  const mean = sigmas.reduce((a, b) => a + b, 0) / Math.max(1, sigmas.length);
  return [
    `  pen-down runs      ${model.runs.length}`,
    `  lognormal strokes  ${components}`,
    `  mean sigma         ${mean.toFixed(3)}`,
    `  pen radius         ${model.penRadius.toFixed(2)} px`,
  ].join('\n');
};

const main = async (): Promise<void> => {
  const png = new Uint8Array(await readFile(resolve(input)));
  await mkdir(outDir, { recursive: true });

  console.log(`\nmodelling ${input}`);
  const modelled = await modelSignature(png);

  if (!modelled) {
    console.error(
      '\n  could not model this image.\n' +
        '  The mark is too faint, too fragmented, or not handwriting.\n' +
        '  In the pipeline this falls back to the affine + drift filter.\n',
    );
    process.exit(2);
  }

  console.log(describe(modelled.model));
  console.log(`  reconstruction     ${(modelled.error * 100).toFixed(2)}% of height`);

  await writeFile(resolve(outDir, 'trace.png'), await drawTrace(modelled.trajectory));
  await writeFile(resolve(outDir, 'original.png'), Buffer.from(png));

  const rows: Array<{ label: string; png: Uint8Array }> = [{ label: 'original', png }];

  for (let i = 0; i < count; i++) {
    const variant = await synthesizeVariant(png, i, { motionOnly });
    if (!variant) {
      console.error(`  variant ${i}: not produced`);
      continue;
    }
    await writeFile(resolve(outDir, `variant-${i}.png`), Buffer.from(variant));
    rows.push({ label: `variant ${i}`, png: variant });
  }

  await writeFile(resolve(outDir, 'contact-sheet.png'), await contactSheet(rows));

  console.log(`\n  wrote ${rows.length - 1} variants to ${outDir}`);
  console.log(`  open ${resolve(outDir, 'contact-sheet.png')}\n`);
};

await main();
