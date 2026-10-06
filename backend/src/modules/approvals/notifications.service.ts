import { exec, query, Row } from '../../config/db';
import { mailConfigured, sendNotificationMail } from '../../utils/mailer';

/**
 * ========================= NOTIFICATION DELIVERY ===========================
 *
 * Dashboard always. Email and WhatsApp only when a provider is configured.
 *
 * The rule that shapes this file: a missing provider must never fail the thing
 * that triggered the notification. Someone raising an urgent delete request at
 * midnight should not get a 500 because SMTP credentials were never set — the
 * request is the important part, the notification is the courtesy. So every
 * send is recorded with an outcome, and SKIPPED_NOT_CONFIGURED is a normal
 * outcome rather than an error.
 *
 * Credentials come from the environment, never from source. Nothing here reads
 * a hardcoded endpoint or key.
 * ===========================================================================
 */

export type Channel = 'DASHBOARD' | 'EMAIL' | 'WHATSAPP';
export type DeliveryStatus = 'QUEUED' | 'SENT' | 'FAILED' | 'SKIPPED_NOT_CONFIGURED';

export interface NotifyInput {
  companyId: number;
  event: string;
  requestType?: 'CHANGE' | 'BDR' | null;
  requestId?: number | null;
  recipients: { id: number; email?: string | null; phone?: string | null }[];
  subject: string;
  body: string;
  urgent?: boolean;
}

/** Configured, not hardcoded. Absent configuration simply means "channel is off". */
const emailConfigured = mailConfigured;

const whatsappConfigured = (): boolean =>
  Boolean(process.env.WHATSAPP_API_URL && process.env.WHATSAPP_API_TOKEN);

async function record(
  companyId: number, channel: Channel, event: string,
  requestType: 'CHANGE' | 'BDR' | null, requestId: number | null,
  recipientId: number | null, addr: string | null,
  status: DeliveryStatus, error?: string,
): Promise<void> {
  try {
    await exec(
      `INSERT INTO notification_log
         (company_id, channel, event, request_type, request_id, recipient_id, recipient_addr, status, error)
       VALUES (?,?,?,?,?,?,?,?,?)`,
      [companyId, channel, event, requestType, requestId, recipientId, addr, status, error ?? null]);
  } catch (err) {
    // The log is a convenience. Failing to write it must not take down the
    // request either.
    console.error('notification log failed:', err);
  }
}

export const notificationsService = {

  /**
   * Fan out to every configured channel.
   *
   * Never throws. Callers are in the middle of a business operation and have
   * nothing useful to do with a delivery failure.
   */
  async notify(input: NotifyInput): Promise<{ dashboard: number; email: number; whatsapp: number }> {
    const counts = { dashboard: 0, email: 0, whatsapp: 0 };
    const { companyId, event, requestType = null, requestId = null } = input;

    for (const r of input.recipients) {
      // Dashboard needs no provider — it is a row in this table, read by the
      // pending-badge query.
      await record(companyId, 'DASHBOARD', event, requestType, requestId, r.id, null, 'SENT');
      counts.dashboard++;

      if (r.email) {
        if (!emailConfigured()) {
          await record(companyId, 'EMAIL', event, requestType, requestId, r.id, r.email, 'SKIPPED_NOT_CONFIGURED');
        } else {
          try {
            await this.sendEmail(r.email, input.subject, input.body);
            await record(companyId, 'EMAIL', event, requestType, requestId, r.id, r.email, 'SENT');
            counts.email++;
          } catch (err) {
            await record(companyId, 'EMAIL', event, requestType, requestId, r.id, r.email,
              'FAILED', (err as Error).message.slice(0, 500));
          }
        }
      }

      if (r.phone) {
        if (!whatsappConfigured()) {
          await record(companyId, 'WHATSAPP', event, requestType, requestId, r.id, r.phone, 'SKIPPED_NOT_CONFIGURED');
        } else {
          try {
            await this.sendWhatsApp(r.phone, `${input.subject}\n\n${input.body}`);
            await record(companyId, 'WHATSAPP', event, requestType, requestId, r.id, r.phone, 'SENT');
            counts.whatsapp++;
          } catch (err) {
            await record(companyId, 'WHATSAPP', event, requestType, requestId, r.id, r.phone,
              'FAILED', (err as Error).message.slice(0, 500));
          }
        }
      }
    }
    return counts;
  },

  /** Uses the project's existing SMTP transport rather than a second one. */
  async sendEmail(to: string, subject: string, body: string): Promise<void> {
    await sendNotificationMail(to, subject, body);
  },

  /**
   * Deliberately a stub with a real shape: the endpoint and token come from
   * the environment, and an unconfigured provider is caught before this runs.
   */
  async sendWhatsApp(to: string, message: string): Promise<void> {
    const url = process.env.WHATSAPP_API_URL!;
    const token = process.env.WHATSAPP_API_TOKEN!;
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify({ to, message }),
    });
    if (!res.ok) throw new Error(`WhatsApp provider returned ${res.status}`);
  },

  /** The dashboard badge: how many unread notifications this user has. */
  async unreadCount(companyId: number, userId: number): Promise<number> {
    const rows = await query<Row[]>(
      `SELECT COUNT(*) AS n FROM notification_log
        WHERE company_id = ? AND recipient_id = ? AND channel = 'DASHBOARD' AND read_at IS NULL`,
      [companyId, userId]);
    return Number(rows[0]?.n ?? 0);
  },

  inbox: (companyId: number, userId: number) =>
    query<Row[]>(
      `SELECT id, event, request_type, request_id, status, read_at, created_at
         FROM notification_log
        WHERE company_id = ? AND recipient_id = ? AND channel = 'DASHBOARD'
        ORDER BY id DESC LIMIT 100`, [companyId, userId]),

  async markRead(companyId: number, userId: number, ids: number[]): Promise<number> {
    if (!ids.length) return 0;
    const placeholders = ids.map(() => '?').join(',');
    const res = await exec(
      `UPDATE notification_log SET read_at = NOW()
        WHERE company_id = ? AND recipient_id = ? AND read_at IS NULL AND id IN (${placeholders})`,
      [companyId, userId, ...ids]);
    return res.affectedRows;
  },

  /** Who to tell: the CEO, plus any Admin the CEO has given review authority. */
  async approverRecipients(companyId: number) {
    return query<Row[]>(
      `SELECT DISTINCT u.id, u.email, NULL AS phone
         FROM users u
         JOIN roles r ON r.id = u.role_id
    LEFT JOIN admin_approval_grants g
           ON g.user_id = u.id AND g.company_id = u.company_id AND g.revoked_at IS NULL
        WHERE u.company_id = ? AND u.is_active = 1
          AND (r.name = 'CEO' OR (r.name = 'ADMIN' AND g.id IS NOT NULL))`,
      [companyId]);
  },
};
