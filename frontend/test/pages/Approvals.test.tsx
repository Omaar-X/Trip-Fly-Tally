import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

vi.mock('../../src/api/client', () => ({
  api: { get: vi.fn(), post: vi.fn() },
  apiErrorMessage: (e: { response?: { data?: { message?: string } } }) =>
    e?.response?.data?.message ?? 'Something went wrong.',
}));

vi.mock('../../src/context/AuthContext', () => ({
  useAuth: () => ({ user: mockUser }),
}));

import { api } from '../../src/api/client';
import Approvals from '../../src/pages/approvals/Approvals';

const mockGet = vi.mocked(api.get);
const mockPost = vi.mocked(api.post);

let mockUser: { role: string; id: number } = { role: 'CEO', id: 1 };

const CHANGES = [
  {
    id: 1, request_no: 'EDT-2026-00001', kind: 'EDIT', entity: 'vouchers', entity_id: 5,
    status: 'PENDING', priority: 'NORMAL', reason: 'Wrong ledger picked.',
    requested_by: 3, requested_role: 'ACCOUNTANT', admin_recommendation: null,
    decision_note: null, version: 1, created_at: '2026-08-29',
  },
  {
    id: 2, request_no: 'DEL-2026-00002', kind: 'DELETE', entity: 'payments', entity_id: 9,
    status: 'PENDING', priority: 'URGENT', reason: 'Duplicate receipt.',
    requested_by: 4, requested_role: 'SALES', admin_recommendation: 'APPROVE',
    decision_note: null, version: 2, created_at: '2026-08-29',
  },
];

const BDRS = [
  {
    id: 7, request_no: 'BDR-2026-00007', module: 'PAYMENT', status: 'PENDING', priority: 'NORMAL',
    requested_from: '2026-08-01', requested_to: '2026-08-20',
    approved_from: null, approved_to: null, reason: 'Catching up receipts.',
    requested_by: 3, expires_at: null,
  },
];

const reply = (rows: unknown[]) => ({ data: { data: rows } }) as never;

beforeEach(() => {
  vi.clearAllMocks();
  mockUser = { role: 'CEO', id: 1 };
  mockGet.mockImplementation((url: string) =>
    Promise.resolve(reply(url.includes('/bdr') ? BDRS : CHANGES)) as never);
  mockPost.mockResolvedValue({ data: { data: {} } } as never);
});

describe('Approvals page', () => {
  it('lists edit and delete requests', async () => {
    render(<Approvals />);
    await waitFor(() => expect(screen.getByText('EDT-2026-00001')).toBeInTheDocument());
    expect(screen.getByText('DEL-2026-00002')).toBeInTheDocument();
  });

  it('highlights urgent requests at the top', async () => {
    render(<Approvals />);
    await waitFor(() => expect(screen.getByText(/1 urgent request/)).toBeInTheDocument());
  });

  it('shows the admin recommendation without treating it as a decision', async () => {
    render(<Approvals />);
    await waitFor(() => expect(screen.getByText('APPROVE')).toBeInTheDocument());
    // Still pending: a recommendation does not decide anything.
    expect(screen.getAllByText('PENDING').length).toBeGreaterThan(0);
  });

  it('shows the resubmission count', async () => {
    render(<Approvals />);
    await waitFor(() => expect(screen.getByText('v2')).toBeInTheDocument());
  });

  it('switches to the backdated-access tab', async () => {
    const user = userEvent.setup();
    render(<Approvals />);
    await waitFor(() => expect(screen.getByText('EDT-2026-00001')).toBeInTheDocument());

    await user.click(screen.getByRole('button', { name: /backdated access/i }));
    expect(screen.getByText('BDR-2026-00007')).toBeInTheDocument();
    expect(screen.getByText(/2026-08-01 → 2026-08-20/)).toBeInTheDocument();
  });

  it('surfaces a load failure instead of an empty page', async () => {
    mockGet.mockRejectedValue({ response: { data: { message: 'Backend unreachable.' } } } as never);
    render(<Approvals />);
    await waitFor(() => expect(screen.getByText('Backend unreachable.')).toBeInTheDocument());
  });
});

describe('deciding a change request', () => {
  it('offers the CEO exactly three verbs — and no way to edit the proposal', async () => {
    const user = userEvent.setup();
    render(<Approvals />);
    await waitFor(() => expect(screen.getAllByRole('button', { name: 'Decide' }).length).toBe(2));

    await user.click(screen.getAllByRole('button', { name: 'Decide' })[0]);
    const select = await screen.findByRole('combobox');
    const options = Array.from(select.querySelectorAll('option')).map((o) => o.getAttribute('value'));
    expect(options).toEqual(['APPROVE', 'REJECT', 'NEEDS_CORRECTION']);

    // The requester's proposed values are not editable here by design.
    expect(screen.queryByLabelText(/proposed value/i)).not.toBeInTheDocument();
  });

  it('warns that approval grants a single use', async () => {
    const user = userEvent.setup();
    render(<Approvals />);
    await waitFor(() => expect(screen.getAllByRole('button', { name: 'Decide' })[0]).toBeInTheDocument());
    await user.click(screen.getAllByRole('button', { name: 'Decide' })[0]);
    expect(await screen.findByText(/single, one-time permission/i)).toBeInTheDocument();
  });

  it('posts the decision', async () => {
    const user = userEvent.setup();
    render(<Approvals />);
    await waitFor(() => expect(screen.getAllByRole('button', { name: 'Decide' })[0]).toBeInTheDocument());
    await user.click(screen.getAllByRole('button', { name: 'Decide' })[0]);
    await user.click(await screen.findByRole('button', { name: /submit decision/i }));

    await waitFor(() => expect(mockPost).toHaveBeenCalledWith(
      '/api/approvals/change-requests/1/decide',
      expect.objectContaining({ action: 'APPROVE' })));
  });

  it('hides the decide button from an Accountant', async () => {
    mockUser = { role: 'ACCOUNTANT', id: 3 };
    render(<Approvals />);
    await waitFor(() => expect(screen.getByText('EDT-2026-00001')).toBeInTheDocument());
    expect(screen.queryByRole('button', { name: 'Decide' })).not.toBeInTheDocument();
  });
});

describe('reviewing backdated access', () => {
  const openBdr = async (user: ReturnType<typeof userEvent.setup>) => {
    await waitFor(() => expect(screen.getByText('EDT-2026-00001')).toBeInTheDocument());
    await user.click(screen.getByRole('button', { name: /backdated access/i }));
    await user.click(screen.getByRole('button', { name: 'Review' }));
  };

  it('bounds the date inputs to the requested window', async () => {
    const user = userEvent.setup();
    render(<Approvals />);
    await openBdr(user);

    const from = await screen.findByLabelText('Approve from');
    expect(from).toHaveAttribute('min', '2026-08-01');
    expect(from).toHaveAttribute('max', '2026-08-20');
    // The approver can narrow but not widen — the control says so too.
    expect(screen.getByText(/narrow this window but not extend it/i)).toBeInTheDocument();
  });

  it('approves with the possibly narrowed range', async () => {
    const user = userEvent.setup();
    render(<Approvals />);
    await openBdr(user);
    await user.click(await screen.findByRole('button', { name: 'Approve' }));

    await waitFor(() => expect(mockPost).toHaveBeenCalledWith(
      '/api/approvals/bdr/7/approve',
      expect.objectContaining({ from: '2026-08-01', to: '2026-08-20' })));
  });

  it('lets an authorised Admin reach the review — BDR does not need the CEO', async () => {
    mockUser = { role: 'ADMIN', id: 2 };
    const user = userEvent.setup();
    render(<Approvals />);
    await waitFor(() => expect(screen.getByText('EDT-2026-00001')).toBeInTheDocument());
    await user.click(screen.getByRole('button', { name: /backdated access/i }));
    expect(screen.getByRole('button', { name: 'Review' })).toBeInTheDocument();
  });
});
