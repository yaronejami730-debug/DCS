import { useCallback, useMemo, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import {
  HANDWRITTEN_MARKS,
  ZONE_TYPE_LABEL,
  type GeneratedVariant,
  type MarkAssignments,
  type NormalizedRect,
  type ZoneType,
} from '@scansign/shared';
import { RegionSelector } from '../../../src/components/RegionSelector';
import { CutoutPreview } from '../../../src/components/CutoutPreview';
import { VariantAssigner } from '../../../src/components/VariantAssigner';
import {
  useGenerateVariants,
  useSessionDocuments,
  useSubmitRegions,
} from '../../../src/lib/queries';
import { ApiRequestError } from '../../../src/lib/api';
import { hapticError, hapticSuccess } from '../../../src/lib/haptics';
import { Button, ErrorBanner, Screen, Subtitle, Title } from '../../../src/components/ui';
import { theme } from '../../../src/lib/theme';

const TINT: Record<ZoneType, string> = {
  signature: theme.color.brand,
  stamp: theme.color.success,
  mention: theme.color.warning,
  signature_stamp: '#8b3fbf',
};

/**
 * Frame one mark, in the per-photo-per-mark flow.
 *
 * Using the whole frame blindly was tempting but worse in practice: a photo
 * taken at arm's length catches the edge of the sheet, a shadow, or the mark
 * next to it, and the extraction engine then has more than the ink to deal
 * with. A quick adjustment, with the cutout visible, is a few seconds well
 * spent.
 */
export default function FrameMarkScreen() {
  const params = useLocalSearchParams<{
    mark: ZoneType;
    sessionId: string;
    folderId: string;
    photoUrl: string;
    photoWidth: string;
    photoHeight: string;
    suggestion?: string;
    remaining?: string;
    collected?: string;
    /** Variant choices made for earlier marks, carried through the flow. */
    collectedAssignments?: string;
  }>();
  const router = useRouter();
  const submit = useSubmitRegions();
  const generate = useGenerateVariants();

  const suggestion = useMemo((): NormalizedRect | null => {
    try {
      return params.suggestion ? (JSON.parse(params.suggestion) as NormalizedRect | null) : null;
    } catch {
      return null;
    }
  }, [params.suggestion]);

  const remaining = useMemo((): ZoneType[] => {
    try {
      return params.remaining ? (JSON.parse(params.remaining) as ZoneType[]) : [];
    } catch {
      return [];
    }
  }, [params.remaining]);

  const collected = useMemo((): Partial<Record<ZoneType, NormalizedRect>> => {
    try {
      return params.collected
        ? (JSON.parse(params.collected) as Partial<Record<ZoneType, NormalizedRect>>)
        : {};
    } catch {
      return {};
    }
  }, [params.collected]);

  const collectedAssignments = useMemo((): MarkAssignments => {
    try {
      return params.collectedAssignments
        ? (JSON.parse(params.collectedAssignments) as MarkAssignments)
        : {};
    } catch {
      return {};
    }
  }, [params.collectedAssignments]);

  const mark = params.mark ?? 'signature';
  const [region, setRegion] = useState<NormalizedRect | null>(null);
  const [variants, setVariants] = useState<GeneratedVariant[]>([]);
  const [assignment, setAssignment] = useState<Record<string, number>>({});
  const [scrollEnabled, setScrollEnabled] = useState(true);
  const [resetToken, setResetToken] = useState(0);
  const [error, setError] = useState<string | null>(null);

  // The whole frame is a sane default here: the photo was taken for this mark
  // alone. Detection narrows it when it found the ink.
  const startingRect = suggestion ?? { x: 0.04, y: 0.04, width: 0.92, height: 0.92 };

  const handleChange = useCallback((rect: NormalizedRect) => {
    setRegion(rect);
    // The framed area changed, so any variants of it are stale.
    setVariants([]);
  }, []);

  const { data: documents } = useSessionDocuments(params.sessionId ?? null);
  const documentList = documents?.items ?? [];
  const varies = HANDWRITTEN_MARKS.includes(mark);

  const generateVariants = async () => {
    if (!region) return;
    setError(null);
    try {
      const result = await generate.mutateAsync({
        sessionId: params.sessionId,
        mark,
        region,
        count: Math.max(1, Math.min(documentList.length || 1, 24)),
      });
      setVariants(result.variants);
    } catch (e) {
      setError(e instanceof ApiRequestError ? e.message : 'Impossible de générer les variantes.');
    }
  };

  const confirm = async () => {
    if (!region) return;
    const next = { ...collected, [mark]: region };

    if (remaining.length > 0) {
      hapticSuccess();
      // Back to the camera for the next mark, carrying what is confirmed.
      router.replace({
        pathname: '/(app)/capture/[folderId]',
        params: {
          folderId: params.folderId,
          // Carry the session, or the next mark opens a new one and this
          // mark's photo is orphaned.
          sessionId: params.sessionId,
          resumeAt: String(Object.keys(next).length),
          collected: JSON.stringify(next),
          collectedAssignments: JSON.stringify({
            ...collectedAssignments,
            ...(varies && Object.keys(assignment).length > 0 ? { [mark]: assignment } : {}),
          }),
        },
      });
      return;
    }

    setError(null);
    try {
      const assignments: MarkAssignments = {
        ...(collectedAssignments as MarkAssignments),
        ...(varies && Object.keys(assignment).length > 0
          ? { [mark]: assignment }
          : {}),
      };
      await submit.mutateAsync({
        sessionId: params.sessionId,
        regions: {
          signature: next.signature ?? null,
          stamp: next.stamp ?? null,
          mention: next.mention ?? null,
          signature_stamp: next.signature_stamp ?? null,
          assignments,
        },
      });
      hapticSuccess();
      router.replace(`/(app)/processing/${params.sessionId}`);
    } catch (e) {
      hapticError();
      setError(e instanceof ApiRequestError ? e.message : 'Envoi impossible.');
    }
  };

  return (
    <Screen edges={['top']}>
      <ScrollView contentContainerStyle={styles.content} scrollEnabled={scrollEnabled}>
        <Pressable onPress={() => router.back()} hitSlop={12}>
          <Text style={styles.back}>‹ Reprendre la photo</Text>
        </Pressable>

        <Title>Cadrez : {ZONE_TYPE_LABEL[mark].toLowerCase()}</Title>
        <Subtitle>
          Ajustez le cadre au plus près de l’encre, puis vérifiez l’aperçu du détourage.
        </Subtitle>

        {suggestion && (
          <View style={styles.detected}>
            <Text style={styles.detectedText}>
              Cadre placé automatiquement — vérifiez et ajustez si besoin.
            </Text>
          </View>
        )}

        <View style={{ marginTop: 18 }}>
          <RegionSelector
            key={`${mark}-${resetToken}`}
            photoUrl={params.photoUrl}
            photoWidth={Number(params.photoWidth) || 1}
            photoHeight={Number(params.photoHeight) || 1}
            value={region}
            defaultRect={startingRect}
            onChange={handleChange}
            onInteractionChange={(active) => setScrollEnabled(!active)}
            tint={TINT[mark]}
          />
        </View>

        <CutoutPreview sessionId={params.sessionId} mark={mark} region={region} enabled />

        {varies && (
          <VariantAssigner
            mark={mark}
            variants={variants}
            documents={documentList}
            assignment={assignment}
            onAssign={(documentId, index) =>
              setAssignment((prev) => ({ ...prev, [documentId]: index }))
            }
            onGenerate={() => void generateVariants()}
            generating={generate.isPending}
            canGenerate={Boolean(region)}
          />
        )}

        {error && <ErrorBanner message={error} />}

        <View style={styles.actions}>
          <Button
            label={remaining.length > 0 ? 'Élément suivant' : 'Valider'}
            onPress={() => void confirm()}
            loading={submit.isPending}
            disabled={!region}
          />
          <Button
            label="Réinitialiser le cadre"
            variant="ghost"
            onPress={() => {
              setRegion(null);
              setResetToken((n) => n + 1);
            }}
            style={{ marginTop: 4 }}
          />
        </View>
      </ScrollView>
    </Screen>
  );
}

const styles = StyleSheet.create({
  content: { padding: 20, paddingBottom: 44 },
  back: { color: theme.color.brand, fontSize: 16, fontWeight: '600', marginBottom: 14 },
  actions: { marginTop: 22 },
  detected: {
    marginTop: 10,
    backgroundColor: theme.color.brandSoft,
    borderRadius: theme.radius.sm,
    paddingHorizontal: 12,
    paddingVertical: 8,
  },
  detectedText: { color: theme.color.brand, fontSize: 13, fontWeight: '600' },
});
