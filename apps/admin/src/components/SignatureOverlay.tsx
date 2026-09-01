import { useEffect, useRef, useState } from 'react';
import * as pdfjs from 'pdfjs-dist';
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import type { NormalizedRect } from '@scansign/shared';

pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;

export interface OverlayLayer {
  label: string;
  /** The signed PDF. */
  url: string;
  /** The same document before signing, used to isolate the mark. */
  originalUrl: string;
  page: number;
  rect: NormalizedRect;
  /** Ink colour for this layer, so the layers can be told apart. */
  colour: [number, number, number];
}

/**
 * Two signatures drawn on top of one another, each in its own colour.
 *
 * Side-by-side comparison has a real limit: two signings of the same hand look
 * alike, and the eye is poor at holding one shape in memory while it looks at
 * another a few centimetres away. Differences of a few percent are simply not
 * visible that way — which is why "je vois pas de différence" is the honest
 * reaction to a row of thumbnails even when the marks genuinely differ.
 *
 * Superimposing removes the memory step. Where the marks agree the colours pile
 * up and go dark; where they diverge a single colour shows through alone. What
 * you see is the difference itself rather than two things to compare.
 *
 * Two decisions carry the whole thing:
 *
 *  - **The mark is isolated by subtracting the original page from the signed
 *    one.** Looking for dark pixels instead would also find the printed caption
 *    sitting in the same zone, and the view would frame itself on "Signature et
 *    cachet du bénéficiaire" rather than on the signature. The difference is
 *    exactly what the generator added and nothing else.
 *  - **Alignment is on the ink, not on the zone.** Zones differ in size and
 *    proportion between documents, so scaling each mark to its own box shows
 *    the boxes disagreeing and passes it off as the signatures disagreeing.
 *    Measured on a real folder that painted four wildly divergent traces where
 *    the marks were in fact close.
 */
export const SignatureOverlay = ({
  layers,
  width = 760,
  align = 'ink',
}: {
  layers: OverlayLayer[];
  width?: number;
  /**
   * How each mark is framed.
   *
   * `ink` scales every mark to its own bounding box, so two marks land on top
   * of one another and only their SHAPE can differ. Right for the overlay.
   *
   * `zone` keeps the mark where and how big it actually is on the page. Right
   * for showing one document on its own, because size and position are half of
   * what distinguishes two signings — and normalising them away is precisely
   * why the differences were invisible on this screen.
   */
  align?: 'ink' | 'zone';
}) => {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [error, setError] = useState<string | null>(null);
  const [ready, setReady] = useState(false);

  // Layer identity, so the effect re-runs when the selection changes but not on
  // every parent render.
  const key = layers.map((l) => `${l.url}|${l.page}|${l.rect.x},${l.rect.y}|${align}`).join('~');

  useEffect(() => {
    let cancelled = false;
    const tasks: pdfjs.PDFDocumentLoadingTask[] = [];

    /** Render one page to a canvas at a given scale. */
    const renderPage = async (url: string, pageNumber: number, scale: number) => {
      const task = pdfjs.getDocument({ url });
      tasks.push(task);
      const doc = await task.promise;
      const page = await doc.getPage(Math.min(Math.max(1, pageNumber), doc.numPages));
      const viewport = page.getViewport({ scale });

      const canvas = document.createElement('canvas');
      canvas.width = Math.ceil(viewport.width);
      canvas.height = Math.ceil(viewport.height);
      const ctx = canvas.getContext('2d');
      if (!ctx) throw new Error('no 2d context');
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      await page.render({ canvasContext: ctx, viewport, canvas }).promise;
      return { canvas, ctx, viewport };
    };

    const run = async () => {
      setReady(false);
      setError(null);
      // One layer is a legitimate request: the same isolation and framing, used
      // to show a single document's mark on its own beside the overlay.
      if (layers.length === 0) return;

      try {
        const height = Math.round(width * 0.5);

        const canvas = canvasRef.current;
        if (!canvas) return;
        canvas.width = width;
        canvas.height = height;
        const ctx = canvas.getContext('2d');
        if (!ctx) throw new Error('no 2d context');
        ctx.fillStyle = '#ffffff';
        ctx.fillRect(0, 0, width, height);

        for (const layer of layers) {
          // Render generously: the whole mark must be measurable even where it
          // overflows the box it was stamped into.
          const probeTask = pdfjs.getDocument({ url: layer.url });
          tasks.push(probeTask);
          const probe = await probeTask.promise;
          const probePage = await probe.getPage(Math.min(Math.max(1, layer.page), probe.numPages));
          const base = probePage.getViewport({ scale: 1 });
          const scale = Math.min(6, width / (layer.rect.width * base.width));

          const signed = await renderPage(layer.url, layer.page, scale);
          const original = await renderPage(layer.originalUrl, layer.page, scale);
          if (cancelled) return;

          const w = Math.min(signed.canvas.width, original.canvas.width);
          const h = Math.min(signed.canvas.height, original.canvas.height);
          const a = signed.ctx.getImageData(0, 0, w, h);
          const b = original.ctx.getImageData(0, 0, w, h);

          /**
           * What the generator added: how much darker the signed page is.
           *
           * Kept as a coverage map on white, so the next steps can treat it as
           * an ordinary image of ink on paper.
           */
          const mark = new Uint8ClampedArray(w * h);
          let minX = w;
          let minY = h;
          let maxX = -1;
          let maxY = -1;

          for (let py = 0; py < h; py++) {
            for (let px = 0; px < w; px++) {
              const o = (py * w + px) * 4;
              const lumSigned =
                (a.data[o]! * 0.299 + a.data[o + 1]! * 0.587 + a.data[o + 2]! * 0.114) / 255;
              const lumOriginal =
                (b.data[o]! * 0.299 + b.data[o + 1]! * 0.587 + b.data[o + 2]! * 0.114) / 255;
              const added = Math.max(0, lumOriginal - lumSigned);
              const value = Math.round(added * 255);
              mark[py * w + px] = value;
              // A low bar for the bounding box: a signature's thin tails are
              // faint, and cropping them off would misalign the whole mark.
              if (added > 0.12) {
                if (px < minX) minX = px;
                if (px > maxX) maxX = px;
                if (py < minY) minY = py;
                if (py > maxY) maxY = py;
              }
            }
          }

          if (maxX < 0 || maxY < 0) continue;
          const inkW = maxX - minX + 1;
          const inkH = maxY - minY + 1;

          // Scale the mark's own bounding box into the shared frame, so two
          // marks land on top of one another whatever box each was stamped in.
          let fit: number;
          let offsetX: number;
          let offsetY: number;

          if (align === 'ink') {
            fit = Math.min((width * 0.94) / inkW, (height * 0.94) / inkH);
            offsetX = Math.round((width - inkW * fit) / 2);
            offsetY = Math.round((height - inkH * fit) / 2);
          } else {
            // Frame the ZONE, not the ink. The mark then keeps its real size
            // and its real place inside the box it was stamped into, which is
            // what makes one signing look bigger, or set higher, than another.
            const zoneW = layer.rect.width * w;
            const zoneH = layer.rect.height * h;
            fit = Math.min((width * 0.9) / zoneW, (height * 0.9) / zoneH);
            const zoneX = layer.rect.x * w;
            const zoneY = layer.rect.y * h;
            offsetX = Math.round((width - zoneW * fit) / 2 + (minX - zoneX) * fit);
            offsetY = Math.round((height - zoneH * fit) / 2 + (minY - zoneY) * fit);
          }

          const drawW = Math.max(1, Math.round(inkW * fit));
          const drawH = Math.max(1, Math.round(inkH * fit));

          const target = ctx.getImageData(0, 0, width, height);
          for (let dy = 0; dy < drawH; dy++) {
            const sy = minY + Math.floor((dy / drawH) * inkH);
            for (let dx = 0; dx < drawW; dx++) {
              const sx = minX + Math.floor((dx / drawW) * inkW);
              const coverage = mark[sy * w + sx]! / 255;
              if (coverage < 0.1) continue;

              const py = dy + offsetY;
              const px = dx + offsetX;
              // In zone framing the mark may reach outside the frame; clip
              // rather than wrapping onto the opposite edge.
              if (px < 0 || py < 0 || px >= width || py >= height) continue;

              const o = (py * width + px) * 4;
              for (let c = 0; c < 3; c++) {
                // The layer's colour where it covers, white where it does not,
                // multiplied in: agreement compounds towards black, and a
                // stroke only one document has keeps its own colour.
                const layerChannel = 255 - coverage * (255 - layer.colour[c]!);
                target.data[o + c] = Math.round((target.data[o + c]! * layerChannel) / 255);
              }
            }
          }
          ctx.putImageData(target, 0, 0);
        }

        if (!cancelled) setReady(true);
      } catch {
        if (!cancelled) setError('Superposition indisponible.');
      }
    };

    void run();
    return () => {
      cancelled = true;
      for (const task of tasks) void task.destroy();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, width]);

  if (error) {
    return (
      <div className="flex h-32 items-center justify-center rounded-md border border-ink-200 bg-ink-50">
        <p className="text-xs text-ink-400">{error}</p>
      </div>
    );
  }

  return (
    <div>
      <div className="relative overflow-hidden rounded-md border border-ink-200 bg-white">
        {!ready && (
          <div className="absolute inset-0 flex items-center justify-center">
            <p className="text-xs text-ink-400">Superposition…</p>
          </div>
        )}
        <canvas ref={canvasRef} className="block max-w-full" />
      </div>

      <ul className="mt-2 flex flex-wrap gap-x-4 gap-y-1">
        {layers.map((layer) => (
          <li key={layer.label} className="flex items-center gap-1.5 text-xs text-ink-600">
            <span
              className="inline-block h-2.5 w-2.5 rounded-sm"
              style={{ background: `rgb(${layer.colour.join(',')})` }}
            />
            <span className="truncate" title={layer.label}>
              {layer.label}
            </span>
          </li>
        ))}
      </ul>
      {layers.length > 1 && (
        <p className="mt-1.5 text-xs text-ink-400">
          Là où les deux signatures coïncident, les couleurs se cumulent et virent au noir. Une
          couleur seule signale un trait que ce document est le seul à porter.
        </p>
      )}
    </div>
  );
};
