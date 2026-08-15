import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';

let mockRole: string | undefined;

vi.mock('../../src/context/AuthContext', () => ({
  useAuth: () => ({ user: mockRole ? { name: 'Test User', role: mockRole } : null, logout: vi.fn() }),
}));
vi.mock('../../src/context/ThemeContext', () => ({
  useTheme: () => ({ dark: false, toggle: vi.fn() }),
}));
vi.mock('../../src/context/CompanySettingsContext', () => ({
  useCompanySettings: () => ({ company: { name: 'Acme Travel', logo_url: null, address: null }, loading: false, needsSetup: false, refresh: vi.fn() }),
}));
vi.mock('../../src/api/client', () => ({
  resolveAssetUrl: () => null,
}));

import AppShell from '../../src/components/layout/AppShell';

const ALL_LABELS = [
  'Dashboard', 'Accounting', 'Invoices', 'Payments',
  'Travel Bookings', 'Inventory', 'CRM', 'HR & Payroll',
  'Reports', 'Database', 'Settings',
];

function renderShellAs(role: string) {
  mockRole = role;
  return render(
    <MemoryRouter initialEntries={['/']}>
      <Routes>
        <Route path="/" element={<AppShell />}>
          <Route index element={<div>page content</div>} />
        </Route>
      </Routes>
    </MemoryRouter>
  );
}

function visibleLabels() {
  return ALL_LABELS.filter((label) => screen.queryByText(label) !== null);
}

describe('AppShell navigation visibility (role-gated, hasAnyRole-driven)', () => {
  it('CEO sees every nav item — the sole superuser bypass', () => {
    renderShellAs('CEO');
    expect(visibleLabels().sort()).toEqual([...ALL_LABELS].sort());
  });

  it('HR sees only Dashboard, HR & Payroll, and Settings', () => {
    renderShellAs('HR');
    expect(visibleLabels().sort()).toEqual(['Dashboard', 'HR & Payroll', 'Settings'].sort());
  });

  it('SALES sees operational/finance-adjacent items but not Accounting, HR, or Database', () => {
    renderShellAs('SALES');
    const visible = visibleLabels();
    expect(visible).toEqual(expect.arrayContaining(['Dashboard', 'Invoices', 'Payments', 'Travel Bookings', 'Inventory', 'CRM', 'Reports', 'Settings']));
    expect(visible).not.toContain('Accounting');
    expect(visible).not.toContain('HR & Payroll');
    expect(visible).not.toContain('Database');
  });

  it('renders dynamic company branding in the sidebar, not a hardcoded product name', () => {
    renderShellAs('CEO');
    expect(screen.getByText('Acme Travel')).toBeInTheDocument();
    expect(screen.queryByText(/trip fly/i)).not.toBeInTheDocument();
  });
});
