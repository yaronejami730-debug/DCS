import type { ReactNode } from 'react';
import {
  ActivityIndicator,
  Pressable,
  StyleSheet,
  Text,
  View,
  type StyleProp,
  type ViewStyle,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import {
  DOCUMENT_STATUS_LABEL,
  FOLDER_STATUS_LABEL,
  type DocumentStatus,
  type FolderStatus,
} from '@scansign/shared';
import { theme } from '../lib/theme';

export const Screen = ({
  children,
  style,
  edges = ['top', 'bottom'],
}: {
  children: ReactNode;
  style?: StyleProp<ViewStyle>;
  edges?: Array<'top' | 'bottom' | 'left' | 'right'>;
}) => (
  <SafeAreaView style={[styles.screen, style]} edges={edges}>
    {children}
  </SafeAreaView>
);

export const Title = ({ children }: { children: ReactNode }) => (
  <Text style={styles.title}>{children}</Text>
);

export const Subtitle = ({ children }: { children: ReactNode }) => (
  <Text style={styles.subtitle}>{children}</Text>
);

export const Button = ({
  label,
  onPress,
  variant = 'primary',
  loading = false,
  disabled = false,
  style,
}: {
  label: string;
  onPress: () => void;
  variant?: 'primary' | 'secondary' | 'ghost';
  loading?: boolean;
  disabled?: boolean;
  style?: StyleProp<ViewStyle>;
}) => {
  const isDisabled = disabled || loading;
  return (
    <Pressable
      onPress={onPress}
      disabled={isDisabled}
      style={({ pressed }) => [
        styles.button,
        variant === 'primary' && styles.buttonPrimary,
        variant === 'secondary' && styles.buttonSecondary,
        variant === 'ghost' && styles.buttonGhost,
        isDisabled && styles.buttonDisabled,
        pressed && !isDisabled && styles.buttonPressed,
        style,
      ]}
    >
      {loading && (
        <ActivityIndicator
          size="small"
          color={variant === 'primary' ? '#fff' : theme.color.brand}
          style={{ marginRight: 8 }}
        />
      )}
      <Text
        style={[
          styles.buttonLabel,
          variant === 'primary' ? styles.buttonLabelPrimary : styles.buttonLabelDark,
          isDisabled && styles.buttonLabelDisabled,
        ]}
      >
        {label}
      </Text>
    </Pressable>
  );
};

export const Card = ({
  children,
  style,
}: {
  children: ReactNode;
  style?: StyleProp<ViewStyle>;
}) => <View style={[styles.card, style]}>{children}</View>;

const TONE: Record<string, { bg: string; fg: string }> = {
  pending: { bg: theme.color.warningSoft, fg: theme.color.warning },
  delivered: { bg: theme.color.brandSoft, fg: theme.color.brand },
  in_progress: { bg: theme.color.brandSoft, fg: theme.color.brand },
  processing: { bg: theme.color.brandSoft, fg: theme.color.brand },
  completed: { bg: theme.color.successSoft, fg: theme.color.success },
  error: { bg: theme.color.dangerSoft, fg: theme.color.danger },
  awaiting_template: { bg: theme.color.warningSoft, fg: theme.color.warning },
  ready: { bg: theme.color.brandSoft, fg: theme.color.brand },
};

export const Pill = ({ label, tone }: { label: string; tone: string }) => {
  const colors = TONE[tone] ?? { bg: theme.color.bg, fg: theme.color.muted };
  return (
    <View style={[styles.pill, { backgroundColor: colors.bg }]}>
      <Text style={[styles.pillLabel, { color: colors.fg }]}>{label}</Text>
    </View>
  );
};

export const FolderPill = ({ status }: { status: FolderStatus }) => (
  <Pill label={FOLDER_STATUS_LABEL[status]} tone={status} />
);

export const DocumentPill = ({ status }: { status: DocumentStatus }) => (
  <Pill label={DOCUMENT_STATUS_LABEL[status]} tone={status} />
);

export const Loading = ({ label }: { label?: string }) => (
  <View style={styles.loading}>
    <ActivityIndicator color={theme.color.brand} />
    {label && <Text style={styles.loadingLabel}>{label}</Text>}
  </View>
);

export const ErrorBanner = ({ message }: { message: string }) => (
  <View style={styles.errorBanner}>
    <Text style={styles.errorText}>{message}</Text>
  </View>
);

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: theme.color.bg },
  title: { fontSize: 26, fontWeight: '700', color: theme.color.text, letterSpacing: -0.4 },
  subtitle: { fontSize: 15, color: theme.color.muted, marginTop: 4, lineHeight: 21 },
  button: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    height: 52,
    borderRadius: theme.radius.md,
    paddingHorizontal: 20,
  },
  buttonPrimary: { backgroundColor: theme.color.brand },
  buttonSecondary: {
    backgroundColor: theme.color.surface,
    borderWidth: 1,
    borderColor: theme.color.border,
  },
  buttonGhost: { backgroundColor: 'transparent' },
  buttonPressed: { opacity: 0.85 },
  buttonDisabled: { backgroundColor: '#dfe4ec' },
  buttonLabel: { fontSize: 16, fontWeight: '600' },
  buttonLabelPrimary: { color: '#fff' },
  buttonLabelDark: { color: theme.color.text },
  buttonLabelDisabled: { color: '#9aa6b8' },
  card: {
    backgroundColor: theme.color.surface,
    borderRadius: theme.radius.md,
    borderWidth: 1,
    borderColor: theme.color.border,
    padding: 16,
  },
  pill: { alignSelf: 'flex-start', paddingHorizontal: 10, paddingVertical: 4, borderRadius: 999 },
  pillLabel: { fontSize: 12, fontWeight: '600' },
  loading: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 10 },
  loadingLabel: { color: theme.color.muted, fontSize: 15 },
  errorBanner: {
    backgroundColor: theme.color.dangerSoft,
    borderRadius: theme.radius.sm,
    padding: 12,
    marginTop: 12,
  },
  errorText: { color: theme.color.danger, fontSize: 14 },
});
