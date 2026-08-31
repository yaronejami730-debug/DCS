import { useEffect } from 'react';
import { Stack, useRouter, useSegments } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import * as Notifications from 'expo-notifications';
import { AuthProvider, useAuth } from '../src/lib/auth';
import { Loading } from '../src/components/ui';

const queryClient = new QueryClient({
  defaultOptions: { queries: { retry: 1, staleTime: 5_000 } },
});

/**
 * Routing gate. Three states, in order:
 *   not signed in            -> /login
 *   signed in, no device yet -> /setup-device
 *   ready                    -> the app
 */
const Gate = () => {
  const { ready, session, deviceId } = useAuth();
  const segments = useSegments();
  const router = useRouter();

  useEffect(() => {
    if (!ready) return;
    const current = segments[0];

    if (!session) {
      if (current !== 'login') router.replace('/login');
      return;
    }
    if (!deviceId) {
      if (current !== 'setup-device') router.replace('/setup-device');
      return;
    }
    if (current === 'login' || current === 'setup-device' || current === undefined) {
      router.replace('/(app)');
    }
  }, [ready, session, deviceId, segments, router]);

  // Tapping a push notification opens the folder it refers to.
  useEffect(() => {
    const subscription = Notifications.addNotificationResponseReceivedListener((response) => {
      const folderId = response.notification.request.content.data?.folderId;
      if (typeof folderId === 'string') router.push(`/(app)/folder/${folderId}`);
    });
    return () => subscription.remove();
  }, [router]);

  if (!ready) return <Loading />;

  return (
    <Stack screenOptions={{ headerShown: false, contentStyle: { backgroundColor: '#f5f7fa' } }} />
  );
};

export default function RootLayout() {
  return (
    <SafeAreaProvider>
      <QueryClientProvider client={queryClient}>
        <AuthProvider>
          <StatusBar style="dark" />
          <Gate />
        </AuthProvider>
      </QueryClientProvider>
    </SafeAreaProvider>
  );
}
