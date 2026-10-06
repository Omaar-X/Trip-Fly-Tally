import bcrypt from 'bcryptjs';
import { pool, query, exec, Row } from '../config/db';
import { env } from '../config/env';

/**
 * ================== CREATE OR RESET A LOCAL LOGIN ==========================
 *
 * The local databases ship with one bootstrap CEO whose password is
 * deliberately not in source control (see database/seed.sql). Anyone cloning
 * the repo therefore has a running app and no way into it, and the login form
 * answers an unknown email and a wrong password with the same
 * "Invalid email or password" — so the wall gives no hint which one it is.
 *
 * This script is the way in. It creates the user if the email is new and
 * resets the password if it is not, then stops.
 *
 * Two things it deliberately does NOT do:
 *
 *   · It never takes a password as a command-line argument. argv lands in
 *     shell history and in the process list; an environment variable does not.
 *   · It never prints the password back, not even on success.
 *
 * And it refuses to run against production, because a script that seeds a
 * known login is exactly the script you never want pointed at real books.
 *
 *   DEV_USER_EMAIL=you@example.com DEV_USER_PASSWORD=... npm run dev:user
 *
 * Optional: DEV_USER_NAME (default "Local Developer"), DEV_USER_ROLE
 * (CEO | ADMIN | ACCOUNTANT | SALES | HR, default ADMIN).
 */

const ALLOWED_ROLES = ['CEO', 'ADMIN', 'ACCOUNTANT', 'SALES', 'HR'] as const;

async function main(): Promise<void> {
  if (env.isProduction)
    throw new Error('Refusing to run with NODE_ENV=production.');

  // A production database reached from a development machine is still a
  // production database. The name is the only signal available here, so a
  // local login is seeded only into a database that says it is not live.
  if (!/(dev|staging|test|_local)/i.test(env.db.database) && env.db.database !== 'tripfly_erp')
    throw new Error(
      `Refusing: "${env.db.database}" does not look like a development or staging database. `
      + 'Set DB_NAME explicitly if this is wrong.');

  if (!['localhost', '127.0.0.1', '::1'].includes(env.db.host))
    throw new Error(`Refusing: the database host is "${env.db.host}", not this machine.`);

  const email = process.env.DEV_USER_EMAIL?.trim().toLowerCase();
  const password = process.env.DEV_USER_PASSWORD;
  const name = process.env.DEV_USER_NAME?.trim() || 'Local Developer';
  const role = (process.env.DEV_USER_ROLE?.trim().toUpperCase() || 'ADMIN');

  if (!email || !password)
    throw new Error('DEV_USER_EMAIL and DEV_USER_PASSWORD are required (pass them as environment variables, not arguments).');
  if (password.length < 8)
    throw new Error('The password must be at least 8 characters.');
  if (!ALLOWED_ROLES.includes(role as typeof ALLOWED_ROLES[number]))
    throw new Error(`Unknown role "${role}". One of: ${ALLOWED_ROLES.join(', ')}.`);

  const [roleRow] = await query<Row[]>('SELECT id FROM roles WHERE name = ? LIMIT 1', [role]);
  const [company] = await query<Row[]>('SELECT id, name FROM companies ORDER BY id LIMIT 1');
  if (!roleRow) throw new Error(`Role "${role}" is not in this database.`);
  if (!company) throw new Error('This database has no company row — run the schema and seed first.');

  const [existing] = await query<Row[]>(
    'SELECT id FROM users WHERE company_id = ? AND email = ? LIMIT 1', [company.id, email]);

  const hash = await bcrypt.hash(password, env.bcryptRounds);

  if (existing) {
    // An existing login is reset rather than duplicated, and reactivated: a
    // disabled or still-pending account fails login for a reason the form
    // will not explain either.
    await exec(
      `UPDATE users SET password_hash = ?, role_id = ?, is_active = 1,
              approval_status = 'APPROVED', updated_at = NOW()
        WHERE id = ?`,
      [hash, roleRow.id, existing.id]);
    // Any session issued against the old password stops here.
    await exec('UPDATE refresh_tokens SET revoked_at = NOW() WHERE user_id = ? AND revoked_at IS NULL',
      [existing.id]);
    console.log(`Reset the password for ${email} (${role}) in "${env.db.database}". Password not printed.`);
    return;
  }

  const result = await exec(
    `INSERT INTO users (company_id, role_id, name, email, password_hash, is_active, approval_status)
     VALUES (?,?,?,?,?,1,'APPROVED')`,
    [company.id, roleRow.id, name, email, hash]);

  console.log(`Created ${email} as ${role} (id ${result.insertId}) in "${env.db.database}". Password not printed.`);
}

main().then(() => pool.end()).catch(async (error) => {
  console.error(error instanceof Error ? error.message : error);
  await pool.end().catch(() => undefined);
  process.exit(1);
});
