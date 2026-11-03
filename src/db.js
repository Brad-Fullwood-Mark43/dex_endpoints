import pg from 'pg';

const url = process.env.DATABASE_URL || '';
export const dbEnabled = !!url;

const MAX_CALLS = 300;
let pool = null;
const timers = new Map();

const warn = (what, err) => console.warn(`db: ${what} failed: ${err.code ?? err.message}`);

export async function initDb() {
  if (!dbEnabled) return;
  pool = new pg.Pool({ connectionString: url, max: 4, ssl: process.env.PGSSL === 'true' ? { rejectUnauthorized: false } : undefined });
  await pool.query(`
    CREATE TABLE IF NOT EXISTS kv (key text PRIMARY KEY, value jsonb NOT NULL);
    CREATE TABLE IF NOT EXISTS calls (id text PRIMARY KEY, ts timestamptz NOT NULL, data jsonb NOT NULL);
    CREATE INDEX IF NOT EXISTS calls_ts_idx ON calls (ts DESC);
  `);
}

export async function loadKv(key) {
  const res = await pool.query('SELECT value FROM kv WHERE key = $1', [key]);
  return res.rows[0]?.value ?? null;
}

export function saveKv(key, value) {
  pool
    .query('INSERT INTO kv (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value', [key, JSON.stringify(value)])
    .catch((err) => warn(`save ${key}`, err));
}

export async function loadCalls() {
  const res = await pool.query('SELECT data FROM calls ORDER BY ts DESC LIMIT $1', [MAX_CALLS]);
  return res.rows.map((r) => r.data);
}

/** A call is updated several times in quick succession (ack, each delivery); write the latest state once. */
export function saveCall(txn) {
  clearTimeout(timers.get(txn.id));
  timers.set(
    txn.id,
    setTimeout(() => {
      timers.delete(txn.id);
      pool
        .query('INSERT INTO calls (id, ts, data) VALUES ($1, $2, $3) ON CONFLICT (id) DO UPDATE SET data = EXCLUDED.data', [txn.id, txn.ts, JSON.stringify(txn)])
        .then(() => pool.query('DELETE FROM calls WHERE id NOT IN (SELECT id FROM calls ORDER BY ts DESC LIMIT $1)', [MAX_CALLS]))
        .catch((err) => warn('save call', err));
    }, 250),
  );
}

export function clearCalls() {
  for (const t of timers.values()) clearTimeout(t);
  timers.clear();
  pool.query('DELETE FROM calls').catch((err) => warn('clear calls', err));
}
