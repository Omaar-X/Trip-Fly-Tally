import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';

vi.mock('../src/modules/companySettings/companySettings.service', () => ({
  companySettingsService: {
    get: vi.fn(),
    getPublic: vi.fn(),
    update: vi.fn(),
    updateLogo: vi.fn(),
    updateFavicon: vi.fn(),
  },
}));

import { app } from '../src/app';
import { companySettingsService } from '../src/modules/companySettings/companySettings.service';
import { ROLE } from '../src/constants/roles';
import { authHeader } from './helpers/token';

describe('Company Settings', () => {
  beforeEach(() => vi.clearAllMocks());

  it('GET /public returns branding without auth, no hardcoded company name', async () => {
    vi.mocked(companySettingsService.getPublic).mockResolvedValue({
      name: 'Any Company', logo_url: null, favicon_url: null,
    } as any);

    const res = await request(app).get('/api/company-settings/public');

    expect(res.status).toBe(200);
    expect(res.body.data.name).toBe('Any Company');
    expect(companySettingsService.getPublic).toHaveBeenCalledWith(1);
  });

  it('CEO can update company settings', async () => {
    vi.mocked(companySettingsService.update).mockResolvedValue({ id: 1, name: 'New Name' } as any);

    const res = await request(app)
      .put('/api/company-settings')
      .set(authHeader(ROLE.CEO))
      .send({ name: 'New Name' });

    expect(res.status).toBe(200);
    expect(res.body.data.name).toBe('New Name');
  });

  it('non-CEO roles are rejected before the service is ever called', async () => {
    const res = await request(app)
      .put('/api/company-settings')
      .set(authHeader(ROLE.ADMIN))
      .send({ name: 'Hacked Name' });

    expect(res.status).toBe(403);
    expect(companySettingsService.update).not.toHaveBeenCalled();
  });
});
