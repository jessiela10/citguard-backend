const crypto = require('crypto');
const pool = require('./db');

function canonical(v) {
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`;
  if (v && typeof v === 'object') {
    return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canonical(v[k])}`).join(',')}}`;
  }
  return JSON.stringify(v === undefined ? null : v);
}

function computeHash(prevHash, entity, entityId, action, dataStr, createdAt) {
  const input = [prevHash || '', entity, entityId, action, dataStr, createdAt.toISOString()].join('|');
  return crypto.createHash('sha256').update(input).digest('hex');
}

let chain = Promise.resolve();

function append(entity, entityId, action, data) {
  const run = chain.then(async () => {
    const [last] = await pool.query('SELECT hash FROM audit_log ORDER BY id DESC LIMIT 1');
    const prevHash = last[0] ? last[0].hash : null;
    const dataStr = canonical(JSON.parse(JSON.stringify(data ?? {})));
    const createdAt = new Date();
    const id = String(entityId);
    const hash = computeHash(prevHash, entity, id, action, dataStr, createdAt);

    await pool.query(
      `INSERT INTO audit_log (entity, entity_id, action, data, prev_hash, hash, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [entity, id, action, dataStr, prevHash, hash, createdAt]
    );
    return hash;
  });
  chain = run.catch(() => {});
  return run;
}

async function verify() {
  const [rows] = await pool.query('SELECT * FROM audit_log ORDER BY id');
  let prev = null;
  for (const r of rows) {
    if ((r.prev_hash || null) !== prev) {
      return { valid: false, checked: rows.length, broken_at: r.id, reason: 'prev_hash tidak cocok dengan baris sebelumnya' };
    }
    const data = typeof r.data === 'string' ? JSON.parse(r.data) : r.data;
    const hash = computeHash(r.prev_hash, r.entity, r.entity_id, r.action, canonical(data), r.created_at);
    if (hash !== r.hash) {
      return { valid: false, checked: rows.length, broken_at: r.id, reason: 'isi baris berubah (hash tidak cocok)' };
    }
    prev = r.hash;
  }
  return { valid: true, checked: rows.length, broken_at: null };
}

async function list({ entity, limit }) {
  const n = Math.min(Math.max(Number(limit) || 200, 1), 1000);
  const [rows] = entity
    ? await pool.query('SELECT * FROM audit_log WHERE entity = ? ORDER BY id DESC LIMIT ?', [entity, n])
    : await pool.query('SELECT * FROM audit_log ORDER BY id DESC LIMIT ?', [n]);
  return rows.map((r) => ({ ...r, data: typeof r.data === 'string' ? JSON.parse(r.data) : r.data }));
}

module.exports = { append, verify, list };
