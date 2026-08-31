import { useEffect, useRef, useState } from 'react';
import * as pdfjs from 'pdfjs-dist';
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';

pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;

export interface RenderedPage {
  /** On-screen size of the rendered canvas, in CSS pixels. */
  width: number;
  height: number;
}

/**
 * Renders one page of a PDF to a canvas, scaled to fill the available width.
 *
 * pdf.js `getViewport()` already applies the page's /Rotate, so the canvas the
 * operator draws on is the *viewport* space — exactly the space our normalized
 * zone coordinates are defined in. That is what makes a zone drawn here land in
 * the right place on a rotated page at generation time.
 */
export const PdfViewer = ({
  url,
  page,
  maxWidth = 900,
  onPageCount,
  onRendered,
  children,
}: {
  url: string;
  page: number;
  maxWidth?: number;
  onPageCount?: (count: number) => void;
  onRendered?: (size: RenderedPage) => void;
  children?: React.ReactNode;
}) => {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [size, setSize] = useState<RenderedPage | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    // Hold the loading task, not the document: in pdf.js 6 tearing down the
    // worker is `loadingTask.destroy()`, and the document has no destroy().
    let loadingTask: pdfjs.PDFDocumentLoadingTask | null = null;
    let task: { promise: Promise<void>; cancel: () => void } | null = null;

    const run = async () => {
      setLoading(true);
      setError(null);
      try {
        loadingTask = pdfjs.getDocument({ url });
        const doc = await loadingTask.promise;
        if (cancelled) return;
        onPageCount?.(doc.numPages);

        const pageNumber = Math.min(Math.max(page, 1), doc.numPages);
        const pdfPage = await doc.getPage(pageNumber);
        if (cancelled) return;

        const base = pdfPage.getViewport({ scale: 1 });
        const scale = Math.min(maxWidth / base.width, 2);
        const viewport = pdfPage.getViewport({ scale });

        const canvas = canvasRef.current;
        if (!canvas) return;
        const ratio = window.devicePixelRatio || 1;
        canvas.width = Math.floor(viewport.width * ratio);
        canvas.height = Math.floor(viewport.height * ratio);
        canvas.style.width = `${viewport.width}px`;
        canvas.style.height = `${viewport.height}px`;

        const context = canvas.getContext('2d');
        if (!context) return;
        context.setTransform(ratio, 0, 0, ratio, 0, 0);

        task = pdfPage.render({ canvas, canvasContext: context, viewport });
        await task.promise;
        if (cancelled) return;

        const rendered = { width: viewport.width, height: viewport.height };
        setSize(rendered);
        onRendered?.(rendered);
      } catch (e) {
        if (!cancelled && !String(e).includes('Rendering cancelled')) {
          setError("Impossible d'afficher ce PDF.");
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    };

    void run();
    return () => {
      cancelled = true;
      task?.cancel();
      void loadingTask?.destroy();
    };
    // onRendered/onPageCount are intentionally excluded: callers pass inline
    // closures and re-rendering the page on every parent render would thrash.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [url, page, maxWidth]);

  return (
    <div className="relative inline-block">
      <canvas ref={canvasRef} className="block rounded-lg shadow-sm ring-1 ring-ink-200" />
      {size && children}
      {loading && (
        <div className="absolute inset-0 flex items-center justify-center rounded-lg bg-white/70 text-sm text-ink-400">
          Chargement…
        </div>
      )}
      {error && (
        <div className="absolute inset-0 flex items-center justify-center rounded-lg bg-white text-sm text-red-600">
          {error}
        </div>
      )}
    </div>
  );
};
