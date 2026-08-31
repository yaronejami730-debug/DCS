import { env } from '../env.js';
import { db } from '../lib/supabase.js';

const EXPO_PUSH_URL = 'https://exp.host/--/api/v2/push/send';

export interface PushPayload {
  ownerId: string;
  deviceId: string | null;
  folderId: string | null;
  title: string;
  body: string;
  data?: Record<string, unknown>;
}

/**
 * Send an Expo push notification and record the attempt.
 *
 * Never throws: a document that is correctly delivered must not be marked as
 * failed because a push token went stale. Failures land in `notifications`
 * with status 'failed' so the console can show them.
 */
export const sendPush = async (payload: PushPayload): Promise<void> => {
  const { data: notification } = await db
    .from('notifications')
    .insert({
      owner_id: payload.ownerId,
      device_id: payload.deviceId,
      folder_id: payload.folderId,
      title: payload.title,
      body: payload.body,
      status: 'pending',
    })
    .select('id')
    .single<{ id: string }>();

  const finish = async (status: string, extra: Record<string, unknown> = {}) => {
    if (!notification) return;
    await db.from('notifications').update({ status, ...extra }).eq('id', notification.id);
  };

  if (!payload.deviceId) {
    await finish('skipped', { error: 'Aucun appareil destinataire.' });
    return;
  }

  const { data: device } = await db
    .from('devices')
    .select('push_token')
    .eq('id', payload.deviceId)
    .maybeSingle<{ push_token: string | null }>();

  if (!device?.push_token) {
    // Not an error: the app still polls, so the folder arrives either way.
    await finish('skipped', {
      error: "L'appareil n'a pas encore autorisé les notifications.",
    });
    return;
  }

  try {
    const res = await fetch(EXPO_PUSH_URL, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json',
        ...(env.EXPO_ACCESS_TOKEN ? { authorization: `Bearer ${env.EXPO_ACCESS_TOKEN}` } : {}),
      },
      body: JSON.stringify({
        to: device.push_token,
        title: payload.title,
        body: payload.body,
        sound: 'default',
        priority: 'high',
        data: { ...payload.data, folderId: payload.folderId },
      }),
    });

    const json = (await res.json().catch(() => null)) as
      | { data?: { status?: string; id?: string; message?: string } }
      | null;

    if (!res.ok || json?.data?.status === 'error') {
      await finish('failed', { error: json?.data?.message ?? `HTTP ${res.status}` });
      return;
    }
    await finish('sent', { ticket_id: json?.data?.id ?? null });
  } catch (error) {
    await finish('failed', { error: String(error) });
  }
};
