import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

const get = vi.fn();
const post = vi.fn();

vi.mock('../../src/api/client', () => ({
  api: { get: (...a: unknown[]) => get(...a), post: (...a: unknown[]) => post(...a) },
  apiErrorMessage: () => 'error',
}));
vi.mock('../../src/context/AuthContext', () => ({
  useAuth: () => ({ user: { name: 'Rina', role: 'ACCOUNTANT' } }),
}));

import Accounting from '../../src/pages/accounting/Accounting';

const LEDGERS = [
  { id: 1, name: 'Cash in Hand', group_name: 'Cash-in-Hand', nature: 'ASSET', is_system: 1,
    opening_balance: '0', opening_type: 'DR', total_debit: '0', total_credit: '0', closing_balance: '0' },
  { id: 2, name: 'City Bank — A/C 110245', group_name: 'Bank Accounts', nature: 'ASSET', is_system: 1,
    opening_balance: '0', opening_type: 'DR', total_debit: '0', total_credit: '0', closing_balance: '0' },
];
const GROUPS = [{ id: 16, name: 'Indirect Expenses', nature: 'EXPENSE', parent_name: 'Expenses' }];

beforeEach(() => {
  get.mockReset(); post.mockReset();
  get.mockImplementation((url: string) => {
    if (url === '/api/ledgers') return Promise.resolve({ data: { data: LEDGERS } });
    if (url === '/api/ledger-groups') return Promise.resolve({ data: { data: GROUPS } });
    return Promise.resolve({ data: { data: [], paging: { total: 0 } } });
  });
});

/** Land on the entry screen the way an accountant does. */
async function openEntry(user: ReturnType<typeof userEvent.setup>) {
  render(<Accounting />);
  await waitFor(() => expect(get).toHaveBeenCalledWith('/api/ledgers'));
  await user.click(screen.getByRole('button', { name: /New Voucher/ }));
}

describe('voucher entry — keyboard', () => {
  it('switches voucher type on the Tally function keys', async () => {
    const user = userEvent.setup();
    await openEntry(user);

    expect(screen.getByRole('button', { name: /JOURNAL/ })).toHaveAttribute('aria-pressed', 'true');

    await user.keyboard('{F5}');
    expect(screen.getByRole('button', { name: /PAYMENT/ })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('button', { name: /JOURNAL/ })).toHaveAttribute('aria-pressed', 'false');

    await user.keyboard('{F8}');
    expect(screen.getByRole('button', { name: /SALES/ })).toHaveAttribute('aria-pressed', 'true');
  });

  it('posts on Ctrl+Enter once the voucher balances', async () => {
    const user = userEvent.setup();
    post.mockResolvedValue({ data: { data: { voucherNo: 'JV-2026-00001' } } });
    await openEntry(user);

    const [drLedger, crLedger] = screen.getAllByRole('combobox', { name: /Ledger for line/ });
    await user.click(drLedger);
    await user.click(screen.getByText('Cash in Hand'));
    await user.click(crLedger);
    await user.click(screen.getByText('City Bank — A/C 110245'));

    const amounts = screen.getAllByPlaceholderText('0.00');
    await user.type(amounts[0], '500');
    await user.type(amounts[1], '500');

    await user.keyboard('{Control>}{Enter}{/Control}');

    await waitFor(() => expect(post).toHaveBeenCalledWith('/api/vouchers', expect.objectContaining({
      entries: [
        expect.objectContaining({ ledgerId: 1, type: 'DR', amount: 500 }),
        expect.objectContaining({ ledgerId: 2, type: 'CR', amount: 500 }),
      ],
    })));
  });
});

describe('voucher entry — creating a ledger mid-entry', () => {
  it('keeps the typed lines and selects what it just created', async () => {
    const user = userEvent.setup();
    post.mockResolvedValue({ data: { data: { id: 42 } } });
    await openEntry(user);

    // Work already done on the voucher, which must survive.
    const amounts = screen.getAllByPlaceholderText('0.00');
    await user.type(amounts[0], '1200');

    await user.click(screen.getAllByRole('button', { name: /New ledger for line 1/ })[0]);
    await user.type(screen.getByPlaceholderText('e.g. Office Rent'), 'Office Rent');
    await user.selectOptions(screen.getByRole('combobox', { name: 'Group' }), '16');
    await user.click(screen.getByRole('button', { name: 'Create ledger' }));

    await waitFor(() => expect(post).toHaveBeenCalledWith('/api/ledgers', expect.objectContaining({
      name: 'Office Rent', groupId: 16,
    })));

    // The amount is still there — the whole point of not leaving the screen.
    expect(screen.getAllByPlaceholderText('0.00')[0]).toHaveValue(1200);
    // And the list was refetched so the new account is reachable.
    await waitFor(() => expect(get.mock.calls.filter(([u]) => u === '/api/ledgers').length).toBeGreaterThan(1));
  });
});
