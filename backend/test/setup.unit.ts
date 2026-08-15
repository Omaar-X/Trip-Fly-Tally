import { vi } from 'vitest';

/**
 * ====================== UNIT TESTS TOUCH NO DATABASE =========================
 * `npm test` mounts the real Express app through supertest, and the real app
 * writes an audit row after every successful mutation. Those writes go through
 * `exec()` on the live pool, so the suite was quietly INSERTing into whichever
 * database `.env` happened to point at.
 *
 * Measured, not theorised: a single `npm test` added 13 rows to the developer
 * database's `audit_logs`, including `PAYMENT_RECORD → payments id 12` while
 * the `payments` table was empty. On a machine whose `.env` points at
 * production, the suite would write fabricated entries into production's audit
 * trail — and an audit trail with invented rows in it is not an audit trail.
 *
 * The services under test are already mocked per-file; audit was the one path
 * that reached past the mocks to real infrastructure. It is stubbed here, once,
 * for every unit test.
 *
 * Integration tests deliberately do NOT load this file — they run against a
 * real throwaway database via vitest.integration.config.ts, and their audit
 * writes are part of what they verify.
 */
vi.mock('../src/middleware/audit', () => ({
  audit: vi.fn(async () => {}),
}));
