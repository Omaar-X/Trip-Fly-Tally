import { Request } from 'express';
import { exec } from '../config/db';

/**
 * Fire-and-forget audit trail writer. Never blocks or fails a request.
 * `actorUserId` lets callers on unauthenticated routes (e.g. login, where
 * req.user isn't set yet) record who the action was actually for, instead of
 * silently writing user_id = NULL.
 */
export async function audit(
  req: Request, action: string, entity: string, entityId?: number | null,
  details?: unknown, actorUserId?: number | null
): Promise<void> {
  try {
    await exec(
      'INSERT INTO audit_logs (user_id, action, entity, entity_id, details, ip_address) VALUES (?,?,?,?,?,?)',
      [actorUserId ?? req.user?.sub ?? null, action, entity, entityId ?? null,
       details ? JSON.stringify(details) : null, req.ip ?? null]
    );
  } catch (err) {
    console.error('audit log failed:', err);
  }
}
