import { useEffect } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { ERROR_CODE_LABEL, type ErrorCode } from '@scansign/shared';
import { useAcknowledgeFolder, useFolder } from '../../../src/lib/queries';
import {
  Button,
  DocumentPill,
  ErrorBanner,
  FolderPill,
  Loading,
  Screen,
  Subtitle,
  Title,
} from '../../../src/components/ui';
import { theme } from '../../../src/lib/theme';

export default function FolderScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const router = useRouter();
  const { data: folder, isLoading } = useFolder(id);
  const acknowledge = useAcknowledgeFolder();

  // Opening the folder is what tells the console it has been received.
  useEffect(() => {
    if (folder?.status === 'pending') acknowledge.mutate(folder.id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [folder?.id, folder?.status]);

  if (isLoading || !folder) return <Loading />;

  const documents = folder.documents ?? [];
  const toSign = documents.filter((d) => d.status !== 'completed');
  const allDone = documents.length > 0 && toSign.length === 0;

  return (
    <Screen>
      <ScrollView contentContainerStyle={styles.content}>
        <Pressable onPress={() => router.back()} hitSlop={12}>
          <Text style={styles.back}>‹ Dossiers</Text>
        </Pressable>

        <View style={styles.header}>
          <Title>{folder.name}</Title>
          <Subtitle>
            {documents.length} document{documents.length > 1 ? 's' : ''}
          </Subtitle>
          <View style={{ marginTop: 10 }}>
            <FolderPill status={folder.status} />
          </View>
        </View>

        {folder.errorCode && (
          <ErrorBanner
            message={
              ERROR_CODE_LABEL[folder.errorCode as ErrorCode] ??
              folder.errorMessage ??
              'Une erreur est survenue.'
            }
          />
        )}

        <View style={styles.list}>
          {documents.map((doc) => (
            <Pressable
              key={doc.id}
              style={styles.row}
              onPress={() => router.push(`/(app)/document/${doc.id}`)}
            >
              <Text style={styles.mark}>
                {doc.status === 'completed' ? '✓' : doc.status === 'error' ? '!' : '○'}
              </Text>
              <View style={{ flex: 1 }}>
                <Text style={styles.rowTitle}>{doc.filename}</Text>
                <Text style={styles.rowMeta}>{doc.pageCount} page(s)</Text>
              </View>
              <DocumentPill status={doc.status} />
            </Pressable>
          ))}
        </View>

        {allDone ? (
          <View style={styles.doneBox}>
            <Text style={styles.doneText}>Tous les documents sont signés ✓</Text>
          </View>
        ) : (
          <Button
            label="Signer les documents"
            onPress={() => router.push(`/(app)/capture/${folder.id}`)}
            disabled={documents.length === 0 || folder.status === 'processing'}
            style={{ marginTop: 24 }}
          />
        )}

        {folder.status === 'processing' && (
          <Text style={styles.processing}>Traitement en cours…</Text>
        )}
      </ScrollView>
    </Screen>
  );
}

const styles = StyleSheet.create({
  content: { padding: 20, paddingBottom: 40 },
  back: { color: theme.color.brand, fontSize: 16, fontWeight: '600', marginBottom: 12 },
  header: { marginBottom: 20 },
  list: { gap: 10 },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    backgroundColor: theme.color.surface,
    borderRadius: theme.radius.md,
    borderWidth: 1,
    borderColor: theme.color.border,
    padding: 16,
  },
  mark: { fontSize: 16, width: 18, color: theme.color.muted, fontWeight: '700' },
  rowTitle: { fontSize: 15, fontWeight: '600', color: theme.color.text },
  rowMeta: { fontSize: 13, color: theme.color.muted, marginTop: 2 },
  doneBox: {
    marginTop: 24,
    backgroundColor: theme.color.successSoft,
    borderRadius: theme.radius.md,
    padding: 16,
    alignItems: 'center',
  },
  doneText: { color: theme.color.success, fontWeight: '600', fontSize: 15 },
  processing: { marginTop: 12, textAlign: 'center', color: theme.color.muted },
});
