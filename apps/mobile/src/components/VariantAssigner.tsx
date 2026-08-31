import { useMemo, useState } from 'react';
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { Image } from 'expo-image';
import { ZONE_TYPE_LABEL, type GeneratedVariant, type ZoneType } from '@scansign/shared';
import type { SessionDocument } from '../lib/queries';
import { hapticSelect } from '../lib/haptics';
import { theme } from '../lib/theme';

/**
 * Hand out one variant of a handwritten mark to each document.
 *
 * A person signing four contracts signs four times, and no two come out the
 * same. So the signer generates one variant per document and decides which goes
 * where, rather than the backend choosing silently: the image they pick is the
 * image that gets stamped, because a variant is derived from its index alone.
 *
 * With a single document there is nothing to decide, so the picker collapses to
 * a plain preview.
 */
export const VariantAssigner = ({
  mark,
  variants,
  documents,
  assignment,
  onAssign,
  onGenerate,
  generating,
  canGenerate,
}: {
  mark: ZoneType;
  variants: GeneratedVariant[];
  documents: SessionDocument[];
  /** documentId -> variant index */
  assignment: Record<string, number>;
  onAssign: (documentId: string, index: number) => void;
  onGenerate: () => void;
  generating: boolean;
  canGenerate: boolean;
}) => {
  const [openDocument, setOpenDocument] = useState<string | null>(null);

  const label = ZONE_TYPE_LABEL[mark].toLowerCase();
  const assignedCount = useMemo(
    () => documents.filter((d) => assignment[d.id] !== undefined).length,
    [documents, assignment],
  );

  return (
    <View style={styles.container}>
      <View style={styles.header}>
        <Text style={styles.label}>Variantes de {label}</Text>
        <Pressable onPress={onGenerate} disabled={!canGenerate || generating} hitSlop={8}>
          <Text style={[styles.action, (!canGenerate || generating) && styles.actionDisabled]}>
            {variants.length > 0 ? 'Régénérer' : 'Générer'}
          </Text>
        </Pressable>
      </View>

      <Text style={styles.explain}>
        {documents.length > 1
          ? `Une variante par document, comme si vous signiez chacun à la main. Choisissez celle de chaque document.`
          : `Une variante sera appliquée au document.`}
      </Text>

      {generating ? (
        <View style={styles.centre}>
          <ActivityIndicator color={theme.color.brand} />
          <Text style={styles.hint}>Génération de {documents.length || 1} variante(s)…</Text>
        </View>
      ) : variants.length === 0 ? (
        <View style={styles.centre}>
          <Text style={styles.hint}>
            {canGenerate
              ? 'Générez les variantes pour les répartir entre vos documents.'
              : 'Cadrez la marque puis générez les variantes.'}
          </Text>
        </View>
      ) : (
        <View style={styles.list}>
          {documents.map((doc, position) => {
            const chosen = assignment[doc.id] ?? position % variants.length;
            const variant = variants[chosen] ?? variants[0]!;
            const open = openDocument === doc.id;

            return (
              <View key={doc.id} style={styles.row}>
                <Pressable
                  style={styles.rowHead}
                  onPress={() => {
                    hapticSelect();
                    setOpenDocument(open ? null : doc.id);
                  }}
                >
                  <View style={styles.thumb}>
                    <Image
                      source={{ uri: variant.dataUrl }}
                      style={styles.thumbImage}
                      contentFit="contain"
                    />
                  </View>
                  <View style={{ flex: 1 }}>
                    <Text style={styles.docName} numberOfLines={1}>
                      {doc.filename}
                    </Text>
                    <Text style={styles.docMeta}>
                      Variante {chosen + 1} · {doc.pageCount} page(s)
                    </Text>
                  </View>
                  <Text style={styles.chevron}>{open ? '▲' : '▼'}</Text>
                </Pressable>

                {open && (
                  <ScrollView horizontal showsHorizontalScrollIndicator={false} style={styles.strip}>
                    {variants.map((candidate) => {
                      const selected = candidate.index === chosen;
                      return (
                        <Pressable
                          key={candidate.index}
                          onPress={() => {
                            hapticSelect();
                            onAssign(doc.id, candidate.index);
                            setOpenDocument(null);
                          }}
                          style={[styles.tile, selected && styles.tileSelected]}
                        >
                          <Image
                            source={{ uri: candidate.dataUrl }}
                            style={styles.tileImage}
                            contentFit="contain"
                          />
                          <Text style={[styles.tileLabel, selected && styles.tileLabelSelected]}>
                            Variante {candidate.index + 1}
                          </Text>
                        </Pressable>
                      );
                    })}
                  </ScrollView>
                )}
              </View>
            );
          })}

          {documents.length > 1 && (
            <Text style={styles.summary}>
              {assignedCount} document(s) sur {documents.length} choisis manuellement — les autres
              gardent la variante proposée.
            </Text>
          )}
        </View>
      )}
    </View>
  );
};

const styles = StyleSheet.create({
  container: { marginTop: 18 },
  header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  label: {
    fontSize: 12,
    fontWeight: '700',
    color: theme.color.muted,
    textTransform: 'uppercase',
    letterSpacing: 0.5,
  },
  action: { fontSize: 13.5, fontWeight: '600', color: theme.color.brand },
  actionDisabled: { color: theme.color.border },
  explain: { fontSize: 12.5, color: theme.color.muted, marginTop: 6, lineHeight: 18 },
  centre: { paddingVertical: 20, alignItems: 'center', gap: 6 },
  hint: { fontSize: 12.5, color: theme.color.muted, textAlign: 'center', paddingHorizontal: 12 },
  list: { marginTop: 10, gap: 8 },
  row: {
    borderRadius: theme.radius.md,
    borderWidth: 1,
    borderColor: theme.color.border,
    backgroundColor: theme.color.surface,
    overflow: 'hidden',
  },
  rowHead: { flexDirection: 'row', alignItems: 'center', gap: 10, padding: 10 },
  thumb: {
    width: 74,
    height: 40,
    borderRadius: theme.radius.sm,
    backgroundColor: '#f0f2f5',
    overflow: 'hidden',
  },
  thumbImage: { width: '100%', height: '100%' },
  docName: { fontSize: 14, fontWeight: '600', color: theme.color.text },
  docMeta: { fontSize: 12, color: theme.color.muted, marginTop: 2 },
  chevron: { fontSize: 11, color: theme.color.muted },
  strip: { paddingHorizontal: 10, paddingBottom: 10 },
  tile: {
    width: 108,
    marginRight: 8,
    padding: 6,
    borderRadius: theme.radius.sm,
    borderWidth: 2,
    borderColor: theme.color.border,
    backgroundColor: '#f7f8fa',
    alignItems: 'center',
  },
  tileSelected: { borderColor: theme.color.brand, backgroundColor: theme.color.brandSoft },
  tileImage: { width: 94, height: 48 },
  tileLabel: { marginTop: 4, fontSize: 11, color: theme.color.muted, fontWeight: '600' },
  tileLabelSelected: { color: theme.color.brand },
  summary: { fontSize: 11.5, color: theme.color.muted, marginTop: 4, lineHeight: 16 },
});
