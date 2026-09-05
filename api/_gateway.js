import crypto from 'node:crypto';
import crc from 'crc';
import QRCode from 'qrcode';
import { rateLimitStore, sessions } from './_store.js';

function convertCRC16(str) {
  const crc16 = crc.crc16ccitt(Buffer.from(str, 'utf8')).toString(16).toUpperCase();
  return ('0000' + crc16).slice(-4);
}

export function buildDynamicQris(staticQris, amount) {
  if (!staticQris || typeof staticQris !== 'string' || staticQris.length < 10) {
    throw new Error('QRIS_STRING tidak valid.');
  }
  const trimmed = staticQris.trim();
  const data = trimmed.endsWith('6304') ? trimmed : trimmed.slice(0, -4);
  const step1 = data.replace('010211', '010212');
  if (!step1.includes('5802ID')) throw new Error('Format QRIS tidak valid.');

  const amountStr = String(amount);
  const [before, after] = step1.split('5802ID');
  const nominalField = '54' + String(amountStr.length).padStart(2, '0') + amountStr;
  const raw = before + nominalField + '5802ID' + after;
  return raw + convertCRC16(raw);
}

export async function createPaymentSession({ nama, tentang, nominal, callbackUrl }) {
  const amount = parseInt(nominal, 10);
  if (isNaN(amount) || amount < 1) throw new Error('Nominal tidak valid.');

  const QRIS_STRING = process.env.QRIS_STRING;
  if (!QRIS_STRING) throw new Error('Konfigurasi QRIS_STRING belum lengkap.');

  const surcharge = Math.floor(Math.random() * 100) + 1;
  const totalBayar = amount + surcharge;
  const dynamicQris = buildDynamicQris(QRIS_STRING, totalBayar);

  const qrisDataUrl = await QRCode.toDataURL(dynamicQris, {
    scale: 8, errorCorrectionLevel: 'M', margin: 2,
  });

  let normalizedCallbackUrl = null;
  if (callbackUrl !== undefined && callbackUrl !== null && String(callbackUrl).trim() !== '') {
    try {
      const parsed = new URL(String(callbackUrl).trim());
      const localHost = ['localhost', '127.0.0.1', '[::1]', '::1'].includes(parsed.hostname);
      if (!['https:', 'http:'].includes(parsed.protocol) || (parsed.protocol === 'http:' && !localHost)) {
        throw new Error('callbackUrl harus menggunakan HTTPS.');
      }
      normalizedCallbackUrl = parsed.toString();
    } catch {
      throw new Error('callbackUrl harus berupa URL HTTPS yang valid.');
    }
  }

  const sessionId = crypto.randomUUID().slice(0, 8).toUpperCase();
  await sessions.set(sessionId, {
    sessionId,
    nama: nama.trim(),
    tentang: tentang.trim(),
    nominal: amount,
    surcharge,
    totalBayar,
    status: 'pending',
    txId: null,
    waktu: null,
    createdAt: new Date().toISOString(),
    qrisDataUrl,
    isGateway: true,
    callbackUrl: normalizedCallbackUrl
  });

  return { sessionId, qrisDataUrl, nominal: amount, surcharge, totalBayar };
}

function requestIdentity(req) {
  const apiKey = req.headers['x-api-key'];
  if (apiKey) return `key:${apiKey}`;
  const forwarded = req.headers['x-forwarded-for'];
  return `ip:${String(forwarded || req.socket?.remoteAddress || 'unknown').split(',')[0].trim()}`;
}

export async function enforceGatewayRateLimit(req, res, action) {
  const policy = {
    create: { limit: 20, window: 60 },
    status: { limit: 120, window: 60 },
    payment: { limit: 120, window: 60 },
  }[action] || { limit: 60, window: 60 };
  const result = await rateLimitStore.check(`gateway:${action}`, requestIdentity(req), policy.limit, policy.window);
  res.setHeader('X-RateLimit-Limit', String(result.limit));
  res.setHeader('X-RateLimit-Remaining', String(Math.max(0, result.limit - result.count)));
  res.setHeader('X-RateLimit-Reset', String(Math.ceil(result.resetAt / 1000)));
  if (!result.allowed) {
    res.setHeader('Retry-After', String(Math.max(1, Math.ceil((result.resetAt - Date.now()) / 1000))));
    res.status(429).json({ error: 'Too many requests. Coba lagi setelah beberapa saat.' });
    return false;
  }
  return true;
}

export function requireGatewayAuth(req) {
  const apiKey = req.headers['x-api-key'] || req.query?.api_key;
  const validKey = process.env.GATEWAY_API_KEY;
  if (!validKey) return false; // Safety: must be configured
  return apiKey === validKey;
}

export function createGatewaySignature(payloadOrBody) {
  const secret = process.env.GATEWAY_API_KEY;
  if (!secret) return '';
  const body = typeof payloadOrBody === 'string' ? payloadOrBody : JSON.stringify(payloadOrBody);
  return crypto.createHmac('sha256', secret)
    .update(body)
    .digest('hex');
}

export async function sendGatewayCallback(session) {
  if (!session.callbackUrl) return;



  const payload = {
    event: 'payment.success',
    sessionId: session.sessionId,
    txId: session.txId,
    status: 'success',
    totalBayar: session.totalBayar,
    paidAt: session.waktu,
    timestamp: new Date().toISOString()
  };

  const body = JSON.stringify(payload);
  const signature = createGatewaySignature(body);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10000);

  try {
    console.log(`[GatewayCallback] Sending to ${session.callbackUrl}...`);
    const res = await fetch(session.callbackUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-gpayment-signature': signature,
        'User-Agent': 'Gpayment-Webhook/1.0'
      },
      body,
      signal: controller.signal,
    });
    console.log(`[GatewayCallback] Status: ${res.status}`);
  } catch (e) {
    console.error(`[GatewayCallback] Failed to send to ${session.callbackUrl}:`, e.message);
  } finally {
    clearTimeout(timeout);
  }
}

export async function getGatewaySession(sessionId) {
  const session = await sessions.get(sessionId);
  if (!session || !session.isGateway) return null;
  const createdAt = Date.parse(session.createdAt || '');
  const expired = session.status === 'pending' && Number.isFinite(createdAt) && Date.now() - createdAt >= 10 * 60 * 1000;
  if (!expired) return session;
  const updated = { ...session, status: 'timeout' };
  await sessions.set(sessionId, updated);
  return updated;
}
