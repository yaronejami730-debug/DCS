import { useRef, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { CameraView, useCameraPermissions } from 'expo-camera';
import { useUploadPhoto } from '../../../src/lib/queries';
import { ApiRequestError } from '../../../src/lib/api';
import { Button, ErrorBanner, Loading, Screen, Subtitle, Title } from '../../../src/components/ui';
import { theme } from '../../../src/lib/theme';

/**
 * Capture step. Deliberately dumb: take one photo of a white sheet holding both
 * the signature and the stamp. No automatic detection — the user frames each
 * one on the next screen, which is far more reliable than guessing.
 */
export default function CaptureScreen() {
  const { folderId } = useLocalSearchParams<{ folderId: string }>();
  const router = useRouter();
  const camera = useRef<CameraView>(null);
  const [permission, requestPermission] = useCameraPermissions();
  const upload = useUploadPhoto();
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  if (!permission) return <Loading />;

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

  const take = async () => {
    if (!camera.current || busy) return;
    setBusy(true);
    setError(null);
    try {
      const photo = await camera.current.takePictureAsync({ quality: 0.9, skipProcessing: false });
      if (!photo?.uri) throw new Error('no photo');
      const created = await upload.mutateAsync({ folderId, uri: photo.uri });
      router.replace({
        pathname: '/(app)/select/[sessionId]',
        params: {
          sessionId: created.session.id,
          photoUrl: created.photo.url,
          photoWidth: String(created.photo.width),
          photoHeight: String(created.photo.height),
        },
      });
    } catch (e) {
      setError(e instanceof ApiRequestError ? e.message : "La photo n'a pas pu être envoyée.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Screen edges={['top']}>
      <View style={styles.header}>
        <Pressable onPress={() => router.back()} hitSlop={12}>
          <Text style={styles.back}>‹ Retour</Text>
        </Pressable>
        <Title>Photo</Title>
        <Subtitle>
          Posez votre signature et votre tampon sur une feuille blanche, bien à plat et bien
          éclairée.
        </Subtitle>
        {error && <ErrorBanner message={error} />}
      </View>

      <View style={styles.cameraBox}>
        <CameraView ref={camera} style={{ flex: 1 }} facing="back" />
        <View pointerEvents="none" style={styles.guide} />
      </View>

      <View style={styles.footer}>
        <Button label="Prendre la photo" onPress={take} loading={busy} />
      </View>
    </Screen>
  );
}

const styles = StyleSheet.create({
  header: { paddingHorizontal: 20, paddingBottom: 12, gap: 4 },
  back: { color: theme.color.brand, fontSize: 16, fontWeight: '600', marginBottom: 8 },
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
