import { useState } from 'react';
import {
  KeyboardAvoidingView,
  Platform,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { useAuth } from '../src/lib/auth';
import { ApiRequestError } from '../src/lib/api';
import { Button, ErrorBanner, Screen, Subtitle, Title } from '../src/components/ui';
import { theme } from '../src/lib/theme';

export default function LoginScreen() {
  const { signIn } = useAuth();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      await signIn(email.trim(), password);
    } catch (e) {
      setError(e instanceof ApiRequestError ? e.message : 'Connexion impossible.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Screen>
      <KeyboardAvoidingView
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        style={{ flex: 1 }}
      >
        <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
          <View style={styles.header}>
            <Title>Scan&Sign</Title>
            <Subtitle>
              Connectez-vous avec le même compte que sur votre espace web. Les documents envoyés
              depuis le site arriveront ici.
            </Subtitle>
          </View>

          <View style={styles.form}>
            <Text style={styles.label}>Email</Text>
            <TextInput
              style={styles.input}
              value={email}
              onChangeText={setEmail}
              autoCapitalize="none"
              autoCorrect={false}
              keyboardType="email-address"
              textContentType="emailAddress"
              placeholder="vous@exemple.fr"
              placeholderTextColor={theme.color.muted}
            />

            <Text style={[styles.label, { marginTop: 16 }]}>Mot de passe</Text>
            <TextInput
              style={styles.input}
              value={password}
              onChangeText={setPassword}
              secureTextEntry
              textContentType="password"
              placeholder="••••••••"
              placeholderTextColor={theme.color.muted}
              onSubmitEditing={submit}
              returnKeyType="go"
            />

            {error && <ErrorBanner message={error} />}

            <Button
              label="Se connecter"
              onPress={submit}
              loading={busy}
              disabled={!email || !password}
              style={{ marginTop: 24 }}
            />
          </View>
        </ScrollView>
      </KeyboardAvoidingView>
    </Screen>
  );
}

const styles = StyleSheet.create({
  content: { padding: 24, paddingTop: 48, flexGrow: 1, justifyContent: 'center' },
  header: { marginBottom: 32 },
  form: {},
  label: { fontSize: 14, fontWeight: '600', color: theme.color.text, marginBottom: 6 },
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
});
