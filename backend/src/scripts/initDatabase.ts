import fs from 'fs/promises';
import path from 'path';
import mysql from 'mysql2/promise';
import { env } from '../config/env';

async function completeEmptyBaseline(conn: mysql.Connection) {
  const [done] = await conn.query<mysql.RowDataPacket[]>(
    `SELECT table_name FROM information_schema.tables WHERE table_schema = ? AND table_name = 'deployment_baseline_complete'`,
    [env.db.database]
  );
  if (done.length) return;
  const [counts] = await conn.query<mysql.RowDataPacket[]>(
    `SELECT (SELECT COUNT(*) FROM companies WHERE is_configured = 1) AS configured,
      (SELECT COUNT(*) FROM vouchers) AS vouchers,
      (SELECT COUNT(*) FROM bookings) AS bookings,
      (SELECT COUNT(*) FROM customers) AS customers,
      (SELECT COUNT(*) FROM suppliers) AS suppliers,
      (SELECT COUNT(*) FROM invoices) AS invoices,
      (SELECT COUNT(*) FROM payments) AS payments,
      (SELECT COUNT(*) FROM employees) AS employees`
  );
  if (Object.values(counts[0]).some(value => Number(value) !== 0)) {
    throw new Error('Refusing baseline upgrade: database contains business data or configured company. Apply reviewed migrations manually.');
  }
  const databaseDir = path.resolve(__dirname, '../../../database');
  const [columns] = await conn.query<mysql.RowDataPacket[]>(
    `SELECT table_name AS tableName, column_name AS columnName FROM information_schema.columns WHERE table_schema = ?`, [env.db.database]
  );
  const hasColumn = (table: string, column: string) => columns.some(row => row.tableName === table && row.columnName === column);
  const files = (await fs.readdir(path.join(databaseDir, 'migrations')))
    .filter(file => /^\d{3}.*\.sql$/.test(file) && Number(file.slice(0, 3)) >= 7).sort();
  for (const file of files) {
    const version = Number(file.slice(0, 3));
    if (version === 7 && hasColumn('companies', 'back_entry_grace_days')) continue;
    if (version === 8 && hasColumn('customers', 'name_key')) continue;
    console.log(`Completing empty deployment baseline: ${file}`);
    await conn.query(await fs.readFile(path.join(databaseDir, 'migrations', file), 'utf8'));
  }
  await conn.query('CREATE TABLE deployment_baseline_complete (id INT PRIMARY KEY) ENGINE=InnoDB');
  await conn.query('INSERT INTO deployment_baseline_complete VALUES (1)');
}

/**
 * Production-safe bootstrap: initialise only a completely empty database.
 * An existing or partially-created database is never modified automatically;
 * migrations remain an explicit reviewed operation.
 */
async function main() {
  if (!env.isProduction) {
    console.log('Database bootstrap skipped outside production');
    return;
  }

  const conn = await mysql.createConnection({
    host: env.db.host,
    port: env.db.port,
    user: env.db.user,
    password: env.db.password,
    database: env.db.database,
    multipleStatements: true,
    connectTimeout: 10000,
    decimalNumbers: true,
  });

  try {
    const [rows] = await conn.query<mysql.RowDataPacket[]>(
      `SELECT table_name AS tableName FROM information_schema.tables
        WHERE table_schema = ? AND table_type = 'BASE TABLE'`,
      [env.db.database]
    );
    const tables = rows.map((row) => String(row.tableName));
    if (tables.includes('companies')) {
      if (process.env.DEPLOY_BOOTSTRAP_EMPTY_UPGRADE === 'true') await completeEmptyBaseline(conn);
      console.log(`Database schema present (${tables.length} tables); bootstrap skipped`);
      return;
    }
    if (tables.length > 0) {
      throw new Error(
        `Database is partially initialized (${tables.length} tables, but companies is missing). ` +
        'Refusing automatic changes; restore or migrate it manually.'
      );
    }

    const databaseDir = path.resolve(__dirname, '../../../database');
    const [schema, seed] = await Promise.all([
      fs.readFile(path.join(databaseDir, 'schema.sql'), 'utf8'),
      fs.readFile(path.join(databaseDir, 'seed.sql'), 'utf8'),
    ]);

    console.log('Empty production database detected; applying schema and baseline seed');
    await conn.query(schema);
    await conn.query(seed);
    await completeEmptyBaseline(conn);

    const [verified] = await conn.query<mysql.RowDataPacket[]>(
      `SELECT
         (SELECT COUNT(*) FROM companies) AS companies,
         (SELECT COUNT(*) FROM roles) AS roles,
         (SELECT COUNT(*) FROM users) AS users`
    );
    if (!verified[0] || Number(verified[0].companies) < 1 || Number(verified[0].roles) < 1 || Number(verified[0].users) < 1) {
      throw new Error('Database bootstrap verification failed: baseline rows are missing');
    }
    console.log('Database bootstrap completed and verified');
  } finally {
    await conn.end();
  }
}

main().catch((error) => {
  console.error('Database bootstrap failed:', error instanceof Error ? error.message : error);
  process.exit(1);
});
