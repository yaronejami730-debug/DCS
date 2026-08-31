import { useMemo, useRef, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { CameraView, useCameraPermissions } from 'expo-camera';
import * as ImagePicker from 'expo-image-picker';
import {
  marksToCapture,
  ZONE_TYPE_INSTRUCTION,
  ZONE_TYPE_LABEL,
  type CaptureMode,
  type NormalizedRect,
  type ZoneType,
} from '@scansign/shared';
import {
  useRequiredMarks,
  useStartSession,
  useUploadMarkPhoto,
} from '../../../src/lib/queries';
import { ApiRequestError } from '../../../src/lib/api';
import { hapticError, hapticSelect, hapticShutter, hapticSuccess } from '../../../src/lib/haptics';
import { Button, Card, ErrorBanner, Loading, Screen, Subtitle, Title } from '../../../src/components/ui';
import { theme } from '../../../src/lib/theme';

/**
 * Capture flow.
 *
 * The shutter is instant on purpose. `takePictureAsync` gives us the photo as a
 * local file straight away, so the next screen opens on that file immediately
 * and the upload — plus the server-side re-encode and ink detection, which take
 * seconds over WiFi — happens behind it. Waiting for the round trip before
 * moving on made every capture feel like the app had stalled.
 *
 * The signer picks how to capture, because neither way wins everywhere:
 *   single   — one photo of a sheet holding every mark, then frame each one.
 *   per_mark — one photo per mark, each used whole. Nothing to frame.
 *
 * The number of steps follows what the folder's templates actually ask for.
 */
export default function CaptureScreen() {
  const {
    folderId,
    resumeAt,
    collected: collectedParam,
    collectedAssignments,
    sessionId: resumedSessionId,
  } = useLocalSearchParams<{
    folderId: string;
    resumeAt?: string;
    collected?: string;
    collectedAssignments?: string;
    /**
     * The session opened for the first mark.
     *
     * It has to travel through the navigation, not live in a ref: returning
     * here from the framing screen remounts this screen, so a ref is empty
     * again and a second mark would open a SECOND session. That happened —
     * the signature landed in one session, the mention in another, and the
     * one that got submitted had no signature at all.
     */
    sessionId?: string;
  }>();
  const router = useRouter();
  const camera = useRef<CameraView>(null);
  const [permission, requestPermission] = useCameraPermissions();

  const { data: marks, isLoading: loadingMarks } = useRequiredMarks(folderId);
  const startSession = useStartSession();
  const uploadMark = useUploadMarkPhoto();

  // Returning from the framing screen resumes at the next mark, carrying the
  // regions confirmed so far.
  const [mode, setMode] = useState<CaptureMode | null>(resumeAt ? 'per_mark' : null);
  const [stepIndex, setStepIndex] = useState(Number(resumeAt ?? 0) || 0);
  const [captured, setCaptured] = useState<Partial<Record<ZoneType, NormalizedRect>>>(() => {
    try {
      return collectedParam ? (JSON.parse(collectedParam) as Partial<Record<ZoneType, NormalizedRect>>) : {};
    } catch {
      return {};
    }
  });
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  /**
   * Per-mark uploads run in the background; this holds the work in flight so
   * the final submit can wait for all of it without ever blocking the shutter.
   */
  const sessionIdRef = useRef<string | null>(resumedSessionId ?? null);
  const pendingUploads = useRef<Array<Promise<unknown>>>([]);

  // Derived from the shared capture order, so a mark added later cannot be
  // silently left out of the flow.
  const needed = useMemo(() => marksToCapture(marks ?? {}), [marks]);
  const currentMark = needed[stepIndex] ?? 'signature';

  if (loadingMarks || !permission) return <Loading />;

  if (!permission.granted) {
    return (
      <Screen>
        <View style={styles.permission}>
          <Title>Accès à l’appareil photo</Title>
          <Subtitle>
            Scan&Sign a besoin de l’appareil photo pour capturer votre signature et votre tampon.
          </Subtitle>
          <Button label="Autoriser" onPress={() => void requestPermission()} style={{ marginTop: 24 }} />
          <Button label="Retour" variant="ghost" onPress={() => router.back()} />
        </View>
      </Screen>
    );
  }

  // --- choose how to capture ------------------------------------------------
  if (!mode) {
    const choose = (chosen: CaptureMode) => {
      hapticSelect();
      setMode(chosen);
    };
    return (
      <Screen>
        <ScrollView contentContainerStyle={styles.chooser}>
          <Pressable onPress={() => router.back()} hitSlop={12}>
            <Text style={styles.back}>‹ Retour</Text>
          </Pressable>
          <Title>Comment souhaitez-vous procéder ?</Title>
          <Subtitle>
            Ce dossier demande {needed.map((m) => ZONE_TYPE_LABEL[m].toLowerCase()).join(', ')}.
          </Subtitle>

          <Pressable onPress={() => choose('single')}>
            <Card style={styles.option}>
              <Text style={styles.optionTitle}>Une seule photo</Text>
              <Text style={styles.optionText}>
                Posez {needed.length > 1 ? 'toutes vos marques' : 'votre signature'} sur une même
                feuille, prenez une photo, puis encadrez chaque élément.
              </Text>
              <Text style={styles.optionMeta}>1 photo · {needed.length} cadrage(s)</Text>
            </Card>
          </Pressable>

          <Pressable onPress={() => choose('per_mark')}>
            <Card style={styles.option}>
              <Text style={styles.optionTitle}>Une photo par élément</Text>
              <Text style={styles.optionText}>
                Photographiez chaque élément séparément. Rien à encadrer : la photo entière est
                utilisée.
              </Text>
              <Text style={styles.optionMeta}>{needed.length} photo(s) · aucun cadrage</Text>
            </Card>
          </Pressable>

          {error && <ErrorBanner message={error} />}
        </ScrollView>
      </Screen>
    );
  }

  /**
   * Both sources produce the same thing — a local file plus its displayed size
   * — so everything downstream treats them identically.
   */
  const pickFromLibrary = async (): Promise<{ uri: string; width: number; height: number } | null> => {
    const permission = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (!permission.granted) {
      setError("Autorisez l'accès à vos photos pour en importer une.");
      return null;
    }
    const result = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ['images'],
      quality: 0.9,
      exif: false,
    });
    const asset = result.canceled ? null : result.assets[0];
    if (!asset) return null;
    return { uri: asset.uri, width: asset.width, height: asset.height };
  };

  const capture = async (source: 'camera' | 'library') => {
    if (busy) return;
    if (source === 'camera' && !camera.current) return;
    setBusy(true);
    setError(null);
    try {
      // `skipProcessing: false` makes iOS apply the sensor orientation, so the
      // returned width/height match what the user sees — which is what the
      // framing rectangles are relative to.
      const photo =
        source === 'camera'
          ? await camera.current!.takePictureAsync({ quality: 0.85, skipProcessing: false })
          : await pickFromLibrary();

      if (!photo?.uri) {
        // A cancelled picker is not an error.
        setBusy(false);
        return;
      }

      // Fire the moment the photo exists, not after the upload.
      hapticShutter();

      if (mode === 'single') {
        // Straight to framing on the local file. The upload, the server-side
        // re-encode and the ink detection all resolve behind this screen.
        router.replace({
          pathname: '/(app)/select/[sessionId]',
          params: {
            sessionId: 'pending',
            folderId,
            localUri: photo.uri,
            photoWidth: String(photo.width),
            photoHeight: String(photo.height),
            marks: JSON.stringify(needed),
          },
        });
        return;
      }

      // --- per-mark ----------------------------------------------------------
      // Each mark still gets framed. The photo is often taken at arm's length
      // and catches the edge of the sheet or a neighbouring mark, so using the
      // whole frame blindly produced worse cutouts than a quick adjustment.
      // The upload starts now and runs behind the framing screen.
      const mark = currentMark;
      const upload = (async () => {
        let id = sessionIdRef.current;
        if (!id) {
          const created = await startSession.mutateAsync({ folderId, captureMode: 'per_mark' });
          id = created.session.id;
          sessionIdRef.current = id;
        }
        return uploadMark.mutateAsync({ sessionId: id, mark, uri: photo.uri });
      })();
      pendingUploads.current.push(upload);
      const uploaded = await upload;

      // Every mark must land in the SAME session, so the id goes with us.
      const sessionId = sessionIdRef.current;
      if (!sessionId) throw new Error('session manquante');

      router.push({
        pathname: '/(app)/frame/[mark]',
        params: {
          mark,
          sessionId,
          folderId,
          photoUrl: uploaded.photo.url,
          photoWidth: String(uploaded.photo.width),
          photoHeight: String(uploaded.photo.height),
          suggestion: JSON.stringify(uploaded.suggestion ?? null),
          remaining: JSON.stringify(needed.slice(stepIndex + 1)),
          collected: JSON.stringify(captured),
          collectedAssignments: collectedAssignments ?? '{}',
        },
      });
    } catch (e) {
      hapticError();
      setError(e instanceof ApiRequestError ? e.message : "La photo n'a pas pu être envoyée.");
    } finally {
      setBusy(false);
    }
  };

  const instruction =
    mode === 'single'
      ? `Posez ${needed.map((m) => ZONE_TYPE_LABEL[m].toLowerCase()).join(', ')} sur une feuille blanche, bien à plat et bien éclairée.`
      : ZONE_TYPE_INSTRUCTION[currentMark];

  const locked = stepIndex > 0 || sessionIdRef.current !== null;


  return (
    <Screen edges={['top']}>
      <View style={styles.header}>
        <Pressable onPress={() => (locked ? undefined : setMode(null))} hitSlop={12} disabled={locked}>
          <Text style={[styles.back, locked && styles.backDisabled]}>‹ Changer de méthode</Text>
        </Pressable>

        {mode === 'per_mark' && (
          <View style={styles.steps}>
            {needed.map((mark, i) => (
              <View key={mark} style={[styles.stepDot, i <= stepIndex && styles.stepDotActive]} />
            ))}
            <Text style={styles.stepLabel}>
              Étape {stepIndex + 1} sur {needed.length}
            </Text>
          </View>
        )}

        <Title>{mode === 'per_mark' ? ZONE_TYPE_LABEL[currentMark] : 'Photo'}</Title>
        <Subtitle>{instruction}</Subtitle>
        {error && <ErrorBanner message={error} />}
      </View>

      <View style={styles.cameraBox}>
        <CameraView ref={camera} style={{ flex: 1 }} facing="back" />
        <View pointerEvents="none" style={styles.guide} />
      </View>

      <View style={styles.footer}>
        <Button
          label={
            mode === 'per_mark' && stepIndex + 1 < needed.length
              ? `Photographier ${ZONE_TYPE_LABEL[currentMark].toLowerCase()}`
              : 'Prendre la photo'
          }
          onPress={() => void capture('camera')}
          loading={busy}
        />
        <Button
          label="Importer depuis mes photos"
          variant="secondary"
          onPress={() => void capture('library')}
          disabled={busy}
          style={{ marginTop: 10 }}
        />
      </View>
    </Screen>
  );
}

const styles = StyleSheet.create({
  chooser: { padding: 20, paddingBottom: 40, gap: 12 },
  option: { marginTop: 4 },
  optionTitle: { fontSize: 17, fontWeight: '700', color: theme.color.text },
  optionText: { fontSize: 14, color: theme.color.muted, marginTop: 6, lineHeight: 20 },
  optionMeta: { fontSize: 12.5, color: theme.color.brand, marginTop: 10, fontWeight: '600' },
  header: { paddingHorizontal: 20, paddingBottom: 12, gap: 4 },
  back: { color: theme.color.brand, fontSize: 16, fontWeight: '600', marginBottom: 8 },
  backDisabled: { color: theme.color.border },
  steps: { flexDirection: 'row', alignItems: 'center', gap: 6, marginBottom: 6 },
  stepDot: { width: 20, height: 4, borderRadius: 2, backgroundColor: theme.color.border },
  stepDotActive: { backgroundColor: theme.color.brand },
  stepLabel: { marginLeft: 6, fontSize: 12.5, color: theme.color.muted, fontWeight: '600' },
  cameraBox: {
    flex: 1,
    marginHorizontal: 16,
    borderRadius: theme.radius.lg,
    overflow: 'hidden',
    backgroundColor: '#000',
  },
  guide: {
    position: 'absolute',
    top: '10%',
    left: '8%',
    right: '8%',
    bottom: '10%',
    borderWidth: 2,
    borderColor: 'rgba(255,255,255,0.6)',
    borderRadius: theme.radius.md,
    borderStyle: 'dashed',
  },
  footer: { padding: 20, paddingBottom: 32 },
  permission: { flex: 1, padding: 24, justifyContent: 'center' },
});
