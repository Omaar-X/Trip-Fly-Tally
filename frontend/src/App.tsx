import { lazy, Suspense, useEffect } from 'react';
import { Navigate, Route, Routes, useLocation } from 'react-router-dom';
import { useAuth } from './context/AuthContext';
import { useCompanySettings } from './context/CompanySettingsContext';
import { resolveAssetUrl } from './api/client';
import AppShell from './components/layout/AppShell';

const Login = lazy(() => import('./pages/Login'));
const CompanySetupWizard = lazy(() => import('./pages/CompanySetupWizard'));
const Dashboard = lazy(() => import('./pages/Dashboard'));
const Accounting = lazy(() => import('./pages/accounting/Accounting'));
const Reports = lazy(() => import('./pages/reports/Reports'));
const Inventory = lazy(() => import('./pages/inventory/Inventory'));
const Crm = lazy(() => import('./pages/crm/Crm'));
const Bookings = lazy(() => import('./pages/bookings/Bookings'));
const Invoices = lazy(() => import('./pages/invoices/Invoices'));
const Payments = lazy(() => import('./pages/payments/Payments'));
const Hr = lazy(() => import('./pages/hr/Hr'));
const Settings = lazy(() => import('./pages/Settings'));
const DatabaseAdmin = lazy(() => import('./pages/admin/DatabaseAdmin'));

function PageLoader() {
  return (
    <div className="flex min-h-[50vh] items-center justify-center">
      <div className="h-8 w-8 animate-spin rounded-full border-2 border-brand-600 border-t-transparent" />
    </div>
  );
}

function Protected({ children }: { children: JSX.Element }) {
  const { user, loading } = useAuth();
  const { needsSetup, loading: companyLoading } = useCompanySettings();
  const location = useLocation();
  if (loading || (user && companyLoading)) {
    return (
      <div className="flex min-h-screen items-center justify-center">
        <div className="h-8 w-8 animate-spin rounded-full border-2 border-brand-600 border-t-transparent" />
      </div>
    );
  }
  if (!user) return <Navigate to="/login" replace state={{ from: location }} />;
  if (needsSetup) return <Navigate to="/setup" replace />;
  return children;
}

function SetupRoute() {
  const { user, loading } = useAuth();
  const { needsSetup, loading: companyLoading } = useCompanySettings();
  if (loading || (user && companyLoading)) {
    return (
      <div className="flex min-h-screen items-center justify-center">
        <div className="h-8 w-8 animate-spin rounded-full border-2 border-brand-600 border-t-transparent" />
      </div>
    );
  }
  if (!user) return <Navigate to="/login" replace />;
  if (!needsSetup) return <Navigate to="/" replace />;
  return <CompanySetupWizard />;
}

function DocumentBranding() {
  const { company } = useCompanySettings();
  useEffect(() => {
    if (!company) return;
    document.title = `${company.name} — ERP`;
    const faviconUrl = resolveAssetUrl(company.favicon_url);
    if (faviconUrl) {
      let link = document.querySelector<HTMLLinkElement>("link[rel='icon']");
      if (!link) {
        link = document.createElement('link');
        link.rel = 'icon';
        document.head.appendChild(link);
      }
      link.href = faviconUrl;
    }
  }, [company]);
  return null;
}

export default function App() {
  return (
    <Suspense fallback={<PageLoader />}>
      <DocumentBranding />
      <Routes>
        <Route path="/login" element={<Login />} />
        <Route path="/setup" element={<SetupRoute />} />
        <Route
          path="/"
          element={
            <Protected>
              <AppShell />
            </Protected>
          }
        >
          <Route index element={<Dashboard />} />
          <Route path="accounting" element={<Accounting />} />
          <Route path="inventory" element={<Inventory />} />
          <Route path="crm" element={<Crm />} />
          <Route path="bookings" element={<Bookings />} />
          <Route path="invoices" element={<Invoices />} />
          <Route path="payments" element={<Payments />} />
          <Route path="hr" element={<Hr />} />
          <Route path="reports" element={<Reports />} />
          <Route path="database" element={<DatabaseAdmin />} />
          <Route path="settings" element={<Settings />} />
        </Route>
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </Suspense>
  );
}
