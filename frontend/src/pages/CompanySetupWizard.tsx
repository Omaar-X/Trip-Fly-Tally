import { Plane, ShieldAlert } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import CompanyForm from '../components/company/CompanyForm';
import { ROLE } from '../lib/roles';

export default function CompanySetupWizard() {
  const { user } = useAuth();
  const navigate = useNavigate();
  const isCeo = user?.role === ROLE.CEO;

  return (
    <div className="flex min-h-screen items-center justify-center bg-slate-100 p-6 dark:bg-[#060c16]">
      <div className="w-full max-w-2xl">
        <div className="mb-6 flex items-center gap-3">
          <span className="flex h-10 w-10 items-center justify-center rounded-xl bg-brand-600 text-white">
            <Plane className="h-5 w-5" />
          </span>
          <div>
            <h1 className="text-xl font-bold tracking-tight">Company setup</h1>
            <p className="text-sm text-slate-500 dark:text-slate-400">One-time setup before the ERP is ready to use.</p>
          </div>
        </div>

        <div className="card p-6">
          {isCeo ? (
            <CompanyForm variant="wizard" onSaved={() => navigate('/', { replace: true })} />
          ) : (
            <div className="flex items-center gap-3 rounded-xl border border-amber-200 bg-amber-50 px-4 py-4 dark:border-amber-900/50 dark:bg-amber-950/30">
              <ShieldAlert className="h-5 w-5 flex-shrink-0 text-amber-600 dark:text-amber-400" />
              <p className="text-sm text-amber-800 dark:text-amber-200">
                Your company profile hasn't been set up yet. Ask the CEO to sign in and finish setup before you continue.
              </p>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
