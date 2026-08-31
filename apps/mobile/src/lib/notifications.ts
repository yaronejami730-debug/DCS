import * as Notifications from 'expo-notifications';
import Constants from 'expo-constants';
import * as Device from 'expo-device';
import { Platform } from 'react-native';
import type { RealtimeEvent } from '@scansign/shared';

Notifications.setNotificationHandler({
  handleNotification: async () => ({
    shouldShowBanner: true,
    shouldShowList: true,
    shouldPlaySound: true,
    shouldSetBadge: false,
  }),
});

/** Placeholder written by app.json until `eas init` replaces it. */
const PLACEHOLDER_PROJECT_ID = '00000000-0000-0000-0000-000000000000';

export interface PushRegistration {
  token: string | null;
  /** Why there is no token, for the console to show instead of staying silent. */
  reason: 'ok' | 'simulator' | 'denied' | 'no-project-id' | 'unsupported' | 'failed';
}

/**
 * Ask for notification permission and, where possible, a remote push token.
 *
 * Two things routinely make a remote token impossible, and both used to fail
 * silently — the console simply recorded "skipped" for every notification and
 * nobody could tell why:
 *
 *  - **Expo Go on iOS.** Since SDK 53 it cannot receive remote push at all. A
 *    development build is required.
 *  - **No EAS project id.** app.json ships a placeholder until `eas init` is
 *    run, and Expo cannot mint a token without a real one.
 *
 * Permission is still requested in both cases, because local notifications
 * work regardless — and that is what carries the product until a development
 * build exists. The reason is returned so it can be surfaced rather than
 * swallowed.
 */
export const registerForPushNotifications = async (): Promise<PushRegistration> => {
  if (!Device.isDevice) return { token: null, reason: 'simulator' };

  if (Platform.OS === 'android') {
    await Notifications.setNotificationChannelAsync('default', {
      name: 'Documents à signer',
      importance: Notifications.AndroidImportance.HIGH,
      vibrationPattern: [0, 250, 250, 250],
      lightColor: '#2f5fe0',
    });
  }

  const existing = await Notifications.getPermissionsAsync();
  let status = existing.status;
  if (status !== 'granted') status = (await Notifications.requestPermissionsAsync()).status;
  if (status !== 'granted') return { token: null, reason: 'denied' };

  const projectId =
    (Constants.expoConfig?.extra?.eas as { projectId?: string } | undefined)?.projectId ??
    Constants.easConfig?.projectId;

  if (!projectId || projectId === PLACEHOLDER_PROJECT_ID) {
    return { token: null, reason: 'no-project-id' };
  }

  // Expo Go on iOS cannot hold a remote push token since SDK 53.
  if (Constants.appOwnership === 'expo' && Platform.OS === 'ios') {
    return { token: null, reason: 'unsupported' };
  }

  try {
    const token = await Notifications.getExpoPushTokenAsync({ projectId });
    return { token: token.data, reason: 'ok' };
  } catch {
    return { token: null, reason: 'failed' };
  }
};

/** Plain-language explanation of why remote push is unavailable. */
export const pushReasonLabel = (reason: PushRegistration['reason']): string | null => {
  switch (reason) {
    case 'ok':
      return null;
    case 'simulator':
      return 'Les notifications système ne fonctionnent pas sur simulateur.';
    case 'denied':
      return 'Notifications refusées. Activez-les dans Réglages > Scan&Sign.';
    case 'no-project-id':
      return 'Notifications à distance non configurées (lancez « eas init »). Les alertes fonctionnent tant que l’application est ouverte.';
    case 'unsupported':
      return 'Expo Go ne reçoit pas les notifications à distance. Les alertes fonctionnent tant que l’application est ouverte.';
    case 'failed':
      return 'Le jeton de notification n’a pas pu être obtenu.';
  }
};

/**
 * Raise a notification from the device itself.
 *
 * This is what makes alerts work today: the app holds a live socket, so when
 * the console sends a folder the device already knows — it does not need the
 * push service to tell it. A local notification fires immediately, banner and
 * sound included, with no EAS project and no development build.
 *
 * Its one limit is honest and worth stating: a local notification can only be
 * raised by a running app. Once iOS has killed the process, only remote push
 * reaches the phone, and that needs a development build.
 */
export const notifyLocally = async (
  title: string,
  body: string,
  data: Record<string, unknown> = {},
): Promise<void> => {
  try {
    await Notifications.scheduleNotificationAsync({
      content: { title, body, sound: 'default', data },
      // null = deliver now.
      trigger: null,
    });
  } catch {
    // A notification that cannot be shown must not break the flow it reports on.
  }
};

/** The alert a live event deserves, or null when it warrants none. */
export const notificationForEvent = (
  event: RealtimeEvent,
): { title: string; body: string; data: Record<string, unknown> } | null => {
  switch (event.type) {
    case 'folder.sent':
      return {
        title: 'Nouveau document à signer',
        body: `${event.name} vous attend. Ouvrez pour signer.`,
        data: { folderId: event.folderId },
      };
    case 'folder.updated':
      if (event.status === 'completed') {
        return {
          title: 'Document signé',
          body: 'Le dossier est signé et disponible dans votre espace web.',
          data: { folderId: event.folderId },
        };
      }
      if (event.status === 'error') {
        return {
          title: 'Le traitement a échoué',
          body: 'Ouvrez le dossier pour voir ce qui bloque et réessayer.',
          data: { folderId: event.folderId },
        };
      }
      // Delivered, in progress, processing: the signer is already looking.
      return null;
    default:
      return null;
  }
};
