import { FormEvent, useEffect, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { Plane, Lock, Mail, CheckCircle2, ArrowRight, ShieldCheck } from 'lucide-react';
import { useAuth } from '../context/AuthContext';
import { api, apiErrorMessage, resolveAssetUrl } from '../api/client';
import { ErrorNote } from '../components/ui';
import { ROLES, ROLE, RoleName } from '../lib/roles';

interface PublicBranding { name: string; logo_url: string | null; }

const FEATURES = [
  'Double-Entry Accounting',
  'Travel Bookings & Invoicing',
  'Inventory (FIFO/Avg)',
  'HR & Payroll',
  'CRM & Suppliers',
  'Audit Trail',
];

export default function Login() {
  const { login } = useAuth();
  const navigate = useNavigate();
  const location = useLocation() as { state?: { from?: { pathname?: string } } };

  const [email, setEmail]       = useState('mdrazib69@gmail.com');
  const [password, setPassword] = useState('');
  const [busy, setBusy]         = useState(false);
  const [error, setError]       = useState<string | null>(null);
  const [branding, setBranding] = useState<PublicBranding | null>(null);
  const [registerMode, setRegisterMode] = useState(false);
  const [registerRole, setRegisterRole] = useState<RoleName>(ROLE.SALES);
  const [forgotMode, setForgotMode] = useState(false);
  const [forgotStep, setForgotStep] = useState<'email' | 'otp'>('email');
  const [otp, setOtp] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');

  useEffect(() => {
    api.get('/api/company-settings/public').then((r) => setBranding(r.data.data)).catch(() => {});
  }, []);

  const brandName = branding?.name ?? 'Trip Fly BD';
  const logoUrl = resolveAssetUrl(branding?.logo_url ?? '/branding/trip-fly-bd-logo.png');

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await login(email, password);
      navigate(location.state?.from?.pathname ?? '/', { replace: true });
    } catch (err) {
      setError(apiErrorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  const submitRegistration = async (e: FormEvent) => {
    e.preventDefault(); setBusy(true); setError(null);
    try {
      const form = e.currentTarget as HTMLFormElement;
      await api.post('/api/auth/register', { name: (form.elements.namedItem('regName') as HTMLInputElement).value, email, password, role: registerRole });
      setRegisterMode(false); setError('Registration submitted. CEO approval is required before you can sign in.');
    } catch (err) { setError(apiErrorMessage(err)); }
    finally { setBusy(false); }
  };

  const submitForgotPassword = async (e: FormEvent) => {
    e.preventDefault(); setBusy(true); setError(null);
    try {
      if (forgotStep === 'email') {
        await api.post('/api/auth/forgot-password', { email });
        setForgotStep('otp');
        setError('If this email is registered, a 6-digit reset code has been sent.');
      } else {
        if (newPassword !== confirmPassword) throw new Error('Passwords do not match');
        await api.post('/api/auth/reset-password', { email, otp, password: newPassword });
        setForgotMode(false); setForgotStep('email'); setOtp(''); setNewPassword(''); setConfirmPassword('');
        setError('Password reset successful. You can now sign in.');
      }
    } catch (err) { setError(apiErrorMessage(err)); }
    finally { setBusy(false); }
  };

  return (
    <div className="login-light relative flex min-h-screen overflow-hidden bg-[#f5f6f4] text-slate-900">

      {/* ── Left brand panel ── */}
      <div className="relative hidden w-[52%] flex-col overflow-hidden lg:flex"
           style={{
             backgroundImage: "linear-gradient(145deg, rgb(5 7 12 / 0.97), rgb(35 29 8 / 0.90) 52%, rgb(103 68 0 / 0.72)), url('/airline-hero.png')",
             backgroundPosition: 'center', backgroundSize: 'cover'
           }}>

        {/* Subtle grid pattern */}
        <div className="absolute inset-0"
             style={{ backgroundImage: 'linear-gradient(rgb(255 255 255/0.03) 1px, transparent 1px), linear-gradient(to right, rgb(255 255 255/0.03) 1px, transparent 1px)', backgroundSize: '40px 40px' }} />

        {/* Radial glow accents */}
        <div className="absolute -left-24 -top-24 h-72 w-72 rounded-full bg-yellow-400/12 blur-3xl" />
        <div className="absolute -right-16 bottom-1/3 h-64 w-64 rounded-full bg-amber-400/15 blur-3xl" />
        <div className="absolute left-1/3 bottom-0 h-48 w-48 rounded-full bg-yellow-300/10 blur-2xl" />

        {/* Content */}
        <div className="relative flex h-full flex-col justify-between p-10 xl:p-14">

          {/* Hero */}
          <div>
            <div className="mb-5 inline-flex items-center gap-2 rounded-full border border-yellow-300/30 bg-black/20 px-3 py-1.5 text-[10px] font-bold uppercase tracking-[0.14em] text-yellow-100/90 shadow-[0_8px_30px_rgb(0_0_0/0.16)] backdrop-blur-sm">
              <span className="h-1.5 w-1.5 rounded-full bg-yellow-300 shadow-[0_0_0_4px_rgb(253_224_71/0.14)]" />
              Built for modern travel teams
            </div>
            <div className="mb-3 text-[11px] font-semibold uppercase tracking-[0.25em] text-yellow-300/75">{brandName} · Enterprise ERP</div>
            <h1 className="max-w-md text-3xl font-bold leading-[1.25] text-white drop-shadow-[0_3px_20px_rgb(0_0_0/0.24)] xl:text-4xl">
              Every taka accounted for.<br />Every booking, balanced.
            </h1>
            <p className="mt-4 max-w-sm text-sm leading-relaxed text-slate-200/70">
              Double-entry accounting, travel bookings, inventory, CRM, HR &amp; payroll —
              one ledger of truth for the whole agency.
            </p>

            {/* Feature checklist */}
          <ul className="mt-7 space-y-2.5">
              {FEATURES.map((f) => (
                <li key={f} className="flex items-center gap-2.5 text-sm text-slate-200/80">
                  <CheckCircle2 className="h-4 w-4 flex-shrink-0 text-amber-300" />
                  {f}
                </li>
              ))}
            </ul>
          </div>

          <div>
            <div className="mb-5 flex flex-wrap gap-2">
              {['Audit-ready', 'BDT-ready', 'Role-based'].map((tag) => (
                <span key={tag} className="rounded-full border border-white/10 bg-white/[0.06] px-3 py-1.5 text-[10px] font-medium tracking-wide text-slate-200/70 backdrop-blur-sm">{tag}</span>
              ))}
            </div>
            <div className="flex items-center gap-2 text-[11px] text-slate-300/50">
              <ShieldCheck className="h-3.5 w-3.5 text-amber-300/70" />
              © {new Date().getFullYear()} {brandName}
            </div>
          </div>
        </div>
      </div>

      {/* ── Right form panel ── */}
      <div className="relative flex flex-1 items-center justify-center overflow-hidden p-5 sm:p-8 lg:p-12"
           style={{
             backgroundImage: "linear-gradient(125deg, rgb(255 253 241 / 0.97), rgb(255 245 194 / 0.88) 48%, rgb(244 222 151 / 0.82)), url('/airline-hero.png')",
             backgroundPosition: 'center', backgroundSize: 'cover'
           }}>
        <div className="pointer-events-none absolute -right-24 -top-24 h-72 w-72 rounded-full bg-yellow-400/24 blur-3xl" />
        <div className="pointer-events-none absolute -bottom-32 -left-20 h-80 w-80 rounded-full bg-amber-300/18 blur-3xl" />
        <div className="pointer-events-none absolute left-1/3 top-0 h-52 w-52 rounded-full bg-yellow-200/18 blur-3xl" />
        <div className="pointer-events-none absolute inset-0 opacity-25"
             style={{ backgroundImage: 'radial-gradient(rgb(255 255 255 / 0.9) 1px, transparent 1px)', backgroundSize: '22px 22px' }} />
        <div className="pointer-events-none absolute right-[12%] top-[14%] h-40 w-40 rounded-full border border-yellow-500/20" />
        <div className="pointer-events-none absolute right-[14%] top-[16%] h-32 w-32 rounded-full border border-yellow-500/15" />
        <div className="relative w-full max-w-[430px] overflow-hidden rounded-[30px] border border-yellow-400/65 bg-[#fffdf6]/94 p-6 shadow-[0_30px_100px_rgb(66_46_0/0.20),0_0_0_1px_rgb(255_255_255/0.8)_inset] backdrop-blur-2xl sm:p-8">
          <div className="absolute inset-x-0 top-0 h-1 bg-gradient-to-r from-black via-yellow-400 to-black" />

          {/* Mobile logo */}
          <div className="mb-6 flex items-center gap-3 border-b border-slate-200/80 pb-6">
            <span className="flex h-14 w-14 flex-shrink-0 items-center justify-center overflow-hidden rounded-full bg-slate-950 ring-4 ring-white shadow-[0_8px_24px_rgb(234_179_8/0.30)]">
              {logoUrl ? <img src={logoUrl} alt={`${brandName} logo`} className="h-full w-full object-contain" /> : <Plane className="h-5 w-5 text-yellow-200" />}
            </span>
            <div>
              <div className="text-sm font-bold tracking-tight">{brandName}</div>
              <div className="mt-0.5 text-[10px] font-semibold uppercase tracking-[0.12em] text-amber-700/80">Enterprise ERP · Travel & Finance</div>
            </div>
          </div>

          <div className="mb-1 inline-flex items-center gap-1.5 rounded-full border border-yellow-300/60 bg-yellow-100/80 px-2.5 py-1 text-[10px] font-bold uppercase tracking-[0.14em] text-amber-900"><Lock className="h-3 w-3" /> Secure workspace</div>
          <h2 className="mt-3 text-2xl font-bold tracking-tight">{registerMode ? 'Create your account' : forgotMode ? 'Reset your password' : 'Welcome back'}</h2>
          <p className="mt-1.5 text-sm text-slate-500">
            Sign in with your company credentials.
          </p>

          <form onSubmit={registerMode ? submitRegistration : forgotMode ? submitForgotPassword : submit} className="mt-7 space-y-4">
            {registerMode && <label className="block"><span className="label">Full name</span><input name="regName" className="input !border-slate-200 !bg-white !text-slate-800" required minLength={2} /></label>}
            <label className="block">
              <span className="label">Email address</span>
              <div className="relative">
                <Mail className="pointer-events-none absolute left-3.5 top-1/2 -translate-y-1/2 h-4 w-4 text-slate-400" />
                <input
                  className="input login-brand-input !border-slate-200 !bg-white !text-slate-800 pl-10"
                  type="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  required
                  autoComplete="username"
                />
              </div>
            </label>

            {registerMode && <label className="block"><span className="label">Apply for role</span><select className="input !border-slate-200 !bg-white !text-slate-800" value={registerRole} onChange={(e) => setRegisterRole(e.target.value as RoleName)}>{ROLES.filter((r) => r !== ROLE.CEO).map((r) => <option key={r} value={r}>{r}</option>)}</select></label>}

            {forgotMode ? forgotStep === 'otp' ? <>
              <label className="block"><span className="label">Email OTP</span><input className="input !border-slate-200 !bg-white !text-slate-800 tracking-[0.35em]" inputMode="numeric" maxLength={6} value={otp} onChange={(e) => setOtp(e.target.value.replace(/\D/g, ''))} required /></label>
              <label className="block"><span className="label">New password</span><input className="input !border-slate-200 !bg-white !text-slate-800" type="password" minLength={8} value={newPassword} onChange={(e) => setNewPassword(e.target.value)} required autoComplete="new-password" /></label>
              <label className="block"><span className="label">Confirm new password</span><input className="input !border-slate-200 !bg-white !text-slate-800" type="password" minLength={8} value={confirmPassword} onChange={(e) => setConfirmPassword(e.target.value)} required autoComplete="new-password" /></label>
            </> : <p className="rounded-xl bg-yellow-50 p-3 text-sm text-amber-900">Enter your registered email. We’ll send a one-time code to it.</p> : <label className="block">
              <span className="label">Password</span>
              <div className="relative">
                <Lock className="pointer-events-none absolute left-3.5 top-1/2 -translate-y-1/2 h-4 w-4 text-slate-400" />
                <input className="input login-brand-input !border-slate-200 !bg-white !text-slate-800 pl-10" type="password" value={password} onChange={(e) => setPassword(e.target.value)} required autoComplete="current-password" />
              </div>
            </label>}

            <ErrorNote message={error} />

            <button className="btn-primary login-brand-button w-full py-3" disabled={busy}>
              {busy ? (
                <span className="inline-flex items-center gap-2">
                  <span className="h-4 w-4 animate-spin rounded-full border-2 border-white/30 border-t-white" />
                  Signing in…
                </span>
              ) : <span className="inline-flex items-center gap-2">{registerMode ? 'Submit registration' : forgotMode ? forgotStep === 'email' ? 'Send OTP' : 'Reset password' : 'Sign in'} <ArrowRight className="h-4 w-4" /></span>}
            </button>
          </form>

          {!registerMode && !forgotMode && <button type="button" className="mt-3 w-full text-sm text-amber-800 hover:underline" onClick={() => { setForgotMode(true); setError(null); }}>Forgot password?</button>}
          <button type="button" className="mt-4 w-full text-sm text-amber-800 hover:underline" onClick={() => { setRegisterMode((v) => !v); setForgotMode(false); setForgotStep('email'); setError(null); }}>
            {registerMode ? 'Already registered? Sign in' : forgotMode ? 'Back to sign in' : 'Need an account? Register for approval'}
          </button>

          <p className="mt-7 text-center text-xs text-slate-400">
            Accountant, Admin, Sales and HR accounts require CEO approval after registration.
          </p>

        </div>
      </div>
    </div>
  );
}
