import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import type { AuthSession } from '@scansign/shared';
import { api, loadSession, saveSession, setSessionLostHandler } from './api';

interface AuthContextValue {
  session: AuthSession | null;
  signIn: (email: string, password: string) => Promise<void>;
  signUp: (email: string, password: string, displayName: string) => Promise<void>;
  signOut: () => void;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export const AuthProvider = ({ children }: { children: ReactNode }) => {
  const [session, setSession] = useState<AuthSession | null>(() => loadSession());

  useEffect(() => {
    setSessionLostHandler(() => setSession(null));
    return () => setSessionLostHandler(null);
  }, []);

  const signIn = useCallback(async (email: string, password: string) => {
    const next = await api<AuthSession>('/auth/login', {
      method: 'POST',
      json: { email, password },
      auth: false,
    });
    saveSession(next);
    setSession(next);
  }, []);

  const signUp = useCallback(
    async (email: string, password: string, displayName: string) => {
      const next = await api<AuthSession>('/auth/signup', {
        method: 'POST',
        json: { email, password, displayName },
        auth: false,
      });
      saveSession(next);
      setSession(next);
    },
    [],
  );

  const signOut = useCallback(() => {
    saveSession(null);
    setSession(null);
  }, []);

  const value = useMemo(
    () => ({ session, signIn, signUp, signOut }),
    [session, signIn, signUp, signOut],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
};

export const useAuth = (): AuthContextValue => {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used inside <AuthProvider>');
  return ctx;
};
