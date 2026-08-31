import { Pressable, StyleSheet, Text, View } from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { WebView } from 'react-native-webview';
import { useDocument, useDocumentPreview } from '../../../src/lib/queries';
import { Button, DocumentPill, Loading, Screen } from '../../../src/components/ui';
import { theme } from '../../../src/lib/theme';

/**
 * Preview of the original document. iOS renders PDFs natively inside a WebView,
 * so a signed URL is all that is needed — no PDF library on the phone.
 */
export default function DocumentScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const router = useRouter();
  const { data: doc, isLoading } = useDocument(id);
  const { data: preview } = useDocumentPreview(id);

  if (isLoading || !doc) return <Loading />;

  return (
    <Screen edges={['top']}>
      <View style={styles.header}>
        <Pressable onPress={() => router.back()} hitSlop={12}>
          <Text style={styles.back}>‹ Retour</Text>
        </Pressable>
        <Text style={styles.title} numberOfLines={1}>
          {doc.filename}
        </Text>
        <DocumentPill status={doc.status} />
      </View>

      <View style={styles.viewer}>
        {preview ? (
          <WebView
            source={{ uri: preview.url }}
            style={{ flex: 1, backgroundColor: '#fff' }}
            startInLoadingState
          />
        ) : (
          <Loading label="Ouverture du document…" />
        )}
      </View>

      <View style={styles.footer}>
        {doc.status === 'completed' ? (
          <Text style={styles.done}>Ce document est signé ✓</Text>
        ) : (
          <>
            <Text style={styles.prompt}>Ce document nécessite votre signature.</Text>
            <Button
              label="Signer"
              onPress={() => router.push(`/(app)/capture/${doc.folderId}`)}
              style={{ marginTop: 12 }}
            />
          </>
        )}
      </View>
    </Screen>
  );
}

const styles = StyleSheet.create({
  header: { paddingHorizontal: 20, paddingBottom: 12, gap: 8 },
  back: { color: theme.color.brand, fontSize: 16, fontWeight: '600' },
  title: { fontSize: 18, fontWeight: '700', color: theme.color.text },
  viewer: { flex: 1, marginHorizontal: 16, borderRadius: theme.radius.md, overflow: 'hidden' },
  footer: {
    padding: 20,
    paddingBottom: 32,
    backgroundColor: theme.color.surface,
    borderTopWidth: 1,
    borderTopColor: theme.color.border,
  },
  prompt: { fontSize: 15, color: theme.color.text, textAlign: 'center' },
  done: { fontSize: 15, color: theme.color.success, fontWeight: '600', textAlign: 'center' },
});
