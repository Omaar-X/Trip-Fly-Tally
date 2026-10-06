import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';

vi.mock('../../src/api/client', () => ({
  api: { get: vi.fn(), post: vi.fn() },
}));

vi.mock('../../src/context/AuthContext', () => ({
  useAuth: () => ({ user: mockUser }),
}));

import { api } from '../../src/api/client';
import { CustomerSearchSelect, VendorSearchSelect } from '../../src/components/EntitySearchSelect';

const mockGet = vi.mocked(api.get);
const mockPost = vi.mocked(api.post);

let mockUser: { role: string } | null = { role: 'SALES' };

const PARTIES = [
  { id: 1, name: 'SUN PHARMA', phone: '01712345678' },
  { id: 2, name: 'EVEREST PHARMA', phone: null },
  { id: 3, name: 'GROUPO SORCHING', phone: null },
];

const reply = (rows: unknown[]) => ({ data: { data: rows } }) as never;

function Harness({ initial = '' as number | '' }) {
  const [value, setValue] = useState<number | ''>(initial);
  return (
    <>
      <CustomerSearchSelect value={value} onChange={setValue} />
      <output data-testid="picked">{String(value)}</output>
    </>
  );
}

const open = async (user: ReturnType<typeof userEvent.setup>, name = 'Customer') => {
  const box = screen.getByRole('combobox', { name });
  await user.click(box);
  return box;
};

beforeEach(() => {
  vi.clearAllMocks();
  mockUser = { role: 'SALES' };
  mockGet.mockResolvedValue(reply(PARTIES));
});

afterEach(() => { vi.useRealTimers(); });

// ─────────────────────────────── searching ──────────────────────────────────

describe('CustomerSearchSelect — server-backed search', () => {
  it('does not fetch anything until the picker is opened', () => {
    render(<Harness />);
    // The whole point of Phase 2: a form with four pickers must not fire four
    // list queries on mount.
    expect(mockGet).not.toHaveBeenCalled();
  });

  it('loads the first page as soon as it opens', async () => {
    const user = userEvent.setup();
    render(<Harness />);
    await open(user);

    await waitFor(() => expect(screen.getByRole('option', { name: /SUN PHARMA/ })).toBeInTheDocument());
    expect(mockGet).toHaveBeenCalledWith('/api/crm/customers/search',
      expect.objectContaining({ params: expect.objectContaining({ q: '' }) }));
  });

  it('sends the typed term to the server rather than filtering locally', async () => {
    const user = userEvent.setup();
    render(<Harness />);
    await open(user);
    await waitFor(() => expect(mockGet).toHaveBeenCalled());

    mockGet.mockResolvedValue(reply([PARTIES[0]]));
    await user.type(screen.getByRole('combobox', { name: 'Customer' }), 'sun');

    await waitFor(() => expect(mockGet).toHaveBeenCalledWith('/api/crm/customers/search',
      expect.objectContaining({ params: expect.objectContaining({ q: 'sun' }) })), { timeout: 2000 });
  });

  it('asks for a capped page, never the whole table', async () => {
    const user = userEvent.setup();
    render(<Harness />);
    await open(user);

    await waitFor(() => expect(mockGet).toHaveBeenCalled());
    const params = mockGet.mock.calls[0][1] as { params: { limit: number } };
    expect(params.params.limit).toBeLessThanOrEqual(50);
  });

  it('debounces — a burst of keystrokes is not a burst of requests', async () => {
    const user = userEvent.setup();
    render(<Harness />);
    await open(user);
    await waitFor(() => expect(mockGet).toHaveBeenCalledTimes(1));

    await user.type(screen.getByRole('combobox', { name: 'Customer' }), 'pharma');

    await waitFor(() => expect(mockGet.mock.calls.length).toBeGreaterThan(1), { timeout: 2000 });
    // Six characters typed; anything close to six requests means the debounce
    // is not doing its job.
    expect(mockGet.mock.calls.length).toBeLessThan(6);
  });

  it('keeps the results the server returned, even when the name does not contain the term', async () => {
    // A phone-number search matches on a field the browser never sees. Filtering
    // again in the client would throw those rows away.
    const user = userEvent.setup();
    render(<Harness />);
    await open(user);
    await waitFor(() => expect(mockGet).toHaveBeenCalled());

    mockGet.mockResolvedValue(reply([PARTIES[0]]));
    await user.type(screen.getByRole('combobox', { name: 'Customer' }), '01712');

    await waitFor(() => expect(screen.getByRole('option', { name: /SUN PHARMA/ })).toBeInTheDocument(),
      { timeout: 2000 });
  });

  it('says so when nothing matches', async () => {
    const user = userEvent.setup();
    render(<Harness />);
    await open(user);
    await waitFor(() => expect(mockGet).toHaveBeenCalled());

    mockGet.mockResolvedValue(reply([]));
    await user.type(screen.getByRole('combobox', { name: 'Customer' }), 'zzzz');

    await waitFor(() => expect(screen.getByText(/No match for/)).toBeInTheDocument(), { timeout: 2000 });
  });

  it('reports a failed search instead of looking empty', async () => {
    const user = userEvent.setup();
    mockGet.mockRejectedValue(new Error('network down'));
    render(<Harness />);
    await open(user);

    await waitFor(() => expect(screen.getByText(/Search failed/)).toBeInTheDocument(), { timeout: 2000 });
  });
});

// ─────────────────────────────── selecting ──────────────────────────────────

describe('CustomerSearchSelect — selection', () => {
  it('picks with the keyboard: arrows then Enter', async () => {
    const user = userEvent.setup();
    render(<Harness />);
    await open(user);
    await waitFor(() => expect(screen.getAllByRole('option').length).toBe(3));

    await user.keyboard('{ArrowDown}{Enter}');
    expect(screen.getByTestId('picked')).toHaveTextContent('2');
  });

  it('closes on Escape without choosing anything', async () => {
    const user = userEvent.setup();
    render(<Harness />);
    await open(user);
    await waitFor(() => expect(screen.getAllByRole('option').length).toBe(3));

    await user.keyboard('{Escape}');
    expect(screen.queryByRole('option')).not.toBeInTheDocument();
    expect(screen.getByTestId('picked')).toHaveTextContent('');
  });

  it('shows the chosen name after the list closes', async () => {
    const user = userEvent.setup();
    render(<Harness />);
    await open(user);
    await waitFor(() => expect(screen.getAllByRole('option').length).toBe(3));
    await user.click(screen.getByRole('option', { name: /GROUPO SORCHING/ }));

    expect(screen.getByRole('combobox', { name: 'Customer' })).toHaveValue('GROUPO SORCHING');
  });

  it('clears the selection', async () => {
    const user = userEvent.setup();
    render(<Harness />);
    await open(user);
    await waitFor(() => expect(screen.getAllByRole('option').length).toBe(3));
    await user.click(screen.getByRole('option', { name: /SUN PHARMA/ }));
    expect(screen.getByTestId('picked')).toHaveTextContent('1');

    await user.click(screen.getByRole('button', { name: /Clear Customer/i }));
    expect(screen.getByTestId('picked')).toHaveTextContent('');
  });
});

// ──────────────────────────────── quick add ─────────────────────────────────

describe('quick add', () => {
  it('offers "add new" to a role that may create one', async () => {
    const user = userEvent.setup();
    render(<Harness />);
    await open(user);
    await waitFor(() => expect(screen.getByRole('button', { name: /add new customer/i })).toBeInTheDocument());
  });

  it('hides it from a role that may not', async () => {
    mockUser = { role: 'HR' };
    const user = userEvent.setup();
    render(<Harness />);
    await open(user);
    await waitFor(() => expect(screen.getAllByRole('option').length).toBe(3));
    expect(screen.queryByRole('button', { name: /add new customer/i })).not.toBeInTheDocument();
  });

  it('hides vendor creation from Sales, matching the API guard', async () => {
    const user = userEvent.setup();
    render(<VendorSearchSelect value="" onChange={() => {}} />);
    await open(user, 'Vendor');
    await waitFor(() => expect(screen.getAllByRole('option').length).toBe(3));
    expect(screen.queryByRole('button', { name: /add new vendor/i })).not.toBeInTheDocument();
  });

  it('creates the party and selects it without losing the form', async () => {
    const user = userEvent.setup();
    mockPost.mockResolvedValue({ data: { data: { id: 99 } } } as never);
    render(<Harness />);
    await open(user);
    await waitFor(() => expect(screen.getByRole('button', { name: /add new customer/i })).toBeInTheDocument());

    await user.click(screen.getByRole('button', { name: /add new customer/i }));
    await user.type(screen.getByRole('textbox', { name: /name/i }), 'NEW TRAVEL CO');
    await user.click(screen.getByRole('button', { name: /save customer/i }));

    await waitFor(() => expect(screen.getByTestId('picked')).toHaveTextContent('99'));
    expect(mockPost).toHaveBeenCalledWith('/api/crm/customers',
      expect.objectContaining({ name: 'NEW TRAVEL CO' }));
  });

  it('shows the server’s duplicate message rather than a generic failure', async () => {
    const user = userEvent.setup();
    mockPost.mockRejectedValue({
      response: { data: { message: 'Customer "SUN PHARMA" already exists (#1).' } },
    } as never);
    render(<Harness />);
    await open(user);
    await waitFor(() => expect(screen.getByRole('button', { name: /add new customer/i })).toBeInTheDocument());

    await user.click(screen.getByRole('button', { name: /add new customer/i }));
    await user.type(screen.getByRole('textbox', { name: /name/i }), 'sun pharma');
    await user.click(screen.getByRole('button', { name: /save customer/i }));

    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent(/already exists/));
    expect(screen.getByTestId('picked')).toHaveTextContent('');
  });
});
