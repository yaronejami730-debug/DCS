import { useCallback, useState } from 'react';
import { FlatList, Pressable, RefreshControl, StyleSheet, Text, View } from 'react-native';
import { useRouter } from 'expo-router';
import type { Folder } from '@scansign/shared';
import { useAuth } from '../../src/lib/auth';
import { useMyFolders } from '../../src/lib/queries';
import { useRealtime } from '../../src/lib/realtime';
import { Button, FolderPill, Loading, Screen, Subtitle, Title } from '../../src/components/ui';
import { theme } from '../../src/lib/theme';

const remaining = (folder: Folder): number =>
  (folder.documents ?? []).filter((d) => d.status !== 'completed').length;

export default function HomeScreen() {
  const router = useRouter();
  const { deviceId, deviceName, signOut, session, pushNotice } = useAuth();
  const { data, isLoading, refetch } = useMyFolders(deviceId);
  // A folder sent from the console lands here on its own, pushed over the
  // socket. Nothing polls, so the list never reloads under the signer.
  const { connected } = useRealtime(Boolean(session && deviceId));

  // The spinner is shown only for a refresh the user asked for. A background
  // refetch triggered by a live update stays invisible.
  const [pulling, setPulling] = useState(false);
  const pullToRefresh = useCallback(async () => {
    setPulling(true);
    try {
      await refetch();
    } finally {
      setPulling(false);
    }
  }, [refetch]);

  const folders = data?.items ?? [];
  const waiting = folders.filter((f) => f.status !== 'completed');
  const done = folders.filter((f) => f.status === 'completed');

  if (isLoading) return <Loading label="Chargement…" />;

  return (
    <Screen>
      <FlatList
        contentContainerStyle={styles.content}
        data={waiting}
        keyExtractor={(item) => item.id}
        refreshControl={<RefreshControl refreshing={pulling} onRefresh={() => void pullToRefresh()} />}
        ListHeaderComponent={
          <View style={styles.header}>
            <Title>Bonjour{session?.user.displayName ? ` ${session.user.displayName}` : ''}</Title>
            <Subtitle>
              {waiting.length === 0
                ? 'Aucun document en attente.'
                : `${waiting.length} dossier${waiting.length > 1 ? 's' : ''} en attente de signature.`}
            </Subtitle>
            {pushNotice && (
              <View style={styles.notice}>
                <Text style={styles.noticeText}>{pushNotice}</Text>
              </View>
            )}
            <View style={styles.deviceRow}>
              <View
                style={[
                  styles.liveDot,
                  { backgroundColor: connected ? theme.color.success : theme.color.border },
                ]}
              />
              <Text style={styles.device}>
                {deviceName ?? 'Cet appareil'}
                {connected ? ' · en direct' : ''}
              </Text>
            </View>
          </View>
        }
        renderItem={({ item }) => (
          <Pressable
            style={({ pressed }) => [styles.row, pressed && styles.rowPressed]}
            onPress={() => router.push(`/(app)/folder/${item.id}`)}
          >
            <View style={{ flex: 1 }}>
              <Text style={styles.rowTitle}>{item.name}</Text>
              <Text style={styles.rowMeta}>
                {item.documents?.length ?? 0} document
                {(item.documents?.length ?? 0) > 1 ? 's' : ''}
                {remaining(item) > 0 ? ` · ${remaining(item)} à signer` : ''}
              </Text>
            </View>
            <FolderPill status={item.status} />
          </Pressable>
        )}
        ListEmptyComponent={
          <View style={styles.empty}>
            <Text style={styles.emptyTitle}>Rien à signer</Text>
            <Text style={styles.emptyText}>
              Vous recevrez une notification dès qu’un document vous sera envoyé depuis votre
              espace web.
            </Text>
          </View>
        }
        ListFooterComponent={
          <View style={styles.footer}>
            {done.length > 0 && (
              <>
                <Text style={styles.sectionTitle}>Terminés</Text>
                {done.slice(0, 10).map((folder) => (
                  <Pressable
                    key={folder.id}
                    style={styles.row}
                    onPress={() => router.push(`/(app)/folder/${folder.id}`)}
                  >
                    <View style={{ flex: 1 }}>
                      <Text style={styles.rowTitle}>{folder.name}</Text>
                      <Text style={styles.rowMeta}>{folder.documents?.length ?? 0} document(s)</Text>
                    </View>
                    <FolderPill status={folder.status} />
                  </Pressable>
                ))}
              </>
            )}
            <Button
              label="Se déconnecter"
              variant="ghost"
              onPress={() => void signOut()}
              style={{ marginTop: 24 }}
            />
          </View>
        }
      />
    </Screen>
  );
}

const styles = StyleSheet.create({
  content: { padding: 20, paddingBottom: 40 },
  header: { marginBottom: 20 },
  notice: {
    marginTop: 12,
    backgroundColor: theme.color.warningSoft,
    borderRadius: theme.radius.sm,
    paddingHorizontal: 12,
    paddingVertical: 8,
  },
  noticeText: { color: theme.color.warning, fontSize: 12.5, lineHeight: 17 },
  deviceRow: { flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: 10 },
  liveDot: { width: 7, height: 7, borderRadius: 4 },
  device: { fontSize: 13, color: theme.color.muted },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    backgroundColor: theme.color.surface,
    borderRadius: theme.radius.md,
    borderWidth: 1,
    borderColor: theme.color.border,
    padding: 16,
    marginBottom: 10,
  },
  rowPressed: { opacity: 0.7 },
  rowTitle: { fontSize: 16, fontWeight: '600', color: theme.color.text },
  rowMeta: { fontSize: 13, color: theme.color.muted, marginTop: 3 },
  empty: { alignItems: 'center', paddingVertical: 60, gap: 8 },
  emptyTitle: { fontSize: 16, fontWeight: '600', color: theme.color.text },
  emptyText: { fontSize: 14, color: theme.color.muted, textAlign: 'center', paddingHorizontal: 24 },
  footer: { marginTop: 12 },
  sectionTitle: {
    fontSize: 13,
    fontWeight: '700',
    color: theme.color.muted,
    textTransform: 'uppercase',
    letterSpacing: 0.5,
    marginTop: 20,
    marginBottom: 10,
  },
});
