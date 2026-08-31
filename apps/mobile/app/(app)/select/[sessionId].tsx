import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
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
  useStartSession,
  useSubmitRegions,
} from '../../../src/lib/queries';
import { ApiRequestError } from '../../../src/lib/api';
import { hapticError, hapticSuccess } from '../../../src/lib/haptics';
import { Button, ErrorBanner, Screen, Subtitle, Title } from '../../../src/components/ui';
import { theme } from '../../../src/lib/theme';

/**
 * Frame each mark, check its cutout, then hand a variant to each document.
 *
 * The order is deliberate and matches how a person actually signs: look at what
 * was captured, confirm the background removal worked, then produce one signing
 * per document. Nothing here is silent — every image that ends up on a contract
 * is one the signer looked at first.
 */
const DEFAULT_RECT: Record<ZoneType, NormalizedRect> = {
  signature: { x: 0.08, y: 0.12, width: 0.6, height: 0.28 },
  stamp: { x: 0.52, y: 0.44, width: 0.38, height: 0.36 },
  mention: { x: 0.08, y: 0.46, width: 0.5, height: 0.2 },
  signature_stamp: { x: 0.1, y: 0.16, width: 0.7, height: 0.5 },
};

const TINT: Record<ZoneType, string> = {
  signature: theme.color.brand,
  stamp: theme.color.success,
  mention: theme.color.warning,
  signature_stamp: '#8b3fbf',
};

export default function SelectRegionsScreen() {
  const params = useLocalSearchParams<{
    sessionId: string;
    folderId?: string;
    localUri?: string;
    photoUrl?: string;
    photoWidth: string;
    photoHeight: string;
    suggestions?: string;
    marks?: string;
  }>();
  const router = useRouter();
  const startSession = useStartSession();
  const submit = useSubmitRegions();
  const generate = useGenerateVariants();

  const steps = useMemo((): ZoneType[] => {
    try {
      const parsed = JSON.parse(params.marks ?? '[]') as ZoneType[];
      return parsed.length > 0 ? parsed : ['signature'];
    } catch {
      return ['signature'];
    }
  }, [params.marks]);

  const [stepIndex, setStepIndex] = useState(0);
  const [regions, setRegions] = useState<Partial<Record<ZoneType, NormalizedRect>>>({});
  const [variants, setVariants] = useState<Partial<Record<ZoneType, GeneratedVariant[]>>>({});
  const [assignments, setAssignments] = useState<MarkAssignments>({});
  const [error, setError] = useState<string | null>(null);
  const [scrollEnabled, setScrollEnabled] = useState(true);
  const [resetToken, setResetToken] = useState(0);

  const [detected, setDetected] = useState<Partial<Record<ZoneType, NormalizedRect>>>(() => {
    try {
      const parsed = JSON.parse(params.suggestions ?? '{}') as Partial<
        Record<ZoneType, NormalizedRect | null>
      >;
      const out: Partial<Record<ZoneType, NormalizedRect>> = {};
      for (const [key, value] of Object.entries(parsed)) if (value) out[key as ZoneType] = value;
      return out;
    } catch {
      return {};
    }
  });

  const uploadRef = useRef<Promise<string> | null>(null);
  const [uploading, setUploading] = useState(false);
  const [readySessionId, setReadySessionId] = useState<string | null>(
    params.sessionId !== 'pending' ? params.sessionId : null,
  );
  const touched = useRef(false);

  const photoUri = params.localUri ?? params.photoUrl ?? '';
  const [photoDims, setPhotoDims] = useState({
    width: Number(params.photoWidth) || 1,
    height: Number(params.photoHeight) || 1,
  });

  const step = steps[stepIndex] ?? 'signature';
  const isLast = stepIndex === steps.length - 1;
  const current = regions[step] ?? null;

  const { data: documents } = useSessionDocuments(readySessionId);
  const documentList = documents?.items ?? [];

  useEffect(() => {
    if (params.sessionId !== 'pending' || !params.localUri || !params.folderId) return;
    if (uploadRef.current) return;

    setUploading(true);
    uploadRef.current = startSession
      .mutateAsync({ folderId: params.folderId, captureMode: 'single', uri: params.localUri })
      .then((created) => {
        if (created.photo) {
          setPhotoDims((prev) =>
            prev.width === created.photo!.width && prev.height === created.photo!.height
              ? prev
              : { width: created.photo!.width, height: created.photo!.height },
          );
        }
        const found = created.suggestions ?? {};
        const usable: Partial<Record<ZoneType, NormalizedRect>> = {};
        for (const [key, value] of Object.entries(found)) {
          if (value) usable[key as ZoneType] = value as NormalizedRect;
        }
        if (Object.keys(usable).length > 0 && !touched.current) setDetected(usable);
        setReadySessionId(created.session.id);
        setUploading(false);
        return created.session.id;
      })
      .catch((e: unknown) => {
        setUploading(false);
        setError(e instanceof ApiRequestError ? e.message : "L'envoi de la photo a échoué.");
        throw e;
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [params.sessionId, params.localUri, params.folderId]);

  const startingRect = detected[step] ?? DEFAULT_RECT[step];
  const wasDetected = Boolean(detected[step]);

  const handleChange = useCallback(
    (rect: NormalizedRect) => {
      touched.current = true;
      setRegions((prev) => ({ ...prev, [step]: rect }));
      // The framed area changed, so any variants of it are stale.
      setVariants((prev) => ({ ...prev, [step]: undefined }));
    },
    [step],
  );

  const reset = () => {
    setRegions((prev) => {
      const next = { ...prev };
      delete next[step];
      return next;
    });
    setVariants((prev) => ({ ...prev, [step]: undefined }));
    setResetToken((n) => n + 1);
  };

  const generateForStep = async () => {
    if (!readySessionId || !current) return;
    setError(null);
    try {
      const result = await generate.mutateAsync({
        sessionId: readySessionId,
        mark: step,
        region: current,
        // One per document: signing four contracts means signing four times.
        count: Math.max(1, Math.min(documentList.length || 1, 24)),
      });
      setVariants((prev) => ({ ...prev, [step]: result.variants }));
    } catch (e) {
      setError(
        e instanceof ApiRequestError ? e.message : 'Impossible de générer les variantes.',
      );
    }
  };

  const assign = (documentId: string, index: number) =>
    setAssignments((prev) => ({
      ...prev,
      [step]: { ...(prev[step as keyof MarkAssignments] ?? {}), [documentId]: index },
    }));

  /**
   * Wait for the photo upload rather than refusing to act on it.
   *
   * The button used to be disabled while the upload ran, which on a slow
   * connection looked exactly like a dead button. It now stays pressable and
   * the press waits, so a tap always does something.
   */
  const resolveSessionId = async (): Promise<string> => {
    if (params.sessionId !== 'pending') return params.sessionId;
    if (readySessionId) return readySessionId;
    if (uploadRef.current) return uploadRef.current;
    throw new ApiRequestError(0, "La photo n'a pas été envoyée. Reprenez la photo.");
  };

  const send = async (final: Partial<Record<ZoneType, NormalizedRect>>) => {
    if (!final.signature && !final.signature_stamp) {
      setError('Sélectionnez au moins une signature.');
      return;
    }
    setError(null);
    try {
      const sessionId = await resolveSessionId();
      await submit.mutateAsync({
        sessionId,
        regions: {
          signature: final.signature ?? null,
          stamp: final.stamp ?? null,
          mention: final.mention ?? null,
          signature_stamp: final.signature_stamp ?? null,
          assignments,
        },
      });
      hapticSuccess();
      router.replace(`/(app)/processing/${sessionId}`);
    } catch (e) {
      hapticError();
      setError(e instanceof ApiRequestError ? e.message : 'Envoi impossible.');
    }
  };

  const advance = () => {
    if (isLast) void send(regions);
    else {
      hapticSuccess();
      setStepIndex(stepIndex + 1);
    }
  };

  const skip = () => {
    const without = { ...regions };
    delete without[step];
    setRegions(without);
    if (isLast) void send(without);
    else setStepIndex(stepIndex + 1);
  };

  const variesForStep = HANDWRITTEN_MARKS.includes(step);

  return (
    <Screen edges={['top']}>
      <ScrollView
        contentContainerStyle={styles.content}
        scrollEnabled={scrollEnabled}
        keyboardShouldPersistTaps="handled"
      >
        <Pressable onPress={() => router.back()} hitSlop={12}>
          <Text style={styles.back}>‹ Reprendre la photo</Text>
        </Pressable>

        <View style={styles.steps}>
          {steps.map((mark, i) => (
            <View key={mark} style={[styles.stepDot, i <= stepIndex && styles.stepDotActive]} />
          ))}
          <Text style={styles.stepLabel}>
            Étape {stepIndex + 1} sur {steps.length}
          </Text>
        </View>

        <Title>Cadrez : {ZONE_TYPE_LABEL[step].toLowerCase()}</Title>
        <Subtitle>
          {step === 'signature'
            ? 'Ajustez le cadre autour de votre signature uniquement.'
            : step === 'stamp'
              ? 'Ajustez le cadre autour de votre tampon.'
              : step === 'signature_stamp'
                ? 'Encadrez le tampon et la signature ensemble.'
                : 'Ajustez le cadre autour de la mention « Lu et approuvé ».'}
        </Subtitle>

        {wasDetected && (
          <View style={styles.detected}>
            <Text style={styles.detectedText}>
              Cadre placé automatiquement — vérifiez et ajustez si besoin.
            </Text>
          </View>
        )}

        <View style={{ marginTop: 18 }}>
          <RegionSelector
            key={`${step}-${resetToken}-${wasDetected ? 'auto' : 'manual'}`}
            photoUrl={photoUri}
            photoWidth={photoDims.width}
            photoHeight={photoDims.height}
            value={current}
            defaultRect={startingRect}
            onChange={handleChange}
            onInteractionChange={(active) => setScrollEnabled(!active)}
            tint={TINT[step]}
          />
        </View>

        <CutoutPreview
          sessionId={readySessionId}
          mark={step}
          region={current}
          enabled={Boolean(readySessionId) && !uploading}
        />

        {variesForStep && (
          <VariantAssigner
            mark={step}
            variants={variants[step] ?? []}
            documents={documentList}
            assignment={assignments[step as keyof MarkAssignments] ?? {}}
            onAssign={assign}
            onGenerate={() => void generateForStep()}
            generating={generate.isPending}
            canGenerate={Boolean(readySessionId && current) && !uploading}
          />
        )}

        {uploading && (
          <Text style={styles.uploading}>Envoi de la photo en cours…</Text>
        )}
        {error && <ErrorBanner message={error} />}

        <View style={styles.actions}>
          <Button
            label={isLast ? 'Valider' : 'Continuer'}
            onPress={advance}
            loading={submit.isPending}
            disabled={!current}
          />
          {step !== 'signature' && step !== 'signature_stamp' && (
            <Button
              label={`Pas de ${ZONE_TYPE_LABEL[step].toLowerCase()}`}
              variant="secondary"
              onPress={skip}
              loading={submit.isPending}
              style={{ marginTop: 10 }}
            />
          )}
          <View style={styles.secondaryRow}>
            <Button label="Réinitialiser" variant="ghost" onPress={reset} style={{ flex: 1 }} />
            {stepIndex > 0 && (
              <Button
                label="Étape précédente"
                variant="ghost"
                onPress={() => setStepIndex(stepIndex - 1)}
                style={{ flex: 1 }}
              />
            )}
          </View>
        </View>
      </ScrollView>
    </Screen>
  );
}

const styles = StyleSheet.create({
  content: { padding: 20, paddingBottom: 44 },
  back: { color: theme.color.brand, fontSize: 16, fontWeight: '600', marginBottom: 14 },
  steps: { flexDirection: 'row', alignItems: 'center', gap: 6, marginBottom: 10 },
  stepDot: { width: 22, height: 4, borderRadius: 2, backgroundColor: theme.color.border },
  stepDotActive: { backgroundColor: theme.color.brand },
  stepLabel: { marginLeft: 6, fontSize: 12.5, color: theme.color.muted, fontWeight: '600' },
  actions: { marginTop: 22 },
  secondaryRow: { flexDirection: 'row', gap: 8, marginTop: 4 },
  uploading: { marginTop: 12, fontSize: 13, color: theme.color.muted, textAlign: 'center' },
  detected: {
    marginTop: 10,
    backgroundColor: theme.color.brandSoft,
    borderRadius: theme.radius.sm,
    paddingHorizontal: 12,
    paddingVertical: 8,
  },
  detectedText: { color: theme.color.brand, fontSize: 13, fontWeight: '600' },
});
