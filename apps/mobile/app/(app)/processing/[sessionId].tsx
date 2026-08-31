import { ActivityIndicator, StyleSheet, Text, View } from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { ERROR_CODE_LABEL, type ErrorCode } from '@scansign/shared';
import { useSession } from '../../../src/lib/queries';
import { Button, Screen, Subtitle, Title } from '../../../src/components/ui';
import { theme } from '../../../src/lib/theme';

/**
 * Waiting screen. The user never sees crops, providers or coordinates — only
 * "en cours", then "signé".
 */
export default function ProcessingScreen() {
  const { sessionId } = useLocalSearchParams<{ sessionId: string }>();
  const router = useRouter();
  const { data: session } = useSession(sessionId, true);

  const status = session?.status ?? 'processing';
  const failed = status === 'error';
  const done = status === 'completed';

  return (
    <Screen>
      <View style={styles.content}>
        {!done && !failed && (
          <>
            <ActivityIndicator size="large" color={theme.color.brand} />
            <Title>Traitement en cours…</Title>
            <Subtitle>Nous détourons votre signature et l’insérons dans vos documents.</Subtitle>
          </>
        )}

        {done && (
          <>
            <Text style={styles.check}>✓</Text>
            <Title>Document signé</Title>
            <Subtitle>Vos documents signés sont disponibles dans votre espace web.</Subtitle>
            <Button
              label="Terminer"
              onPress={() => router.replace('/(app)')}
              style={{ marginTop: 28, alignSelf: 'stretch' }}
            />
          </>
        )}

        {failed && (
          <>
            <Text style={styles.cross}>!</Text>
            <Title>Le traitement a échoué</Title>
            <Subtitle>
              {ERROR_CODE_LABEL[session?.errorCode as ErrorCode] ??
                session?.errorMessage ??
                'Une erreur est survenue.'}
            </Subtitle>
            <Button
              label="Réessayer"
              onPress={() => router.replace(`/(app)/folder/${session?.folderId ?? ''}`)}
              style={{ marginTop: 28, alignSelf: 'stretch' }}
            />
            <Button
              label="Retour à l’accueil"
              variant="ghost"
              onPress={() => router.replace('/(app)')}
              style={{ alignSelf: 'stretch' }}
            />
          </>
        )}
      </View>
    </Screen>
  );
}

const styles = StyleSheet.create({
  content: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 32, gap: 10 },
  check: { fontSize: 56, color: theme.color.success, fontWeight: '700' },
  cross: { fontSize: 56, color: theme.color.danger, fontWeight: '700' },
});
