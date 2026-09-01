/**
 * Ask the browser for the current position, once, with consent.
 *
 * The consent is not ours to grant or skip: the browser shows its own prompt
 * and there is no way around it, which is exactly right for something that
 * becomes evidence of where a person was. So this function is honest about the
 * three outcomes and hands all of them back to the caller rather than throwing:
 *
 *   coords   the technician allowed it and a fix was obtained
 *   denied   they refused, or the browser blocks it (insecure context, policy)
 *   unavailable  they allowed it but no fix came (indoors, no GPS, timeout)
 *
 * A refusal must never block the signature — the pages still go up, just
 * without a location — so the caller decides what to do with each outcome, and
 * nothing here decides for them.
 */
export interface GeolocationResult {
  latitude: number;
  longitude: number;
  accuracy: number | null;
}

export type GeolocationOutcome =
  | { status: 'coords'; coords: GeolocationResult }
  | { status: 'denied' }
  | { status: 'unavailable' };

export const requestLocation = (): Promise<GeolocationOutcome> =>
  new Promise((resolve) => {
    if (typeof navigator === 'undefined' || !navigator.geolocation) {
      resolve({ status: 'unavailable' });
      return;
    }
    navigator.geolocation.getCurrentPosition(
      (position) =>
        resolve({
          status: 'coords',
          coords: {
            latitude: position.coords.latitude,
            longitude: position.coords.longitude,
            // Some browsers report accuracy as 0 or NaN; keep only a real figure.
            accuracy:
              Number.isFinite(position.coords.accuracy) && position.coords.accuracy > 0
                ? position.coords.accuracy
                : null,
          },
        }),
      (error) =>
        resolve({ status: error.code === error.PERMISSION_DENIED ? 'denied' : 'unavailable' }),
      // A high-accuracy fix is worth waiting a little for — this is proof of
      // presence, not a map centring — but not forever on a phone indoors.
      { enableHighAccuracy: true, timeout: 15_000, maximumAge: 0 },
    );
  });
