import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import type { AuthSession, Device } from '@scansign/shared';
import { api, loadSession, saveSession, setSessionLostHandler } from './api';
import {
  forgetDevice,
  getStoredDeviceId,
  getStoredDeviceName,
  pingDevice,
  registerDevice,
} from './device';
import { registerForPushNotifications } from './notifications';

interface AuthContextValue {
  ready: boolean;
  session: AuthSession | null;
  deviceId: string | null;
  deviceName: string | null;
  signIn: (email: string, password: string) => Promise<void>;
  signOut: () => Promise<void>;
  enrollDevice: (name: string) => Promise<Device>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

const PING_INTERVAL_MS = 60_000;

export const AuthProvider = ({ children }: { children: ReactNode }) => {
  const [ready, setReady] = useState(false);
  const [session, setSession] = useState<AuthSession | null>(null);
  const [deviceId, setDeviceId] = useState<string | null>(null);
  const [deviceName, setDeviceName] = useState<string | null>(null);

  useEffect(() => {
    const boot = async () => {
      setSession(await loadSession());
      setDeviceId(await getStoredDeviceId());
      setDeviceName(await getStoredDeviceName());
      setReady(true);
    };
    void boot();
  }, []);

  useEffect(() => {
    setSessionLostHandler(() => {
      setSession(null);
    });
    return () => setSessionLostHandler(null);
  }, []);

  // Heartbeat, so the console can show this phone as online.
  useEffect(() => {
    if (!session || !deviceId) return;
    void pingDevice(deviceId);
    const timer = setInterval(() => void pingDevice(deviceId), PING_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [session, deviceId]);

  const signIn = useCallback(async (email: string, password: string) => {
    const next = await api<AuthSession>('/auth/login', {
      method: 'POST',
      json: { email, password },
      auth: false,
    });
    await saveSession(next);
    setSession(next);
    setDeviceId(await getStoredDeviceId());
    setDeviceName(await getStoredDeviceName());
  }, []);

  const signOut = useCallback(async () => {
    await saveSession(null);
    await forgetDevice();
    setSession(null);
    setDeviceId(null);
    setDeviceName(null);
  }, []);

  const enrollDevice = useCallback(async (name: string) => {
    // Push permission is requested here, at the moment it makes sense to the
    // user: they have just named the phone that will receive documents.
    const pushToken = await registerForPushNotifications();
    const device = await registerDevice(name, pushToken);
    setDeviceId(device.id);
    setDeviceName(device.name);
    return device;
  }, []);

  const value = useMemo(
    () => ({ ready, session, deviceId, deviceName, signIn, signOut, enrollDevice }),
    [ready, session, deviceId, deviceName, signIn, signOut, enrollDevice],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
};

export const useAuth = (): AuthContextValue => {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used inside <AuthProvider>');
  return ctx;
};
