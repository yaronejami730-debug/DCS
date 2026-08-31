import * as SecureStore from 'expo-secure-store';
import * as Crypto from 'expo-crypto';
import * as Device from 'expo-device';
import { Platform } from 'react-native';
import type { Device as DeviceModel, DevicePlatform } from '@scansign/shared';
import { api } from './api';

const INSTALLATION_KEY = 'scansign.installationId';
const DEVICE_KEY = 'scansign.deviceId';
const NAME_KEY = 'scansign.deviceName';

/**
 * A stable id for this install. Registering with it means relaunching the app
 * updates the existing device row instead of creating a duplicate every time.
 */
export const getInstallationId = async (): Promise<string> => {
  const existing = await SecureStore.getItemAsync(INSTALLATION_KEY);
  if (existing) return existing;
  const created = Crypto.randomUUID();
  await SecureStore.setItemAsync(INSTALLATION_KEY, created);
  return created;
};

export const getStoredDeviceId = () => SecureStore.getItemAsync(DEVICE_KEY);
export const getStoredDeviceName = () => SecureStore.getItemAsync(NAME_KEY);

export const suggestedDeviceName = (): string =>
  Device.deviceName?.trim() || `${Device.modelName ?? 'Appareil'}`;

const currentPlatform = (): DevicePlatform =>
  Platform.OS === 'ios' ? 'ios' : Platform.OS === 'android' ? 'android' : 'unknown';

export const registerDevice = async (
  name: string,
  pushToken?: string | null,
): Promise<DeviceModel> => {
  const device = await api<DeviceModel>('/devices/register', {
    method: 'POST',
    json: {
      name,
      platform: currentPlatform(),
      pushToken: pushToken ?? null,
      installationId: await getInstallationId(),
    },
  });
  await SecureStore.setItemAsync(DEVICE_KEY, device.id);
  await SecureStore.setItemAsync(NAME_KEY, device.name);
  return device;
};

export const forgetDevice = async (): Promise<void> => {
  await SecureStore.deleteItemAsync(DEVICE_KEY);
  await SecureStore.deleteItemAsync(NAME_KEY);
};

/** Heartbeat that drives the online dot in the web console. */
export const pingDevice = async (deviceId: string): Promise<void> => {
  try {
    await api(`/devices/${deviceId}/ping`, { method: 'POST' });
  } catch {
    // Offline is a normal state; the console will simply show it as offline.
  }
};
