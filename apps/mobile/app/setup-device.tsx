import { useState } from 'react';
import { StyleSheet, Text, TextInput, View } from 'react-native';
import { useRouter } from 'expo-router';
import { useAuth } from '../src/lib/auth';
import { ApiRequestError } from '../src/lib/api';
import { suggestedDeviceName } from '../src/lib/device';
import { Button, ErrorBanner, Screen, Subtitle, Title } from '../src/components/ui';
import { theme } from '../src/lib/theme';

/** First launch: give this phone a name the operator will recognise in the console. */
export default function SetupDeviceScreen() {
  const { enrollDevice, signOut } = useAuth();
  const router = useRouter();
  const [name, setName] = useState(suggestedDeviceName());
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      await enrollDevice(name.trim());
      router.replace('/(app)');
    } catch (e) {
      setError(e instanceof ApiRequestError ? e.message : "Enregistrement impossible.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Screen>
      <View style={styles.content}>
        <Title>Nommez cet appareil</Title>
        <Subtitle>
          Ce nom apparaîtra dans votre espace web pour choisir où envoyer les documents.
        </Subtitle>

        <Text style={styles.label}>Nom de l’appareil</Text>
        <TextInput
          style={styles.input}
          value={name}
          onChangeText={setName}
          placeholder="iPhone Accueil"
          placeholderTextColor={theme.color.muted}
          returnKeyType="done"
          onSubmitEditing={submit}
        />
        <Text style={styles.hint}>Par exemple : iPhone Accueil, iPhone Bureau, iPhone Commercial 1</Text>

        {error && <ErrorBanner message={error} />}

        <Button
          label="Continuer"
          onPress={submit}
          loading={busy}
          disabled={name.trim().length === 0}
          style={{ marginTop: 24 }}
        />
        <Button
          label="Changer de compte"
          variant="ghost"
          onPress={() => void signOut()}
          style={{ marginTop: 4 }}
        />
      </View>
    </Screen>
  );
}

const styles = StyleSheet.create({
  content: { flex: 1, padding: 24, justifyContent: 'center' },
  label: { fontSize: 14, fontWeight: '600', color: theme.color.text, marginTop: 32, marginBottom: 6 },
  input: {
    height: 50,
    borderRadius: theme.radius.md,
    borderWidth: 1,
    borderColor: theme.color.border,
    backgroundColor: theme.color.surface,
    paddingHorizontal: 14,
    fontSize: 16,
    color: theme.color.text,
  },
  hint: { fontSize: 13, color: theme.color.muted, marginTop: 8 },
});
