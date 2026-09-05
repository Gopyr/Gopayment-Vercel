// api/_store.js
import crypto from 'node:crypto';

// Upstash Redis REST API — format benar:
//   POST /pipeline  body: [["SET","key","value","EX","3600"]]
// Bukan GET /set/key/value (itu format lama yang tidak reliable untuk value panjang)

const REDIS_URL   = process.env.UPSTASH_REDIS_REST_URL;
const REDIS_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;
const mem         = new Map();

// ── Unwrap bug-lama: { value: "...", ex: 3600 } ──────────────────────────────
function unwrap(raw) {
  if (!raw || typeof raw !== 'object') return raw;
  if ('value' in raw && 'ex' in raw && typeof raw.value === 'string') {
    try { return JSON.parse(raw.value); } catch { return raw; }
  }
  if ('result' in raw && typeof raw.result === 'string') {
    try { return JSON.parse(raw.result); } catch { return null; }
  }
  return raw;
}

function redisHeaders() {
  return {
    'Authorization': `Bearer ${REDIS_TOKEN}`,
    'Content-Type': 'application/json',
  };
}

// ── SET via Upstash pipeline ───────────────────────────────────────────────────
async function rSet(key, value, ttl = 3600) {
  // Selalu simpan ke memori dulu (reliable dalam satu warm instance)
  mem.set(key, value);

  if (!REDIS_URL || !REDIS_TOKEN) {
    console.log(`[Store] no Redis config, mem-only SET "${key}"`);
    return true;
  }

  const jsonVal = JSON.stringify(value);

  try {
    // Upstash pipeline: POST /pipeline dengan array commands
    // ["SET", key, value, "EX", ttl]
    const r = await fetch(`${REDIS_URL}/pipeline`, {
      method: 'POST',
      headers: redisHeaders(),
      body: JSON.stringify([
        ['SET', key, jsonVal, 'EX', String(ttl)],
      ]),
    });

    const body = await r.json();
    const ok = r.ok && Array.isArray(body) && body[0]?.result === 'OK';
    console.log(`[Store] Redis SET "${key}" → HTTP ${r.status} result=${body[0]?.result} ${ok ? '✅' : '⚠️'}`);
    if (!ok) console.warn('[Store] Redis SET unexpected response:', JSON.stringify(body));
  } catch (e) {
    console.warn(`[Store] Redis SET error for "${key}":`, e.message, '— mem fallback ok');
  }

  return true;
}

// ── GET via Upstash pipeline ───────────────────────────────────────────────────
async function rGet(key) {
  // 1. Memory hit
  if (mem.has(key)) {
    console.log(`[Store] mem HIT "${key}"`);
    return mem.get(key);
  }

  if (!REDIS_URL || !REDIS_TOKEN) {
    console.log(`[Store] no Redis config, "${key}" not in mem → null`);
    return null;
  }

  try {
    const r = await fetch(`${REDIS_URL}/pipeline`, {
      method: 'POST',
      headers: redisHeaders(),
      body: JSON.stringify([
        ['GET', key],
      ]),
    });

    if (!r.ok) {
      console.warn(`[Store] Redis GET HTTP ${r.status} for "${key}"`);
      return null;
    }

    const body = await r.json();
    const result = body[0]?.result;
    console.log(`[Store] Redis GET "${key}" → ${result === null ? 'null' : typeof result === 'string' ? result.slice(0, 80) + '…' : JSON.stringify(result).slice(0, 80)}`);

    if (result === null || result === undefined) return null;

    // result adalah JSON string yang kita simpan
    let parsed;
    try {
      parsed = JSON.parse(result);
    } catch {
      // Mungkin string biasa (untuk txIndex: sessionId string)
      parsed = result;
    }

    // Unwrap kalau ada format lama yang tersisa
    parsed = unwrap(parsed);

    // Cache ke mem untuk request berikutnya dalam instance yang sama
    if (parsed !== null && parsed !== undefined) mem.set(key, parsed);

    return parsed;
  } catch (e) {
    console.error(`[Store] Redis GET error for "${key}":`, e.message);
    return null;
  }
}

// ── DEL ───────────────────────────────────────────────────────────────────────
async function rDel(key) {
  mem.delete(key);
  if (!REDIS_URL || !REDIS_TOKEN) return;
  try {
    await fetch(`${REDIS_URL}/pipeline`, {
      method: 'POST',
      headers: redisHeaders(),
      body: JSON.stringify([['DEL', key]]),
    });
  } catch (e) { console.error('[Store] DEL error:', e.message); }
}

// ── Atomic-ish counter for fixed-window rate limiting ─────────────────────────
async function rIncr(key, ttl) {
  if (!REDIS_URL || !REDIS_TOKEN) {
    const current = Number(mem.get(key) || 0) + 1;
    mem.set(key, current);
    return current;
  }
  try {
    const r = await fetch(`${REDIS_URL}/pipeline`, {
      method: 'POST',
      headers: redisHeaders(),
      body: JSON.stringify([
        ['INCR', key],
        ['EXPIRE', key, String(ttl)],
      ]),
    });
    const body = await r.json();
    const count = Number(body[0]?.result);
    if (Number.isFinite(count)) return count;
  } catch (e) {
    console.warn(`[Store] rate counter error for "${key}":`, e.message);
  }
  const fallback = Number(mem.get(key) || 0) + 1;
  mem.set(key, fallback);
  return fallback;
}

// ── Public API ────────────────────────────────────────────────────────────────
export const sessions = {
  async set(key, value) {
    const k = key.toUpperCase();
    console.log(`[Store] SET session "${k}" status=${value?.status}`);
    return rSet(k, value, 7 * 24 * 3600); // 7 hari — bukan 1 jam!
  },

  async get(key) {
    const k = key.toUpperCase();
    const raw = await rGet(k);
    return raw ? unwrap(raw) : null;
  },

  // Index: txId → sessionId (untuk receipt page dan PDF download)
  async setTxIndex(txId, sessionId) {
    if (!txId || !sessionId) {
      console.warn('[Store] setTxIndex: txId atau sessionId kosong, skip');
      return;
    }
    const key = `tx:${txId}`;
    console.log(`[Store] txIndex SET "${key}" → "${sessionId}"`);
    // txId index simpan sebagai plain string, TTL 30 hari
    return rSet(key, sessionId, 30 * 24 * 3600);
  },

  async getByTxId(txId) {
    if (!txId) return null;
    const key = `tx:${txId}`;
    const val = await rGet(key);
    if (!val) return null;
    // val harusnya string sessionId
    if (typeof val === 'string') return val;
    // Edge case: kalau unwrap hasilkan object
    return val?.sessionId || String(val) || null;
  },

  async del(key) {
    return rDel(key.toUpperCase());
  },

  // Baru: Scan semua session keys untuk dashboard
  async getAllSessions() {
    if (!REDIS_URL || !REDIS_TOKEN) {
      // Fallback memori saja
      const results = {};
      for (const [k, v] of mem.entries()) {
        if (!k.startsWith('tx:') && !k.startsWith('admin:')) results[k] = v;
      }
      return results;
    }

    try {
      // Karena kita pakai pipeline, kita bisa pakai SCAN atau KEYS (KEYS lebih mudah untuk dataset kecil)
      const r = await fetch(`${REDIS_URL}/pipeline`, {
        method: 'POST',
        headers: redisHeaders(),
        body: JSON.stringify([['KEYS', '*']]),
      });
      const body = await r.json();
      const keys = body[0]?.result || [];
      
      const sessionKeys = keys.filter(k => !k.startsWith('tx:') && !k.startsWith('admin:'));
      
      // Ambil semua data session secara batch
      const pipeline = sessionKeys.map(k => ['GET', k]);
      if (pipeline.length === 0) return {};

      const r2 = await fetch(`${REDIS_URL}/pipeline`, {
        method: 'POST',
        headers: redisHeaders(),
        body: JSON.stringify(pipeline),
      });
      const body2 = await r2.json();
      
      const results = {};
      sessionKeys.forEach((k, i) => {
        let val = body2[i]?.result;
        if (val) {
          try { val = JSON.parse(val); } catch { /* ignore */ }
          results[k] = unwrap(val);
        }
      });
      return results;
    } catch (e) {
      console.error('[Store] getAllSessions error:', e.message);
      return {};
    }
  }
};

// ── Admin Security Store ─────────────────────────────────────────────────────
export const adminStore = {
  async getAttempts(fingerprint) {
    return await rGet(`admin:attempts:${fingerprint}`) || 0;
  },
  async incrementAttempts(fingerprint) {
    const current = await this.getAttempts(fingerprint);
    await rSet(`admin:attempts:${fingerprint}`, current + 1, 5 * 3600);
    return current + 1;
  },
  async isLocked(fingerprint) {
    return await rGet(`admin:lock:${fingerprint}`) === true;
  },
  async lock(fingerprint) {
    await rSet(`admin:lock:${fingerprint}`, true, 5 * 3600);
  },
  async unlock(fingerprint) {
    await rDel(`admin:lock:${fingerprint}`);
    await rDel(`admin:attempts:${fingerprint}`);
  },
  async createUnlockToken(token, data) {
    await rSet(`admin:unlock:${token}`, data, 5 * 3600);
    return token;
  },
  async verifyUnlockToken(token) {
    const key = `admin:unlock:${token}`;
    const value = await rGet(key);
    if (value) await rDel(key);
    return value || null;
  },
  async createSession(token, data) {
    return rSet(`admin:session:${token}`, data, 8 * 3600);
  },
  async getSession(token) {
    return rGet(`admin:session:${token}`);
  },
  async deleteSession(token) {
    return rDel(`admin:session:${token}`);
  }
};


export const rateLimitStore = {
  async check(scope, identifier, limit = 60, windowSeconds = 60) {
    const bucket = Math.floor(Date.now() / 1000 / windowSeconds);
    const digest = crypto.createHash('sha256').update(String(identifier || 'unknown')).digest('hex').slice(0, 32);
    const key = `rate:${scope}:${digest}:${bucket}`;
    const count = await rIncr(key, windowSeconds + 5);
    return {
      allowed: count <= limit,
      count,
      limit,
      resetAt: (bucket + 1) * windowSeconds * 1000,
    };
  },
};
