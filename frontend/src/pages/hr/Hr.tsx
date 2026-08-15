import { FormEvent, useEffect, useState } from 'react';
import { Plus, Users, BadgeDollarSign, FileDown, Pencil, PlayCircle, CheckCircle2, Banknote, Undo2 } from 'lucide-react';
import { api, apiErrorMessage, openPdf } from '../../api/client';
import { useAuth } from '../../context/AuthContext';
import { Badge, Column, DataTable, ErrorNote, Field, Modal, Money, PageHeader, Spinner, statusTone } from '../../components/ui';
import { bdt, fmtDate } from '../../lib/format';
import { hasAnyRole, ROLE } from '../../lib/roles';

// Attendance is kept in a separate system, so this ERP does not own it. Payroll
// takes the deduction as a figure computed there rather than deriving one.
type Tab = 'employees' | 'payroll';

interface Employee {
  id: number; emp_code: string; name: string; designation: string | null; department: string | null;
  phone: string | null; email: string | null; joining_date: string | null;
  basic_salary: string; house_rent: string; medical_allow: string; conveyance: string;
  commission_rate: string; gross_salary: string; is_active: number;
}
interface Run {
  id: number; period_year: number; period_month: number; status: string;
  total_net: string; employees: number; voucher_no: string | null;
}
interface RunDetail extends Run {
  total_deduction?: string;
  payslips: {
    id: number; emp_code: string; name: string; designation: string | null;
    basic: string; allowances: string; gross: string;
    commission: string; deduction: string; net_pay: string;
  }[];
}

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

export default function Hr() {
  const { user } = useAuth();
  const role = user?.role;
  // Employee management is HR's core scope, Admin has oversight.
  const canManageEmployees = hasAnyRole(role, [ROLE.HR, ROLE.ADMIN]);
  // Payroll is not part of HR's scope at all (nor Accountant's — Accountant cannot access HR/payroll);
  // it's an Admin operational responsibility, with final approval reserved for the CEO.
  const canViewPayroll = hasAnyRole(role, [ROLE.ADMIN]);
  const canApprovePayroll = role === ROLE.CEO;
  const canPay = hasAnyRole(role, [ROLE.ADMIN]);
  const [tab, setTab] = useState<Tab>('employees');

  const tabs: { id: Tab; label: string; icon: JSX.Element }[] = [
    { id: 'employees', label: 'Employees', icon: <Users className="h-4 w-4" /> },
    { id: 'payroll', label: 'Payroll', icon: <BadgeDollarSign className="h-4 w-4" /> }
  ];

  return (
    <div>
      <PageHeader title="HR & Payroll" sub="Salaries, agent commissions and payslips — posted straight into the books." />
      <div className="mb-4 flex gap-1 rounded-xl border border-slate-200 bg-white p-1 dark:border-slate-800 dark:bg-slate-900 w-fit">
        {tabs.map((t) => (
          <button key={t.id} onClick={() => setTab(t.id)}
            className={`flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-sm font-medium transition
              ${tab === t.id ? 'bg-brand-950 text-white shadow' : 'text-slate-600 hover:bg-slate-100 dark:text-slate-300 dark:hover:bg-slate-800'}`}>
            {t.icon}{t.label}
          </button>
        ))}
      </div>

      {tab === 'employees' && <EmployeesTab isManager={canManageEmployees} />}
      {tab === 'payroll' && <PayrollTab canView={canViewPayroll} canApprove={canApprovePayroll} canPay={canPay} />}
    </div>
  );
}

// ================================ Employees ==================================

function EmployeesTab({ isManager }: { isManager: boolean }) {
  const [rows, setRows] = useState<Employee[]>([]);
  const [loading, setLoading] = useState(true);
  const [refresh, setRefresh] = useState(0);
  const [editing, setEditing] = useState<Employee | null>(null);
  const [createOpen, setCreateOpen] = useState(false);

  useEffect(() => {
    setLoading(true);
    api.get('/api/hr/employees').then((r) => setRows(r.data.data)).finally(() => setLoading(false));
  }, [refresh]);

  const columns: Column<Employee>[] = [
    { key: 'emp_code', header: 'Code', render: (e) => <span className="num text-xs font-semibold">{e.emp_code}</span> },
    { key: 'name', header: 'Employee', render: (e) => (
        <div><div className="font-medium">{e.name}</div><div className="text-xs text-slate-400">{e.designation ?? '—'} · {e.department ?? '—'}</div></div>) },
    { key: 'joining_date', header: 'Joined', render: (e) => <span className="num">{e.joining_date ? fmtDate(e.joining_date) : '—'}</span> },
    { key: 'gross_salary', header: 'Gross salary', align: 'right', render: (e) => <Money value={e.gross_salary} />, sortValue: (e) => Number(e.gross_salary) },
    { key: 'commission_rate', header: 'Commission', align: 'right', render: (e) => <span className="num">{Number(e.commission_rate)}%</span> },
    { key: 'is_active', header: 'Status', render: (e) => <Badge tone={e.is_active ? 'green' : 'slate'}>{e.is_active ? 'ACTIVE' : 'INACTIVE'}</Badge> },
    { key: 'actions', header: '', align: 'right', render: (e) => isManager ? (
        <button className="btn btn-ghost !px-2 !py-1 text-xs" onClick={() => setEditing(e)}><Pencil className="h-3.5 w-3.5" /> Edit</button>) : null }
  ];

  return (
    <>
      <div className="mb-3 flex justify-end">
        {isManager && <button className="btn btn-primary" onClick={() => setCreateOpen(true)}><Plus className="h-4 w-4" /> New employee</button>}
      </div>
      <DataTable columns={columns} rows={rows} loading={loading} empty="No employees yet." />
      <EmployeeModal open={createOpen || !!editing} employee={editing}
        onClose={() => { setCreateOpen(false); setEditing(null); }}
        onDone={() => { setCreateOpen(false); setEditing(null); setRefresh(r => r + 1); }} />
    </>
  );
}

function EmployeeModal({ open, employee, onClose, onDone }:
  { open: boolean; employee: Employee | null; onClose: () => void; onDone: () => void }) {
  const blank = { empCode: '', name: '', designation: '', department: '', phone: '', email: '', joiningDate: '', basicSalary: '', houseRent: '0', medicalAllow: '0', conveyance: '0', commissionRate: '0', isActive: true };
  const [form, setForm] = useState(blank);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (employee) {
      setForm({
        empCode: employee.emp_code, name: employee.name,
        designation: employee.designation ?? '', department: employee.department ?? '',
        phone: employee.phone ?? '', email: employee.email ?? '',
        joiningDate: employee.joining_date ? employee.joining_date.slice(0, 10) : '',
        basicSalary: String(Number(employee.basic_salary)), houseRent: String(Number(employee.house_rent)),
        medicalAllow: String(Number(employee.medical_allow)), conveyance: String(Number(employee.conveyance)),
        commissionRate: String(Number(employee.commission_rate)), isActive: !!employee.is_active
      });
    } else setForm(blank);
    setError(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [employee, open]);

  const set = (k: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement>) =>
    setForm({ ...form, [k]: e.target.value });

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true); setError(null);
    try {
      const payload = {
        empCode: form.empCode, name: form.name,
        designation: form.designation || undefined, department: form.department || undefined,
        phone: form.phone || undefined, email: form.email || undefined,
        joiningDate: form.joiningDate || undefined,
        basicSalary: Number(form.basicSalary) || 0, houseRent: Number(form.houseRent) || 0,
        medicalAllow: Number(form.medicalAllow) || 0, conveyance: Number(form.conveyance) || 0,
        commissionRate: Number(form.commissionRate) || 0
      };
      if (employee) await api.patch(`/api/hr/employees/${employee.id}`, { ...payload, isActive: form.isActive });
      else await api.post('/api/hr/employees', payload);
      onDone();
    } catch (err) { setError(apiErrorMessage(err)); }
    finally { setBusy(false); }
  };

  return (
    <Modal open={open} onClose={onClose} title={employee ? `Edit ${employee.name}` : 'New Employee'} wide>
      <form onSubmit={submit} className="space-y-4">
        <div className="grid grid-cols-2 gap-3">
          <Field label="Employee code"><input className="input num" value={form.empCode} onChange={set('empCode')} required placeholder="EMP-004" /></Field>
          <Field label="Full name"><input className="input" value={form.name} onChange={set('name')} required minLength={2} /></Field>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Designation"><input className="input" value={form.designation} onChange={set('designation')} placeholder="e.g. Ticketing Officer" /></Field>
          <Field label="Department"><input className="input" value={form.department} onChange={set('department')} placeholder="e.g. Sales" /></Field>
        </div>
        <div className="grid grid-cols-3 gap-3">
          <Field label="Phone"><input className="input num" value={form.phone} onChange={set('phone')} /></Field>
          <Field label="Email"><input className="input" type="email" value={form.email} onChange={set('email')} /></Field>
          <Field label="Joining date"><input type="date" className="input num" value={form.joiningDate} onChange={set('joiningDate')} /></Field>
        </div>
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-5">
          <Field label="Basic (৳)"><input className="input num" type="number" min="0" step="0.01" value={form.basicSalary} onChange={set('basicSalary')} required /></Field>
          <Field label="House rent"><input className="input num" type="number" min="0" step="0.01" value={form.houseRent} onChange={set('houseRent')} /></Field>
          <Field label="Medical"><input className="input num" type="number" min="0" step="0.01" value={form.medicalAllow} onChange={set('medicalAllow')} /></Field>
          <Field label="Conveyance"><input className="input num" type="number" min="0" step="0.01" value={form.conveyance} onChange={set('conveyance')} /></Field>
          <Field label="Commission %" hint="On booking margin"><input className="input num" type="number" min="0" max="100" step="0.5" value={form.commissionRate} onChange={set('commissionRate')} /></Field>
        </div>
        {employee && (
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={form.isActive} onChange={(e) => setForm({ ...form, isActive: e.target.checked })}
              className="h-4 w-4 rounded border-slate-300 text-brand-600 focus:ring-brand-500" />
            Active employee (included in payroll)
          </label>
        )}
        <ErrorNote message={error} />
        <div className="flex justify-end gap-2">
          <button type="button" className="btn btn-ghost" onClick={onClose}>Cancel</button>
          <button className="btn btn-primary" disabled={busy}>{busy ? 'Saving…' : employee ? 'Save changes' : 'Create employee'}</button>
        </div>
      </form>
    </Modal>
  );
}


// ================================ Payroll ====================================

function PayrollTab({ canView, canApprove, canPay }: { canView: boolean; canApprove: boolean; canPay: boolean }) {
  const now = new Date();
  const [runs, setRuns] = useState<Run[]>([]);
  const [loading, setLoading] = useState(true);
  const [refresh, setRefresh] = useState(0);
  const [year, setYear] = useState(now.getFullYear());
  const [month, setMonth] = useState(now.getMonth() + 1);
  const [detail, setDetail] = useState<RunDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [staff, setStaff] = useState<Employee[]>([]);
  const [deductions, setDeductions] = useState<Record<number, string>>({});

  useEffect(() => {
    if (!canView) { setLoading(false); return; }
    setLoading(true);
    Promise.all([api.get('/api/hr/payroll'), api.get('/api/hr/employees')])
      .then(([r, e]) => {
        setRuns(r.data.data);
        setStaff((e.data.data as Employee[]).filter((x) => x.is_active));
      })
      .finally(() => setLoading(false));
  }, [refresh, canView]);

  if (!canView) {
    return (
      <div className="card p-8 text-center text-sm text-slate-400">
        Payroll is managed by Admins, with final approval by the CEO.
      </div>
    );
  }

  const openDetail = (id: number) => api.get(`/api/hr/payroll/${id}`).then((r) => setDetail(r.data.data));

  const act = async (label: string, fn: () => Promise<unknown>) => {
    setBusy(label); setError(null);
    try {
      await fn();
      setRefresh((r) => r + 1);
      if (detail) await openDetail(detail.id);
    } catch (err) { setError(apiErrorMessage(err)); }
    finally { setBusy(null); }
  };

  /**
   * Deductions are entered here as taka, per employee — absence, late marks
   * and unpaid leave are all worked out in whatever system owns attendance,
   * and only the resulting figure reaches the books.
   */
  const generate = () =>
    act('generate', () => api.post('/api/hr/payroll/generate', {
      year, month,
      deductions: Object.fromEntries(
        Object.entries(deductions)
          .map(([id, v]) => [id, Number(v) || 0])
          .filter(([, v]) => (v as number) > 0)),
    }));

  const columns: Column<Run>[] = [
    { key: 'period', header: 'Period', render: (r) => <span className="num font-medium">{MONTHS[r.period_month - 1]} {r.period_year}</span>,
      sortValue: (r) => r.period_year * 100 + r.period_month },
    { key: 'employees', header: 'Employees', align: 'right', render: (r) => <span className="num">{r.employees}</span> },
    { key: 'total_net', header: 'Total net pay', align: 'right', render: (r) => <Money value={r.total_net} />, sortValue: (r) => Number(r.total_net) },
    { key: 'status', header: 'Status', render: (r) => (
        <div className="flex flex-col items-start gap-0.5">
          <Badge tone={statusTone(r.status)}>{r.status}</Badge>
          {r.voucher_no && <span className="num text-[10px] text-slate-400">{r.voucher_no}</span>}
        </div>) },
    { key: 'actions', header: '', align: 'right', render: (r) => (
        <button className="btn btn-ghost !px-2 !py-1 text-xs" onClick={() => openDetail(r.id)}>Open</button>) }
  ];

  return (
    <div className="space-y-4">
      <div className="card p-5">
        <div className="flex flex-wrap items-end gap-3">
          <Field label="Month">
            <select className="input !w-auto" value={month} onChange={(e) => setMonth(Number(e.target.value))}>
              {MONTHS.map((m, i) => <option key={m} value={i + 1}>{m}</option>)}
            </select>
          </Field>
          <Field label="Year">
            <input className="input num !w-28" type="number" min="2020" max="2100" value={year} onChange={(e) => setYear(Number(e.target.value))} />
          </Field>
          <button className="btn btn-primary" onClick={generate} disabled={busy === 'generate' || staff.length === 0}>
            <PlayCircle className="h-4 w-4" /> {busy === 'generate' ? 'Computing…' : 'Generate run'}
          </button>
        </div>

        {/* Deductions are typed, not derived: attendance is kept elsewhere, so
            this ERP records the figure rather than pretending to compute it. */}
        {staff.length > 0 && (
          <div className="mt-4">
            <h3 className="mb-1 text-xs font-bold uppercase tracking-wide text-slate-500">
              Deductions for this month
            </h3>
            <p className="mb-3 text-xs text-slate-400">
              Absence, late marks and unpaid leave are worked out in your attendance system — enter the
              resulting taka figure here. Leave blank for a full month's pay.
            </p>
            <div className="space-y-1.5">
              {staff.map((e) => {
                const gross = Number(e.gross_salary);
                const ded = Number(deductions[e.id]) || 0;
                return (
                  <div key={e.id} className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-slate-100 px-3 py-2 dark:border-slate-800">
                    <div className="text-sm">
                      <span className="num text-xs text-slate-400">{e.emp_code}</span>{' '}
                      <span className="font-medium">{e.name}</span>
                      <span className="ml-2 num text-xs text-slate-400">gross {bdt(gross)}</span>
                    </div>
                    <div className="flex items-center gap-2">
                      <span className="text-xs text-slate-400">− ৳</span>
                      <input className="input num !w-32 !py-1 text-right" type="number" min="0" step="0.01"
                        placeholder="0.00" value={deductions[e.id] ?? ''}
                        onChange={(ev) => setDeductions({ ...deductions, [e.id]: ev.target.value })} />
                      <span className="num w-28 text-right text-xs text-slate-500">
                        = {bdt(Math.max(0, gross - ded))}
                      </span>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        )}

        <p className="mt-3 text-xs text-slate-400">
          Net pay = basic + allowances + commission on the margin of bookings invoiced this month − deduction.
          Regenerating is allowed while the run is still DRAFT.
        </p>
      </div>
      <ErrorNote message={error} />
      <DataTable columns={columns} rows={runs} loading={loading} empty="No payroll runs yet — generate one above." />

      <Modal open={!!detail} onClose={() => setDetail(null)} title={detail ? `Payroll — ${MONTHS[detail.period_month - 1]} ${detail.period_year}` : ''} wide>
        {detail && (
          <div className="space-y-4">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div className="flex items-center gap-2">
                <Badge tone={statusTone(detail.status)}>{detail.status}</Badge>
                {detail.voucher_no && <span className="num text-xs text-slate-400">Voucher {detail.voucher_no}</span>}
              </div>
              <div className="flex gap-2">
                {canApprove && detail.status === 'DRAFT' && (
                  <button className="btn btn-primary" disabled={busy === 'approve'}
                    onClick={() => act('approve', () => api.post(`/api/hr/payroll/${detail.id}/approve`))}>
                    <CheckCircle2 className="h-4 w-4" /> {busy === 'approve' ? 'Posting…' : 'CEO Approve & accrue'}
                  </button>)}
                {!canApprove && detail.status === 'DRAFT' && (
                  <span className="text-xs text-slate-400">Awaiting CEO approval</span>)}
                {/* Approval used to be one-way: an accrual posted in error sat
                    on the books forever with the run frozen out of
                    regeneration. Un-approving reverses it and returns the run
                    to DRAFT. */}
                {canApprove && detail.status === 'APPROVED' && (
                  <button className="btn btn-ghost" disabled={busy === 'unapprove'}
                    onClick={() => act('unapprove', () => api.post(`/api/hr/payroll/${detail.id}/unapprove`,
                      { reason: 'Approved in error — returning to draft' }))}>
                    <Undo2 className="h-4 w-4" /> {busy === 'unapprove' ? 'Reversing…' : 'Un-approve'}
                  </button>)}
                {canPay && detail.status === 'APPROVED' && (
                  <button className="btn btn-primary" disabled={busy === 'pay'}
                    onClick={() => act('pay', () => api.post(`/api/hr/payroll/${detail.id}/pay`, { method: 'BANK' }))}>
                    <Banknote className="h-4 w-4" /> {busy === 'pay' ? 'Paying…' : 'Pay via bank'}
                  </button>)}
              </div>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead><tr>
                  <th className="th text-left">Employee</th>
                  <th className="th text-right">Basic</th><th className="th text-right">Allowances</th>
                  <th className="th text-right">Commission</th><th className="th text-right">Deduction</th>
                  <th className="th text-right">Net pay</th><th className="th"></th>
                </tr></thead>
                <tbody>
                  {detail.payslips.map((p) => (
                    <tr key={p.id} className="border-t border-slate-100 dark:border-slate-800">
                      <td className="td"><span className="num text-xs text-slate-400">{p.emp_code}</span> <span className="font-medium">{p.name}</span></td>
                      <td className="td num text-right">{bdt(Number(p.basic))}</td>
                      <td className="td num text-right">{bdt(Number(p.allowances))}</td>
                      <td className="td num text-right text-emerald-600">{Number(p.commission) ? `+ ${bdt(Number(p.commission))}` : '—'}</td>
                      <td className="td num text-right text-rose-600">{Number(p.deduction) ? `− ${bdt(Number(p.deduction))}` : '—'}</td>
                      <td className="td num text-right font-semibold">{bdt(Number(p.net_pay))}</td>
                      <td className="td text-right">
                        <button className="btn btn-ghost !px-2 !py-1 text-xs" onClick={() => openPdf(`/api/hr/payslips/${p.id}/pdf`)}>
                          <FileDown className="h-3.5 w-3.5" /> Slip
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
                <tfoot>
                  <tr className="border-t-2 border-slate-300 font-bold dark:border-slate-700">
                    <td className="td" colSpan={5}>Total</td>
                    <td className="td num text-right">{bdt(Number(detail.total_net))}</td>
                    <td className="td"></td>
                  </tr>
                </tfoot>
              </table>
            </div>
            <ErrorNote message={error} />
          </div>
        )}
      </Modal>
    </div>
  );
}
