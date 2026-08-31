import { Platform } from 'react-native';

/**
 * Physical feedback for the moments that deserve it.
 *
 * The shutter is the important one: the photo is taken and the screen changes
 * in the same instant, so a tap in the hand is what tells the user the capture
 * actually happened rather than a spinner they had to wait on.
 *
 * `expo-haptics` is resolved lazily and defensively. Haptics are a nicety, and
 * a nicety must never be able to take the app down — a stale Metro module map,
 * a half-finished install, or a runtime without the module should cost the tap,
 * not the signature flow. A static import turns any of those into a red screen
 * on a screen the signer needs.
 */

type HapticsModule = typeof import('expo-haptics');

let cached: HapticsModule | null | undefined;

const load = (): HapticsModule | null => {
  if (cached !== undefined) return cached;
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    cached = require('expo-haptics') as HapticsModule;
  } catch {
    cached = null;
  }
  return cached;
};

const safely = (run: (haptics: HapticsModule) => Promise<unknown>): void => {
  if (Platform.OS === 'web') return;
  const haptics = load();
  if (!haptics) return;
  try {
    void run(haptics).catch(() => {
      /* a device with the Taptic Engine off, or a simulator */
    });
  } catch {
    /* never let feedback break the caller */
  }
};

/** The shutter fired. */
export const hapticShutter = (): void =>
  safely((h) => h.impactAsync(h.ImpactFeedbackStyle.Medium));

/** A step completed — moving on to the next mark. */
export const hapticSuccess = (): void =>
  safely((h) => h.notificationAsync(h.NotificationFeedbackType.Success));

/** Something went wrong and the user has to act. */
export const hapticError = (): void =>
  safely((h) => h.notificationAsync(h.NotificationFeedbackType.Error));

/** A light tick for a selection, such as picking a capture mode. */
export const hapticSelect = (): void => safely((h) => h.selectionAsync());
