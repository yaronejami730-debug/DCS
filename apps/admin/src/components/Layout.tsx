import { NavLink, Outlet, useNavigate } from 'react-router-dom';
import { useAuth } from '../lib/auth';
import { useRealtime } from '../lib/useRealtime';
import { Button } from './ui';

const NAV = [
  { to: '/dashboard', label: 'Tableau de bord' },
  { to: '/folders', label: 'Dossiers' },
  { to: '/templates', label: 'Templates' },
  { to: '/attestation', label: 'Attestation simplifiée' },
  { to: '/guide', label: 'Guide' },
];

export const Layout = () => {
  const { session, signOut } = useAuth();
  const navigate = useNavigate();
  // Opened once for the whole console, so every page updates live.
  const { connected } = useRealtime();

  return (
    <div className="flex min-h-full">
      <aside className="flex w-60 shrink-0 flex-col border-r border-ink-200/70 bg-white">
        <div className="px-5 py-5">
          <p className="text-base font-semibold tracking-tight">
            Scan<span className="text-brand-600">&amp;</span>Sign
          </p>
          <p className="mt-0.5 text-xs text-ink-400">Console administrateur</p>
        </div>
        <nav className="flex flex-1 flex-col gap-1 px-3">
          {NAV.map((item) => (
            <NavLink
              key={item.to}
              to={item.to}
              className={({ isActive }) =>
                `rounded-lg px-3 py-2 text-sm font-medium transition ${
                  isActive ? 'bg-brand-50 text-brand-600' : 'text-ink-600 hover:bg-ink-100'
                }`
              }
            >
              {item.label}
            </NavLink>
          ))}
        </nav>
        <div className="border-t border-ink-200/70 p-3">
          <div className="flex items-center gap-1.5 px-2 pb-1">
            <span
              className={`h-1.5 w-1.5 rounded-full ${
                connected ? 'bg-emerald-500' : 'bg-ink-200'
              }`}
            />
            <span className="text-[11px] text-ink-400">
              {connected ? 'Temps réel actif' : 'Reconnexion…'}
            </span>
          </div>
          <p className="truncate px-2 text-xs text-ink-400">{session?.user.email}</p>
          <Button
            variant="ghost"
            className="mt-1 w-full justify-start"
            onClick={() => {
              signOut();
              navigate('/login');
            }}
          >
            Se déconnecter
          </Button>
        </div>
      </aside>
      <main className="flex-1 overflow-x-hidden">
        <Outlet />
      </main>
    </div>
  );
};

export const Page = ({
  title,
  description,
  actions,
  children,
}: {
  title: string;
  description?: string;
  actions?: React.ReactNode;
  children: React.ReactNode;
}) => (
  <div className="mx-auto max-w-7xl px-8 py-8">
    <header className="mb-6 flex flex-wrap items-start justify-between gap-3">
      <div>
        <h1 className="text-xl font-semibold tracking-tight">{title}</h1>
        {description && <p className="mt-1 text-sm text-ink-400">{description}</p>}
      </div>
      {actions && <div className="flex gap-2">{actions}</div>}
    </header>
    {children}
  </div>
);
