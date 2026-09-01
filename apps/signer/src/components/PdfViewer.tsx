import { useEffect, useRef, useState } from 'react';
import * as pdfjs from 'pdfjs-dist';
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';

pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;

export interface RenderedPage {
  /** 1-based page number. */
  page: number;
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
const PdfPage = ({
  doc,
  page,
  maxWidth,
  onRendered,
  children,
}: {
  doc: pdfjs.PDFDocumentProxy;
  page: number;
  maxWidth: number;
  onRendered?: (size: RenderedPage) => void;
  children?: (size: RenderedPage) => React.ReactNode;
}) => {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [size, setSize] = useState<RenderedPage | null>(null);

  useEffect(() => {
    let cancelled = false;
    let task: { promise: Promise<void>; cancel: () => void } | null = null;

    const run = async () => {
      const pdfPage = await doc.getPage(page);
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

      const rendered = { page, width: viewport.width, height: viewport.height };
      setSize(rendered);
      onRendered?.(rendered);
    };

    void run().catch(() => {
      /* a cancelled render is normal while scrolling quickly */
    });
    return () => {
      cancelled = true;
      task?.cancel();
    };
    // onRendered is an inline closure at the call site; re-rendering the page on
    // every parent render would thrash the canvas.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [doc, page, maxWidth]);

  return (
    <div className="relative inline-block" data-page={page}>
      <canvas ref={canvasRef} className="block rounded-lg shadow-sm ring-1 ring-ink-200" />
      {size && children?.(size)}
      <span className="pointer-events-none absolute -top-2 left-2 rounded bg-ink-800/80 px-1.5 py-0.5 text-[10px] font-medium text-white">
        Page {page}
      </span>
    </div>
  );
};

/**
 * Every page of the document, stacked and scrollable — the way a PDF reader
 * behaves. Paging through with arrows made it hard to judge where a zone sits
 * relative to the rest of the contract, and easy to lose your place.
 */
export const PdfViewer = ({
  url,
  maxWidth = 900,
  onPageCount,
  onRendered,
  renderOverlay,
}: {
  url: string;
  maxWidth?: number;
  onPageCount?: (count: number) => void;
  onRendered?: (size: RenderedPage) => void;
  /** Drawn on top of a page, in that page's own viewport pixels. */
  renderOverlay?: (size: RenderedPage) => React.ReactNode;
}) => {
  const [doc, setDoc] = useState<pdfjs.PDFDocumentProxy | null>(null);
  const [pageCount, setPageCount] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    let loadingTask: pdfjs.PDFDocumentLoadingTask | null = null;

    const run = async () => {
      setLoading(true);
      setError(null);
      try {
        loadingTask = pdfjs.getDocument({ url });
        const loaded = await loadingTask.promise;
        if (cancelled) return;
        setDoc(loaded);
        setPageCount(loaded.numPages);
        onPageCount?.(loaded.numPages);
      } catch {
        if (!cancelled) setError("Impossible d'afficher ce PDF.");
      } finally {
        if (!cancelled) setLoading(false);
      }
    };

    void run();
    return () => {
      cancelled = true;
      // In pdf.js 6 the worker is torn down through the loading task; the
      // document proxy has no destroy().
      void loadingTask?.destroy();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [url]);

  if (loading) {
    return (
      <div className="flex h-96 items-center justify-center rounded-lg bg-white text-sm text-ink-400 ring-1 ring-ink-200">
        Chargement du document…
      </div>
    );
  }
  if (error || !doc) {
    return (
      <div className="flex h-96 items-center justify-center rounded-lg bg-white text-sm text-red-600 ring-1 ring-ink-200">
        {error ?? 'Document indisponible.'}
      </div>
    );
  }

  return (
    <div className="flex flex-col items-center gap-6">
      {Array.from({ length: pageCount }, (_, i) => i + 1).map((page) => (
        <PdfPage
          key={page}
          doc={doc}
          page={page}
          maxWidth={maxWidth}
          onRendered={onRendered}
        >
          {renderOverlay}
        </PdfPage>
      ))}
    </div>
  );
};
