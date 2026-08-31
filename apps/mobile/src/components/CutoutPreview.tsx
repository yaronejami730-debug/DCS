import { useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native';
import { Image } from 'expo-image';
import type { NormalizedRect, ZoneType } from '@scansign/shared';
import { usePreviewCutout } from '../lib/queries';
import { theme } from '../lib/theme';

/**
 * Shows what the extraction engine actually produces for the framed region —
 * the transparent cutout that will be stamped onto the contract.
 *
 * This is the one part of the pipeline the signer cannot judge from the photo:
 * a pale stamp or a shadow across the paper looks fine in the viewfinder and
 * comes out empty. Seeing the result while the box can still be widened, or the
 * photo retaken, is the difference between fixing it now and finding it in the
 * signed document.
 *
 * The request is debounced and only fires when asked for, because each one runs
 * the real crop-and-extract pipeline.
 */
export const CutoutPreview = ({
  sessionId,
  mark,
  region,
  enabled,
}: {
  sessionId: string | null;
  mark: ZoneType;
  region: NormalizedRect | null;
  /** False while the session is still uploading. */
  enabled: boolean;
}) => {
  const preview = usePreviewCutout();
  const [dataUrl, setDataUrl] = useState<string | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  const [stale, setStale] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const latest = useRef(0);

  const run = () => {
    if (!sessionId || !region || !enabled) return;
    const attempt = ++latest.current;
    setFailed(null);
    setStale(false);
    preview.mutate(
      { sessionId, mark, region },
      {
        onSuccess: (result) => {
          // A slow request must not overwrite a newer one.
          if (attempt === latest.current) setDataUrl(result.dataUrl);
        },
        onError: (error) => {
          if (attempt !== latest.current) return;
          setDataUrl(null);
          setFailed(
            error instanceof Error && /encre/i.test(error.message)
              ? "Aucune trace d'encre détectée dans ce cadre."
              : 'Aperçu indisponible.',
          );
        },
      },
    );
  };

  // Mark the current preview stale as soon as the box moves, so the signer is
  // never looking at a cutout of a region they have already changed.
  useEffect(() => {
    if (!dataUrl) return;
    setStale(true);
    if (timer.current) clearTimeout(timer.current);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [region?.x, region?.y, region?.width, region?.height]);

  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );

  return (
    <View style={styles.container}>
      <View style={styles.header}>
        <Text style={styles.label}>Aperçu du détourage</Text>
        <Pressable onPress={run} disabled={!enabled || !region || preview.isPending} hitSlop={8}>
          <Text
            style={[
              styles.action,
              (!enabled || !region || preview.isPending) && styles.actionDisabled,
            ]}
          >
            {dataUrl ? 'Actualiser' : 'Voir le résultat'}
          </Text>
        </Pressable>
      </View>

      <View style={styles.canvas}>
        {preview.isPending ? (
          <View style={styles.centre}>
            <ActivityIndicator color={theme.color.brand} />
            <Text style={styles.hint}>Détourage en cours…</Text>
          </View>
        ) : dataUrl ? (
          <>
            <Image source={{ uri: dataUrl }} style={styles.image} contentFit="contain" />
            {stale && (
              <View style={styles.staleBadge}>
                <Text style={styles.staleText}>Cadre modifié — actualisez</Text>
              </View>
            )}
          </>
        ) : failed ? (
          <View style={styles.centre}>
            <Text style={styles.failed}>{failed}</Text>
            <Text style={styles.hint}>Élargissez le cadre ou reprenez la photo.</Text>
          </View>
        ) : (
          <View style={styles.centre}>
            <Text style={styles.hint}>
              {enabled
                ? 'Vérifiez ce qui sera réellement apposé sur le document.'
                : 'Envoi de la photo en cours…'}
            </Text>
          </View>
        )}
      </View>
    </View>
  );
};

/** Checkerboard, so transparency is visible rather than guessed at. */
const styles = StyleSheet.create({
  container: { marginTop: 16 },
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
  canvas: {
    marginTop: 8,
    minHeight: 96,
    borderRadius: theme.radius.md,
    borderWidth: 1,
    borderColor: theme.color.border,
    backgroundColor: '#f0f2f5',
    overflow: 'hidden',
    justifyContent: 'center',
  },
  image: { width: '100%', height: 120 },
  centre: { alignItems: 'center', justifyContent: 'center', paddingVertical: 22, gap: 4 },
  hint: { fontSize: 12.5, color: theme.color.muted, textAlign: 'center', paddingHorizontal: 16 },
  failed: { fontSize: 13.5, color: theme.color.danger, fontWeight: '600', textAlign: 'center' },
  staleBadge: {
    position: 'absolute',
    bottom: 6,
    alignSelf: 'center',
    backgroundColor: 'rgba(19,29,51,0.8)',
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: 999,
  },
  staleText: { color: '#fff', fontSize: 11.5, fontWeight: '600' },
});
