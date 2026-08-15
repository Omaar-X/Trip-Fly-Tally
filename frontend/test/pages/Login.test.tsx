import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';

const mockLogin = vi.fn();
vi.mock('../../src/context/AuthContext', () => ({
  useAuth: () => ({ login: mockLogin }),
}));

const mockGet = vi.fn();
const mockPost = vi.fn();
vi.mock('../../src/api/client', () => ({
  api: { get: (...args: unknown[]) => mockGet(...args), post: (...args: unknown[]) => mockPost(...args) },
  apiErrorMessage: (e: unknown) => String(e),
  resolveAssetUrl: () => null,
}));

import Login from '../../src/pages/Login';

function renderLogin() {
  return render(
    <MemoryRouter>
      <Login />
    </MemoryRouter>
  );
}

describe('Login page', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGet.mockResolvedValue({ data: { data: { name: 'Acme Travel', logo_url: null } } });
  });

  it('shows the fetched company branding name, not a hardcoded product name', async () => {
    renderLogin();
    await waitFor(() => expect(screen.getAllByText('Acme Travel').length).toBeGreaterThan(0));
    expect(screen.queryByText(/trip fly/i)).not.toBeInTheDocument();
  });

  it('falls back to Trip Fly BD branding when the branding request fails', async () => {
    mockGet.mockRejectedValue(new Error('network error'));
    renderLogin();
    await waitFor(() => expect(screen.getAllByText('Trip Fly BD').length).toBeGreaterThan(0));
  });

  it('offers non-CEO self-registration for CEO approval', async () => {
    renderLogin();
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: /register for approval/i }));
    expect(screen.getByLabelText(/full name/i)).toBeInTheDocument();
    expect(screen.queryByRole('option', { name: 'CEO' })).not.toBeInTheDocument();
  });

  it('submits credentials through the centralized auth context', async () => {
    mockLogin.mockResolvedValue(undefined);
    renderLogin();

    const user = userEvent.setup();
    await user.clear(screen.getByLabelText(/email address/i));
    await user.type(screen.getByLabelText(/email address/i), 'ceo.test@example.com');
    await user.clear(screen.getByLabelText(/password/i));
    await user.type(screen.getByLabelText(/password/i), 'TestOnlyPass123!');
    await user.click(screen.getByRole('button', { name: /sign in/i }));

    await waitFor(() => expect(mockLogin).toHaveBeenCalledWith('ceo.test@example.com', 'TestOnlyPass123!'));
  });
});
