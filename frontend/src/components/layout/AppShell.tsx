import { useState } from 'react';
import { NavLink, Outlet, useNavigate } from 'react-router-dom';
import {
  LayoutDashboard, BookOpenText, Boxes, Users, Plane,
  BadgeDollarSign, BarChart3, Settings, Moon, Sun,
  LogOut, Menu, X, ReceiptText, Wallet, Database,
} from 'lucide-react';
import { useAuth } from '../../context/AuthContext';
import { useTheme } from '../../context/ThemeContext';
import { useCompanySettings } from '../../context/CompanySettingsContext';
import { resolveAssetUrl } from '../../api/client';
import { hasAnyRole, ROLE, RoleName } from '../../lib/roles';

// ── Navigation groups ──────────────────────────────────────────────────────

interface NavConfigItem {
  to: string;
  label: string;
  icon: React.ElementType;
  end?: boolean;
  roles?: RoleName[];
}

const NAV_GROUPS: { label: string; items: NavConfigItem[] }[] = [
  {
    label: 'Overview',
    items: [
      { to: '/', label: 'Dashboard', icon: LayoutDashboard, end: true },
    ],
  },
  {
    label: 'Finance',
    items: [
      { to: '/accounting', label: 'Accounting',  icon: BookOpenText, roles: [ROLE.ADMIN, ROLE.ACCOUNTANT] },
      { to: '/invoices',   label: 'Invoices',    icon: ReceiptText,  roles: [ROLE.ADMIN, ROLE.ACCOUNTANT, ROLE.SALES] },
      { to: '/payments',   label: 'Payments',    icon: Wallet,       roles: [ROLE.ADMIN, ROLE.ACCOUNTANT, ROLE.SALES] },
    ],
  },
  {
    label: 'Operations',
    items: [
      { to: '/bookings',  label: 'Travel Bookings', icon: Plane, roles: [ROLE.ADMIN, ROLE.ACCOUNTANT, ROLE.SALES] },
      { to: '/inventory', label: 'Inventory',        icon: Boxes, roles: [ROLE.ADMIN, ROLE.ACCOUNTANT, ROLE.SALES] },
      { to: '/crm',       label: 'CRM',              icon: Users, roles: [ROLE.ADMIN, ROLE.ACCOUNTANT, ROLE.SALES] },
    ],
  },
  {
    label: 'People',
    items: [
      { to: '/hr', label: 'HR & Payroll', icon: BadgeDollarSign, roles: [ROLE.ADMIN, ROLE.HR] },
    ],
  },
  {
    label: 'System',
    items: [
      { to: '/reports',  label: 'Reports',  icon: BarChart3, roles: [ROLE.ADMIN, ROLE.ACCOUNTANT, ROLE.SALES] },
      { to: '/database', label: 'Database', icon: Database, roles: [ROLE.CEO] },
      { to: '/settings', label: 'Settings', icon: Settings },
    ],
  },
];

// ── NavItem ────────────────────────────────────────────────────────────────

function NavItem({
  to, label, icon: Icon, end, onClick,
}: {
  to: string; label: string;
  icon: React.ElementType;
  end?: boolean; onClick?: () => void;
}) {
  return (
    <NavLink
      to={to} end={end} onClick={onClick}
      className={({ isActive }) =>
        `group flex items-center gap-3 rounded-xl px-3 py-2.5 text-[13px] font-medium transition-all duration-150 ${
          isActive
            ? 'bg-white/[0.13] text-white shadow-[inset_0_1px_0_rgb(255_255_255/0.07)]'
            : 'text-brand-100/55 hover:bg-white/[0.07] hover:text-brand-100/90'
        }`
      }
    >
      {({ isActive }) => (
        <>
          <Icon
            className={`h-[17px] w-[17px] flex-shrink-0 transition-colors ${
              isActive ? 'text-brand-300' : 'text-brand-400/50 group-hover:text-brand-300/80'
            }`}
          />
          <span className="flex-1 truncate">{label}</span>
          {isActive && <span className="h-1.5 w-1.5 flex-shrink-0 rounded-full bg-brand-400" />}
        </>
      )}
    </NavLink>
  );
}

// ── Sidebar body ───────────────────────────────────────────────────────────

function SidebarBody({ onNavigate }: { onNavigate?: () => void }) {
  const { user } = useAuth();
  const { company } = useCompanySettings();
  const logoUrl = resolveAssetUrl(company?.logo_url ?? '/branding/trip-fly-bd-logo.png');

  return (
    <div className="flex h-full flex-col">

      {/* Logo */}
      <div className="px-5 pt-6 pb-4">
        <div className="flex items-center gap-3">
          <div className="relative flex h-9 w-9 flex-shrink-0 items-center justify-center overflow-hidden rounded-xl bg-brand-500/20 ring-1 ring-brand-400/25">
            {logoUrl ? <img src={logoUrl} alt="" className="h-full w-full object-contain" /> : <Plane className="h-[18px] w-[18px] text-brand-300" />}
          </div>
          <div>
            <div className="text-[15px] font-bold leading-none tracking-tight text-white">{company?.name ?? 'Trip Fly BD'}</div>
            <div className="mt-0.5 text-[10px] font-bold uppercase tracking-[0.15em] text-brand-400/60">
              Enterprise ERP
            </div>
          </div>
        </div>
      </div>

      {/* Divider */}
      <div className="mx-5 border-t border-white/[0.07]" />

      {/* Nav */}
      <nav className="flex-1 overflow-y-auto px-3 py-3">
        {NAV_GROUPS.map((group, gi) => (
          <div key={group.label} className={gi > 0 ? 'mt-2' : ''}>
            <div className="mb-1 px-3 text-[10px] font-bold uppercase tracking-[0.14em] text-brand-400/35">
              {group.label}
            </div>
            <div className="space-y-0.5">
              {group.items
                .filter((item) => !item.roles || hasAnyRole(user?.role, item.roles))
                .map((item) => (
                  <NavItem key={item.to} {...item} onClick={onNavigate} />
                ))}
            </div>
          </div>
        ))}
      </nav>

      {/* Footer */}
      <div className="border-t border-white/[0.07] px-5 py-3">
        <div className="text-[10px] font-medium text-brand-400/35">v1.0{company?.address ? ` · ${company.address}` : ''}</div>
      </div>
    </div>
  );
}

// ── AppShell ───────────────────────────────────────────────────────────────

export default function AppShell() {
  const { user, logout } = useAuth();
  const { dark, toggle } = useTheme();
  const { company } = useCompanySettings();
  const [drawer, setDrawer] = useState(false);
  const navigate = useNavigate();

  const initial = user?.name?.[0]?.toUpperCase() ?? '?';

  return (
    <div className="flex min-h-screen">

      {/* ── Desktop sidebar ── */}
      <aside
        className="sticky top-0 hidden h-screen w-[244px] flex-shrink-0 flex-col lg:flex"
        style={{ background: 'linear-gradient(175deg, #042f2e 0%, #061a18 55%, #060f0e 100%)' }}
      >
        <SidebarBody />
      </aside>

      {/* ── Mobile drawer ── */}
      {drawer && (
        <div className="fixed inset-0 z-50 lg:hidden">
          <div
            className="absolute inset-0 bg-black/60 backdrop-blur-sm animate-fade-in"
            onClick={() => setDrawer(false)}
          />
          <aside
            className="absolute inset-y-0 left-0 w-[244px] flex-col animate-slide-in"
            style={{ background: 'linear-gradient(175deg, #042f2e 0%, #061a18 55%, #060f0e 100%)' }}
          >
            <button
              className="absolute right-3 top-4 rounded-lg p-1.5 text-brand-200/60 hover:bg-white/10 hover:text-white transition-colors"
              onClick={() => setDrawer(false)}
              aria-label="Close menu"
            >
              <X className="h-5 w-5" />
            </button>
            <SidebarBody onNavigate={() => setDrawer(false)} />
          </aside>
        </div>
      )}

      {/* ── Content ── */}
      <div className="flex min-w-0 flex-1 flex-col">

        {/* Top header */}
        <header className="sticky top-0 z-30 flex h-14 items-center gap-3 border-b border-slate-200/80 dark:border-slate-800/80 bg-white/85 dark:bg-slate-950/85 px-4 backdrop-blur-xl">
          <button
            className="rounded-xl p-2 text-slate-500 hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors lg:hidden"
            onClick={() => setDrawer(true)}
            aria-label="Open menu"
          >
            <Menu className="h-5 w-5" />
          </button>

          <div className="flex min-w-0 flex-1 items-center gap-3">
            <div className="hidden min-w-0 items-center gap-2.5 sm:flex">
              <div className="h-2 w-2 rounded-full bg-emerald-500 shadow-[0_0_0_4px_rgb(16_185_129/0.12)]" />
              <span className="truncate text-xs font-semibold text-slate-500 dark:text-slate-400">Workspace</span>
              <span className="rounded-full bg-slate-100 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide text-slate-400 dark:bg-slate-800 dark:text-slate-500">Live</span>
            </div>
          </div>

          {/* Theme toggle */}
          <button
            onClick={toggle}
            className="btn-icon"
            aria-label="Toggle dark mode"
          >
            {dark ? <Sun className="h-[17px] w-[17px]" /> : <Moon className="h-[17px] w-[17px]" />}
          </button>

          {/* User info */}
          <div className="hidden items-center gap-3 sm:flex">
            <div className="text-right">
              <div className="text-sm font-semibold leading-tight">{user?.name}</div>
              <div className="text-[10px] font-bold uppercase tracking-wide text-brand-600 dark:text-brand-400">
                {user?.role}
              </div>
            </div>
            <div className="flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-full bg-gradient-to-br from-brand-400 to-brand-700 text-[13px] font-bold text-white ring-2 ring-brand-500/20">
              {initial}
            </div>
          </div>

          {/* Logout */}
          <button
            onClick={async () => { await logout(); navigate('/login'); }}
            className="rounded-xl p-2 text-slate-400 hover:bg-rose-50 dark:hover:bg-rose-950/30 hover:text-rose-600 dark:hover:text-rose-400 transition-all"
            aria-label="Log out"
          >
            <LogOut className="h-[17px] w-[17px]" />
          </button>
        </header>

        {/* Page content */}
        <main className="flex-1 p-4 sm:p-6 animate-fade-in">
          <Outlet />
        </main>
      </div>
    </div>
  );
}
