import { useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import type { NormalizedRect } from '@scansign/shared';
import { RegionSelector } from '../../../src/components/RegionSelector';
import { useSubmitRegions } from '../../../src/lib/queries';
import { ApiRequestError } from '../../../src/lib/api';
import { Button, ErrorBanner, Screen, Subtitle, Title } from '../../../src/components/ui';
import { theme } from '../../../src/lib/theme';

type Step = 'signature' | 'stamp';

/**
 * Two-step framing: signature first, then the stamp (which the user can skip if
 * the documents do not need one). Rectangles are normalized fractions of the
 * photo, so they mean the same thing on the server as on screen.
 */
export default function SelectRegionsScreen() {
  const params = useLocalSearchParams<{
    sessionId: string;
    photoUrl: string;
    photoWidth: string;
    photoHeight: string;
  }>();
  const router = useRouter();
  const submit = useSubmitRegions();

  const [step, setStep] = useState<Step>('signature');
  const [signature, setSignature] = useState<NormalizedRect | null>(null);
  const [stamp, setStamp] = useState<NormalizedRect | null>(null);
  const [error, setError] = useState<string | null>(null);

  const photoWidth = Number(params.photoWidth) || 1;
  const photoHeight = Number(params.photoHeight) || 1;
  const current = step === 'signature' ? signature : stamp;

  const send = async (withStamp: NormalizedRect | null) => {
    if (!signature) return;
    setError(null);
    try {
      await submit.mutateAsync({
        sessionId: params.sessionId,
        regions: { signature, stamp: withStamp },
      });
      router.replace(`/(app)/processing/${params.sessionId}`);
    } catch (e) {
      setError(e instanceof ApiRequestError ? e.message : 'Envoi impossible.');
    }
  };

  return (
    <Screen edges={['top']}>
      <ScrollView contentContainerStyle={styles.content}>
        <Pressable onPress={() => router.back()} hitSlop={12}>
          <Text style={styles.back}>‹ Reprendre la photo</Text>
        </Pressable>

        <Title>{step === 'signature' ? 'Sélectionnez la signature' : 'Sélectionnez le tampon'}</Title>
        <Subtitle>
          {step === 'signature'
            ? 'Encadrez uniquement votre signature.'
            : 'Encadrez uniquement votre tampon. Si vos documents n’en demandent pas, passez cette étape.'}
        </Subtitle>

        <View style={{ marginTop: 20 }}>
          <RegionSelector
            photoUrl={params.photoUrl}
            photoWidth={photoWidth}
            photoHeight={photoHeight}
            value={current}
            onChange={step === 'signature' ? setSignature : setStamp}
            tint={step === 'signature' ? theme.color.brand : theme.color.success}
          />
        </View>

        {error && <ErrorBanner message={error} />}

        <View style={styles.actions}>
          {step === 'signature' ? (
            <Button
              label="Continuer"
              onPress={() => setStep('stamp')}
              disabled={!signature}
            />
          ) : (
            <>
              <Button
                label="Valider"
                onPress={() => void send(stamp)}
                loading={submit.isPending}
                disabled={!stamp}
              />
              <Button
                label="Pas de tampon"
                variant="secondary"
                onPress={() => void send(null)}
                loading={submit.isPending}
                style={{ marginTop: 10 }}
              />
              <Button
                label="Revenir à la signature"
                variant="ghost"
                onPress={() => setStep('signature')}
                style={{ marginTop: 4 }}
              />
            </>
          )}
        </View>
      </ScrollView>
    </Screen>
  );
}

const styles = StyleSheet.create({
  content: { padding: 20, paddingBottom: 40 },
  back: { color: theme.color.brand, fontSize: 16, fontWeight: '600', marginBottom: 12 },
  actions: { marginTop: 24 },
});
