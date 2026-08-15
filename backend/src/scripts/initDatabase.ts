import fs from 'fs/promises';
import path from 'path';
import mysql from 'mysql2/promise';
import { env } from '../config/env';

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
      `SELECT table_name FROM information_schema.tables
        WHERE table_schema = ? AND table_type = 'BASE TABLE'`,
      [env.db.database]
    );
    const tables = rows.map((row) => String(row.table_name));
    if (tables.includes('companies')) {
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
