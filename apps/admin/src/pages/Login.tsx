import { useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../lib/auth';
import { ApiRequestError } from '../lib/api';
import { Button, Field } from '../components/ui';

export const LoginPage = () => {
  const { signIn, signUp } = useAuth();
  const navigate = useNavigate();
  const [mode, setMode] = useState<'login' | 'signup'>('login');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      if (mode === 'login') await signIn(email, password);
      else await signUp(email, password, displayName);
      navigate('/dashboard');
    } catch (e) {
      setError(e instanceof ApiRequestError ? e.message : 'Connexion impossible.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex min-h-full items-center justify-center px-4">
      <div className="w-full max-w-sm">
        <div className="mb-6 text-center">
          <p className="text-2xl font-semibold tracking-tight">
            Scan<span className="text-brand-600">&amp;</span>Sign
          </p>
          <p className="mt-1 text-sm text-ink-400">
            Le même compte vous connecte ici et sur l’iPhone.
          </p>
        </div>

        <form onSubmit={submit} className="space-y-4 rounded-xl bg-white p-6 ring-1 ring-ink-200/70">
          {mode === 'signup' && (
            <Field
              label="Nom"
              value={displayName}
              onChange={(e) => setDisplayName(e.target.value)}
              placeholder="Votre nom"
              autoComplete="name"
            />
          )}
          <Field
            label="Email"
            type="email"
            required
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            autoComplete="email"
          />
          <Field
            label="Mot de passe"
            type="password"
            required
            minLength={mode === 'signup' ? 8 : 6}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoComplete={mode === 'login' ? 'current-password' : 'new-password'}
          />

          {error && <p className="text-sm text-red-600">{error}</p>}

          <Button type="submit" loading={busy} className="w-full">
            {mode === 'login' ? 'Se connecter' : 'Créer le compte'}
          </Button>

          <button
            type="button"
            onClick={() => {
              setMode(mode === 'login' ? 'signup' : 'login');
              setError(null);
            }}
            className="w-full text-center text-xs text-ink-400 hover:text-ink-600"
          >
            {mode === 'login' ? 'Créer un compte' : "J'ai déjà un compte"}
          </button>
        </form>
      </div>
    </div>
  );
};
