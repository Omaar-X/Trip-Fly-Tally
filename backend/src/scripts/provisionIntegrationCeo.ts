import bcrypt from 'bcryptjs';
import { pool, query, exec, Row } from '../config/db';
import { env } from '../config/env';

async function main(): Promise<void> {
  if (env.isProduction || !/(staging|test)/i.test(env.db.database))
    throw new Error('Refusing: the integration CEO may be provisioned only in a staging/test database.');

  const email = process.env.INTEGRATION_CEO_EMAIL?.trim().toLowerCase();
  const password = process.env.INTEGRATION_CEO_PASSWORD;
  if (!email || !password) throw new Error('INTEGRATION_CEO_EMAIL and INTEGRATION_CEO_PASSWORD are required.');
  if (password.length < 12) throw new Error('The staging integration CEO password must be at least 12 characters.');

  const [role] = await query<Row[]>("SELECT id FROM roles WHERE name='CEO' LIMIT 1");
  const [company] = await query<Row[]>('SELECT id FROM companies ORDER BY id LIMIT 1');
  if (!role || !company) throw new Error('Staging roles/company are not initialized.');

  if (process.argv.includes('--disable')) {
    await exec('UPDATE users SET is_active=0 WHERE company_id=? AND email=?', [company.id, email]);
    console.log('Staging integration CEO disabled.');
    return;
  }

  const hash = await bcrypt.hash(password, env.bcryptRounds);
  await exec(
    `INSERT INTO users (company_id,role_id,name,email,password_hash,is_active,approval_status)
     VALUES (?,?,?, ?,?,1,'APPROVED')
     ON DUPLICATE KEY UPDATE role_id=VALUES(role_id), password_hash=VALUES(password_hash),
       is_active=1, approval_status='APPROVED'`,
    [company.id, role.id, 'Staging Integration CEO', email, hash]);
  console.log('Staging integration CEO is active (credentials were not printed).');
}

main().then(() => pool.end()).catch(async (error) => {
  console.error(error instanceof Error ? error.message : error);
  await pool.end().catch(() => undefined);
  process.exit(1);
});
