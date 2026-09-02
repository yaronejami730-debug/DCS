import { useEffect, useState } from 'react';
import { NavLink, Outlet, useLocation, useNavigate } from 'react-router-dom';
import { useAuth } from '../lib/auth';
import { useRealtime } from '../lib/useRealtime';
import { Button } from './ui';

const NAV = [
  { to: '/dashboard', label: 'Tableau de bord' },
  { to: '/folders', label: 'Dossiers' },
  { to: '/clients', label: 'Clients' },
  { to: '/templates', label: 'Templates' },
  { to: '/attestation', label: 'Attestation simplifiée' },
  { to: '/guide', label: 'Guide' },
];

/**
 * The console shell, responsive.
 *
 * On a wide screen the sidebar is fixed and always visible. On a phone it
 * becomes a slide-in drawer behind a top bar with a hamburger: the 240px
 * sidebar would otherwise eat two thirds of a 375px screen. The drawer closes
 * on navigation and on the backdrop, so it never traps the operator.
 */
export const Layout = () => {
  const { session, signOut } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const { connected } = useRealtime();
  const [drawer, setDrawer] = useState(false);

  // Close the mobile drawer whenever the route changes.
  useEffect(() => setDrawer(false), [location.pathname]);

  const sidebar = (
    <>
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
            className={`h-1.5 w-1.5 rounded-full ${connected ? 'bg-emerald-500' : 'bg-ink-200'}`}
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
    </>
  );

  return (
    <div className="flex min-h-full">
      {/* Desktop sidebar */}
      <aside className="hidden w-60 shrink-0 flex-col border-r border-ink-200/70 bg-white lg:flex">
        {sidebar}
      </aside>

      {/* Mobile drawer + backdrop */}
      {drawer && (
        <div className="fixed inset-0 z-40 lg:hidden">
          <div
            className="absolute inset-0 bg-ink-900/40"
            onClick={() => setDrawer(false)}
            aria-hidden
          />
          <aside className="absolute inset-y-0 left-0 flex w-64 max-w-[80vw] flex-col bg-white shadow-xl">
            {sidebar}
          </aside>
        </div>
      )}

      <div className="flex min-w-0 flex-1 flex-col">
        {/* Mobile top bar */}
        <header className="flex items-center gap-3 border-b border-ink-200/70 bg-white px-4 py-3 lg:hidden">
          <button
            onClick={() => setDrawer(true)}
            aria-label="Menu"
            className="flex h-9 w-9 items-center justify-center rounded-lg text-ink-600 hover:bg-ink-100"
          >
            <span className="text-xl leading-none">☰</span>
          </button>
          <p className="text-sm font-semibold tracking-tight">
            Scan<span className="text-brand-600">&amp;</span>Sign
          </p>
        </header>

        <main className="min-w-0 flex-1 overflow-x-hidden">
          <Outlet />
        </main>
      </div>
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
  <div className="mx-auto max-w-7xl px-4 py-6 sm:px-6 lg:px-8 lg:py-8">
    <header className="mb-6 flex flex-wrap items-start justify-between gap-3">
      <div className="min-w-0">
        <h1 className="text-lg font-semibold tracking-tight sm:text-xl">{title}</h1>
        {description && <p className="mt-1 text-sm text-ink-400">{description}</p>}
      </div>
      {actions && <div className="flex flex-wrap gap-2">{actions}</div>}
    </header>
    {children}
  </div>
);
