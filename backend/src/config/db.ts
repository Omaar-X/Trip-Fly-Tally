import mysql, { Pool, PoolConnection, RowDataPacket, ResultSetHeader } from 'mysql2/promise';
import { env } from './env';

if (!env.isProduction) {
  console.log('Connecting to database:', {
    host: env.db.host,
    port: env.db.port,
    user: env.db.user,
    database: env.db.database,
  });
}

export const pool: Pool = mysql.createPool({
  host: env.db.host,
  port: env.db.port,
  user: env.db.user,
  password: env.db.password,
  database: env.db.database,
  waitForConnections: true,
  connectionLimit: env.db.connectionLimit,
  connectTimeout: 10000,
  decimalNumbers: true,
  dateStrings: ['DATE'],
  timezone: 'Z',
  namedPlaceholders: false,
});

export type Row = RowDataPacket;
export type WriteResult = ResultSetHeader;

export async function withTransaction<T>(fn: (conn: PoolConnection) => Promise<T>): Promise<T> {
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const result = await fn(conn);
    await conn.commit();
    return result;
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }
}

export async function query<T extends Row[]>(sql: string, params: unknown[] = []): Promise<T> {
  const [rows] = await pool.query<T>(sql, params);
  return rows;
}

export async function exec(sql: string, params: unknown[] = []): Promise<WriteResult> {
  const [result] = await pool.query<WriteResult>(sql, params);
  return result;
}
