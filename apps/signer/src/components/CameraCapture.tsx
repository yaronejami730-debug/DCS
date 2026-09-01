import { useEffect, useRef, useState } from 'react';
import { Button } from './ui';

/**
 * The viewfinder.
 *
 * `getUserMedia` gives the signer the same thing the iPhone app gives them: a
 * live frame with a guide rectangle, so the sheet is squared up before the
 * shutter rather than after. That matters more than it sounds — a photo taken
 * blind at arm's length is the single biggest cause of a bad cutout.
 *
 * It is not always available. The API needs a secure context, so it is absent
 * over plain HTTP on a LAN — which is exactly how this app is reached during
 * development — and a signer can refuse the permission outright. Both cases
 * fall back to `<input capture>`, which hands off to the phone's own camera
 * app: no live preview, no guide, but it works everywhere and returns the same
 * JPEG. The fallback is offered as a button at all times, never only after a
 * failure, because a signer who has already denied the permission cannot
 * un-deny it from inside the page.
 */

export type CaptureResult = { blob: Blob; url: string; width: number; height: number };

const JPEG_QUALITY = 0.9;
/**
 * Cap the long edge before upload.
 *
 * A modern phone sensor produces 4000px+ frames, which on a hotel WiFi is tens
 * of seconds of upload for detail the extraction engine discards anyway; it
 * works on the crop, not the frame. 2400 keeps a signature crisp at any
 * reasonable framing.
 */
const MAX_EDGE = 2400;

const isSecure = (): boolean =>
  typeof window !== 'undefined' &&
  (window.isSecureContext ||
    window.location.hostname === 'localhost' ||
    window.location.hostname === '127.0.0.1');

const cameraSupported = (): boolean =>
  isSecure() && typeof navigator !== 'undefined' && Boolean(navigator.mediaDevices?.getUserMedia);

/** Draw to a canvas at a bounded size, and hand back a JPEG plus its real dimensions. */
const encode = (
  source: CanvasImageSource,
  sourceWidth: number,
  sourceHeight: number,
): Promise<CaptureResult> => {
  const scale = Math.min(1, MAX_EDGE / Math.max(sourceWidth, sourceHeight));
  const width = Math.max(1, Math.round(sourceWidth * scale));
  const height = Math.max(1, Math.round(sourceHeight * scale));

  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext('2d');
  if (!context) return Promise.reject(new Error('canvas indisponible'));
  context.drawImage(source, 0, 0, width, height);

  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => {
        if (!blob) {
          reject(new Error('encodage impossible'));
          return;
        }
        resolve({ blob, url: URL.createObjectURL(blob), width, height });
      },
      'image/jpeg',
      JPEG_QUALITY,
    );
  });
};

/**
 * Re-encode a picked file through the same path as a live capture.
 *
 * Two reasons, both learned the hard way. A 12MP HEIC-converted JPEG straight
 * from the library is slow to upload and no better once cropped. And the
 * framing screen needs the pixel dimensions the *browser* sees: a photo with an
 * EXIF orientation flag reports its raw size, so a portrait shot framed against
 * a landscape rectangle put every region 90° out.
 */
export const fileToCapture = async (file: File): Promise<CaptureResult> => {
  const bitmap = await createImageBitmap(file).catch(() => null);
  if (bitmap) {
    const result = await encode(bitmap, bitmap.width, bitmap.height);
    bitmap.close();
    return result;
  }

  // Safari before 17 has no createImageBitmap for every type; an <img> element
  // applies EXIF orientation on its own.
  const url = URL.createObjectURL(file);
  try {
    const image = await new Promise<HTMLImageElement>((resolve, reject) => {
      const element = new Image();
      element.onload = () => resolve(element);
      element.onerror = () => reject(new Error('image illisible'));
      element.src = url;
    });
    return await encode(image, image.naturalWidth, image.naturalHeight);
  } finally {
    URL.revokeObjectURL(url);
  }
};

export const CameraCapture = ({
  onCapture,
  onError,
  busy = false,
  shutterLabel = 'Prendre la photo',
}: {
  onCapture: (result: CaptureResult) => void;
  onError: (message: string) => void;
  busy?: boolean;
  shutterLabel?: string;
}) => {
  const videoRef = useRef<HTMLVideoElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const [live, setLive] = useState(false);
  const [starting, setStarting] = useState(cameraSupported());
  const [notice, setNotice] = useState<string | null>(
    cameraSupported()
      ? null
      : isSecure()
        ? "Cet appareil n'expose pas de caméra au navigateur."
        : // The single most common cause, and the signer can act on it.
          'La caméra live demande une connexion sécurisée (HTTPS). Utilisez le bouton ci-dessous.',
  );

  useEffect(() => {
    if (!cameraSupported()) return;
    let cancelled = false;

    const start = async () => {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({
          // `environment` is a hint, not a guarantee: a laptop has one camera
          // and will simply give us that one rather than failing.
          video: { facingMode: { ideal: 'environment' }, width: { ideal: 2560 } },
          audio: false,
        });
        if (cancelled) {
          for (const track of stream.getTracks()) track.stop();
          return;
        }
        streamRef.current = stream;
        if (videoRef.current) {
          videoRef.current.srcObject = stream;
          await videoRef.current.play().catch(() => {
            /* autoplay policies; the poster frame is still shown */
          });
        }
        setLive(true);
      } catch {
        setNotice(
          "Caméra indisponible ou refusée. Utilisez « Prendre une photo avec l'appareil » ci-dessous.",
        );
      } finally {
        if (!cancelled) setStarting(false);
      }
    };

    void start();
    return () => {
      cancelled = true;
      // Release the camera, or the indicator light stays on and a second visit
      // to this screen cannot acquire the device.
      for (const track of streamRef.current?.getTracks() ?? []) track.stop();
      streamRef.current = null;
    };
  }, []);

  const shoot = async () => {
    const video = videoRef.current;
    if (!video || !live) return;
    try {
      onCapture(await encode(video, video.videoWidth, video.videoHeight));
    } catch {
      onError("La photo n'a pas pu être enregistrée.");
    }
  };

  const pick = async (file: File | undefined) => {
    if (!file) return;
    try {
      onCapture(await fileToCapture(file));
    } catch {
      onError("Cette image n'a pas pu être lue.");
    }
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="relative mx-4 min-h-[220px] flex-1 overflow-hidden rounded-2xl bg-black">
        {live ? (
          <video
            ref={videoRef}
            playsInline
            muted
            autoPlay
            className="h-full w-full object-cover"
          />
        ) : (
          <div className="flex h-full items-center justify-center p-6 text-center text-sm text-white/70">
            {starting ? 'Ouverture de la caméra…' : (notice ?? 'Caméra indisponible.')}
          </div>
        )}
        {live && (
          <div className="pointer-events-none absolute inset-x-[8%] inset-y-[10%] rounded-xl border-2 border-dashed border-white/60" />
        )}
      </div>

      {live && notice && <p className="mt-2 px-4 text-[13px] text-ink-400">{notice}</p>}

      <div className="p-5 pb-8">
        {live && (
          <Button onClick={() => void shoot()} loading={busy}>
            {shutterLabel}
          </Button>
        )}
        <Button
          variant={live ? 'secondary' : 'primary'}
          disabled={busy}
          onClick={() => fileRef.current?.click()}
          className={live ? 'mt-2.5' : ''}
        >
          {live ? 'Importer une photo' : "Prendre une photo avec l'appareil"}
        </Button>
        <input
          ref={fileRef}
          type="file"
          accept="image/*"
          // Opens the camera app directly on a phone; ignored on a desktop,
          // where it stays an ordinary file picker.
          capture="environment"
          hidden
          onChange={(e) => {
            void pick(e.target.files?.[0]);
            // Let the same file be chosen twice in a row.
            e.target.value = '';
          }}
        />
      </div>
    </div>
  );
};
