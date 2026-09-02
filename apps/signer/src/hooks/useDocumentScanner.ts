import { useCallback, useEffect, useRef, useState } from 'react';
import { Scanner, extractDocument, scanDocument } from 'scanic';
import { assessExposure, assessSharpness, downscaleGrey, rgbaToGrey } from '@scansign/shared';
import {
  DEFAULT_STABILITY,
  DEFAULT_VALIDATION,
  type CameraPermission,
  type Corners,
  type ScannedDocument,
  type ScannerStatus,
  type ScannerVerdict,
  type StabilityOptions,
  type ValidationOptions,
} from '../types/scanner';
import { validateDocumentDetection } from '../utils/documentValidation';
import { maxCornerDisplacement, scaleCorners } from '../utils/perspective';
import { StabilityTracker } from './useScannerStability';

/**
 * The live scanner: camera in, verdict out, straightened page on capture.
 *
 * What runs where, and why:
 *
 *   - The camera preview is a plain <video> the browser composites itself.
 *     Nothing here touches it per frame.
 *   - Detection runs on a small canvas copy (~480px wide) about ten times a
 *     second, in scanic's WebAssembly, off the React render path. A persistent
 *     `Scanner` instance keeps the WASM warm.
 *   - React state is written only when something the UI shows has changed:
 *     the status, or corners that moved by more than a fraction of a percent.
 *     A verdict that repeats itself costs no render.
 *   - The shutter re-checks the latest verdict through a ref at the moment of
 *     the tap. The disabled button is a courtesy; this check is the rule.
 *   - Capture draws the full-resolution frame once and hands the detected
 *     corners, scaled up, to scanic's perspective warp. The user gets the page,
 *     flat, plus the original frame for anyone who wants to re-crop.
 */

/** Width of the detection copy. Enough for edges, cheap enough for a phone. */
const DETECT_WIDTH = 540;
/**
 * Detector dropouts tolerated before the page is declared gone.
 *
 * The classical detector misses an occasional frame — a glint, a shadow
 * crossing an edge — while the page has not moved. Treating each miss as
 * "no document" made the contour blink and reset the stability clock. Up to
 * this many consecutive misses, the last corners stand in.
 */
const MAX_MISSES = 3;
/** Weight of the newest corners in the moving average shown and judged. */
const SMOOTHING = 0.45;
/** A jump larger than this (normalized) is a new position, not noise: snap. */
const SNAP_DISTANCE = 0.12;
/** Long edge of the captured frame. Matches the rest of the app's uploads. */
const CAPTURE_MAX_EDGE = 2400;
/** Pause between two detections, on top of the detection itself. */
const TICK_MS = 80;
/** Corners must move at least this much (normalized) for a re-render. */
const CORNER_EPSILON = 0.004;
/** Image quality is judged every Nth tick; it is cheaper than detection but not free. */
const QUALITY_EVERY = 3;

export interface FrameSize {
  width: number;
  height: number;
}

export interface UseDocumentScannerOptions {
  validation?: ValidationOptions;
  stability?: StabilityOptions;
  /** Off by default; on, the hook does not start the camera until `start()` is called. */
  manualStart?: boolean;
}

export interface DocumentScannerControls {
  videoRef: React.RefObject<HTMLVideoElement | null>;
  permission: CameraPermission;
  /** Intrinsic size of the video frames, once known. Drives the overlay's viewBox. */
  frame: FrameSize | null;
  verdict: ScannerVerdict;
  capturing: boolean;
  /** Null when the frame was not ready at the moment of the tap. */
  capture: () => Promise<ScannedDocument | null>;
  /** (Re)ask for the camera — after a refusal, or with `manualStart`. */
  start: () => void;
}

const IDLE_VERDICT: ScannerVerdict = { status: 'searching', ready: false, corners: null };

const isSecureContext = (): boolean =>
  typeof window !== 'undefined' &&
  (window.isSecureContext ||
    window.location.hostname === 'localhost' ||
    window.location.hostname === '127.0.0.1');

export const cameraSupported = (): boolean =>
  isSecureContext() && typeof navigator !== 'undefined' && Boolean(navigator.mediaDevices?.getUserMedia);

const toJpeg = (canvas: HTMLCanvasElement, quality = 0.92): Promise<Blob> =>
  new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => (blob ? resolve(blob) : reject(new Error('encodage impossible'))),
      'image/jpeg',
      quality,
    );
  });

export const useDocumentScanner = (options: UseDocumentScannerOptions = {}): DocumentScannerControls => {
  const validation = options.validation ?? DEFAULT_VALIDATION;
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const scannerRef = useRef<Scanner | null>(null);
  const trackerRef = useRef(new StabilityTracker(options.stability ?? DEFAULT_STABILITY));
  const workCanvas = useRef<HTMLCanvasElement | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const running = useRef(false);
  const busy = useRef(false);
  const tick = useRef(0);
  const lastQuality = useRef<ScannerStatus | null>(null);
  /** Smoothed corners of the last frames, and how many frames in a row had none. */
  const smoothed = useRef<Corners | null>(null);
  const misses = useRef(0);
  /** The verdict the UI last saw — and the one the shutter trusts. */
  const latest = useRef<ScannerVerdict>(IDLE_VERDICT);

  const [permission, setPermission] = useState<CameraPermission>(
    cameraSupported() ? 'checking' : 'unsupported',
  );
  const [frame, setFrame] = useState<FrameSize | null>(null);
  const [verdict, setVerdict] = useState<ScannerVerdict>(IDLE_VERDICT);
  const [capturing, setCapturing] = useState(false);

  const publish = useCallback((next: ScannerVerdict) => {
    const prev = latest.current;
    const cornersMoved =
      (prev.corners === null) !== (next.corners === null) ||
      (prev.corners && next.corners && maxCornerDisplacement(prev.corners, next.corners) > CORNER_EPSILON);
    if (prev.status === next.status && prev.ready === next.ready && !cornersMoved) return;
    latest.current = next;
    setVerdict(next);
  }, []);

  const stopLoop = useCallback(() => {
    running.current = false;
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
  }, []);

  /** One detection pass, then schedule the next. Never overlaps itself. */
  const step = useCallback(async () => {
    if (!running.current) return;
    const video = videoRef.current;
    if (!video || video.readyState < 2 || !video.videoWidth || busy.current) {
      timer.current = setTimeout(() => void step(), TICK_MS);
      return;
    }
    busy.current = true;
    try {
      const vw = video.videoWidth;
      const vh = video.videoHeight;
      const scale = Math.min(1, DETECT_WIDTH / vw);
      const w = Math.max(1, Math.round(vw * scale));
      const h = Math.max(1, Math.round(vh * scale));
      const canvas = (workCanvas.current ??= document.createElement('canvas'));
      if (canvas.width !== w || canvas.height !== h) {
        canvas.width = w;
        canvas.height = h;
      }
      const context = canvas.getContext('2d', { willReadFrequently: true });
      if (!context) return;
      context.drawImage(video, 0, 0, w, h);

      const scanner = (scannerRef.current ??= new Scanner());
      const result = await scanner.scan(canvas, { mode: 'detect', maxProcessingDimension: DETECT_WIDTH });
      const raw: Corners | null =
        result.success && result.corners ? scaleCorners(result.corners, 1 / w, 1 / h) : null;

      // Smooth, and bridge short dropouts, before judging anything.
      let corners: Corners | null;
      if (raw) {
        misses.current = 0;
        const prev = smoothed.current;
        if (prev && maxCornerDisplacement(prev, raw) < SNAP_DISTANCE) {
          const mix = (a: number, b: number) => a + (b - a) * SMOOTHING;
          corners = {
            topLeft: { x: mix(prev.topLeft.x, raw.topLeft.x), y: mix(prev.topLeft.y, raw.topLeft.y) },
            topRight: { x: mix(prev.topRight.x, raw.topRight.x), y: mix(prev.topRight.y, raw.topRight.y) },
            bottomRight: {
              x: mix(prev.bottomRight.x, raw.bottomRight.x),
              y: mix(prev.bottomRight.y, raw.bottomRight.y),
            },
            bottomLeft: {
              x: mix(prev.bottomLeft.x, raw.bottomLeft.x),
              y: mix(prev.bottomLeft.y, raw.bottomLeft.y),
            },
          };
        } else {
          corners = raw;
        }
        smoothed.current = corners;
      } else if (smoothed.current && misses.current < MAX_MISSES) {
        misses.current += 1;
        corners = smoothed.current;
      } else {
        misses.current += 1;
        smoothed.current = null;
        corners = null;
      }

      const framing = validateDocumentDetection(corners, validation);

      // Quality, every few ticks, on the same pixels — no second draw.
      tick.current += 1;
      if (framing.status === 'framed' && tick.current % QUALITY_EVERY === 1) {
        const { data } = context.getImageData(0, 0, w, h);
        const grey = downscaleGrey(rgbaToGrey(data, w * h), w, h, 400);
        const sharp = assessSharpness(grey.grey, grey.width, grey.height);
        const light = assessExposure(grey.grey);
        lastQuality.current = light.level === 'bad' ? 'dark' : sharp.level === 'bad' ? 'blurry' : null;
      } else if (framing.status !== 'framed') {
        lastQuality.current = null;
      }

      const framed = framing.status === 'framed' && lastQuality.current === null;
      const stability = trackerRef.current.push(framed, corners, performance.now());

      let status: ScannerStatus;
      if (framing.status !== 'framed') status = framing.status;
      else if (lastQuality.current) status = lastQuality.current;
      else if (stability !== 'stable') status = 'unstable';
      else status = 'ready';

      publish({ status, ready: status === 'ready', corners });
    } catch {
      // A frame we could not read; the next one will do.
    } finally {
      busy.current = false;
      if (running.current) timer.current = setTimeout(() => void step(), TICK_MS);
    }
  }, [publish, validation]);

  const startLoop = useCallback(() => {
    if (running.current) return;
    running.current = true;
    trackerRef.current.reset();
    smoothed.current = null;
    misses.current = 0;
    void step();
  }, [step]);

  const start = useCallback(() => {
    if (!cameraSupported()) {
      setPermission('unsupported');
      return;
    }
    let cancelled = false;
    setPermission('checking');
    void (async () => {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({
          video: {
            facingMode: { ideal: 'environment' },
            width: { ideal: 1920 },
            height: { ideal: 1080 },
          },
          audio: false,
        });
        if (cancelled) {
          for (const t of stream.getTracks()) t.stop();
          return;
        }
        streamRef.current = stream;
        const video = videoRef.current;
        if (video) {
          video.srcObject = stream;
          await video.play().catch(() => {
            /* autoplay policy; the frame still renders */
          });
          const settle = () => {
            if (video.videoWidth && video.videoHeight) {
              setFrame({ width: video.videoWidth, height: video.videoHeight });
            }
          };
          settle();
          video.onloadedmetadata = settle;
          video.onresize = settle;
        }
        setPermission('granted');
        startLoop();
      } catch (error) {
        const name = error instanceof DOMException ? error.name : '';
        // NotAllowedError is a refusal — this time, or a remembered one. There is
        // no browser API to tell the two apart, so the UI explains both.
        setPermission(name === 'NotFoundError' || name === 'OverconstrainedError' ? 'unsupported' : 'denied');
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [startLoop]);

  useEffect(() => {
    if (options.manualStart) return;
    const cancel = start();
    return () => {
      cancel?.();
      stopLoop();
      for (const t of streamRef.current?.getTracks() ?? []) t.stop();
      streamRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const capture = useCallback(async (): Promise<ScannedDocument | null> => {
    // The rule, not the button: whatever the UI shows, the frame must be ready now.
    const current = latest.current;
    const video = videoRef.current;
    if (!current.ready || !current.corners || !video || !video.videoWidth || capturing) return null;

    setCapturing(true);
    publish({ ...current, status: 'capturing', ready: false });
    stopLoop();
    try {
      const vw = video.videoWidth;
      const vh = video.videoHeight;
      const scale = Math.min(1, CAPTURE_MAX_EDGE / Math.max(vw, vh));
      const full = document.createElement('canvas');
      full.width = Math.round(vw * scale);
      full.height = Math.round(vh * scale);
      const context = full.getContext('2d');
      if (!context) return null;
      context.drawImage(video, 0, 0, full.width, full.height);

      const pixelCorners = scaleCorners(current.corners, full.width, full.height);
      let page: HTMLCanvasElement | null = null;
      try {
        const warped = await extractDocument(full, pixelCorners, { output: 'canvas' });
        if (warped.success && warped.output instanceof HTMLCanvasElement) page = warped.output;
      } catch {
        page = null;
      }
      if (!page) {
        // The corners of the live frame did not fit the still: let scanic look
        // at the full-resolution frame itself before giving up on straightening.
        try {
          const again = await scanDocument(full, { mode: 'extract', output: 'canvas' });
          if (again.success && again.output instanceof HTMLCanvasElement) page = again.output;
        } catch {
          page = null;
        }
      }
      const output = page ?? full;
      const [blob, originalBlob] = await Promise.all([toJpeg(output), toJpeg(full)]);
      return {
        uri: URL.createObjectURL(blob),
        blob,
        width: output.width,
        height: output.height,
        corners: current.corners,
        original: {
          uri: URL.createObjectURL(originalBlob),
          blob: originalBlob,
          width: full.width,
          height: full.height,
        },
      };
    } finally {
      setCapturing(false);
      latest.current = IDLE_VERDICT;
      setVerdict(IDLE_VERDICT);
      if (streamRef.current) startLoop();
    }
  }, [capturing, publish, startLoop, stopLoop]);

  return { videoRef, permission, frame, verdict, capturing, capture, start };
};
