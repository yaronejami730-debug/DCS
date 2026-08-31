import { Pressable, StyleSheet, Text, View } from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { WebView } from 'react-native-webview';
import { ZONE_TYPE_LABEL } from '@scansign/shared';
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

      {preview?.signed && (
        <View style={styles.signedBanner}>
          <Text style={styles.signedText}>Document signé — signature et tampon appliqués</Text>
        </View>
      )}

      {preview?.annotated && (
        <View style={styles.legend}>
          {(
            [
              ['signature', theme.color.brand],
              ['stamp', theme.color.success],
              ['mention', theme.color.warning],
            ] as const
          )
            .filter(([mark]) => (preview.zones[mark] ?? 0) > 0)
            .map(([mark, colour]) => (
              <View key={mark} style={styles.legendItem}>
                <View style={[styles.legendSwatch, { borderColor: colour }]} />
                <Text style={styles.legendText}>
                  {ZONE_TYPE_LABEL[mark]}
                  {preview.zones[mark] > 1 ? ` ×${preview.zones[mark]}` : ''}
                </Text>
              </View>
            ))}
          <Text style={styles.legendHint}>Emplacements prévus</Text>
        </View>
      )}

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
  legend: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 14,
    paddingHorizontal: 20,
    paddingBottom: 10,
  },
  legendItem: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  legendSwatch: {
    width: 14,
    height: 11,
    borderWidth: 1.5,
    borderStyle: 'dashed',
    borderRadius: 2,
  },
  legendText: { fontSize: 12.5, color: theme.color.text, fontWeight: '600' },
  legendHint: { marginLeft: 'auto', fontSize: 11.5, color: theme.color.muted },
  signedBanner: {
    marginHorizontal: 20,
    marginBottom: 10,
    backgroundColor: theme.color.successSoft,
    borderRadius: theme.radius.sm,
    paddingHorizontal: 12,
    paddingVertical: 8,
  },
  signedText: { color: theme.color.success, fontSize: 13, fontWeight: '600' },
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
