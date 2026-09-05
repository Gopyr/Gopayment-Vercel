// api/create-payment.js — Vercel Serverless Function
// Fix: surcharge unik 1-100 utk exact match, tanpa branding gopay, error handler lengkap
import crc from 'crc';
import QRCode from 'qrcode';
import crypto from 'node:crypto';
// GoBiz init hanya untuk validasi QRIS env — payment check dilakukan di /api/check-payment
// import GoPayMerchant tidak diperlukan di sini lagi
import { sessions } from './_store.js';
import { withDebugLogging } from './_debug_webhook.js';

// ─── QRIS Builder ─────────────────────────────────────────────────────────────
function convertCRC16(str) {
  const crc16 = crc.crc16ccitt(Buffer.from(str, 'utf8')).toString(16).toUpperCase();
  return ('0000' + crc16).slice(-4);
}

function buildDynamicQris(staticQris, amount) {
  if (!staticQris || typeof staticQris !== 'string' || staticQris.length < 10) {
    throw new Error('QRIS_STRING tidak valid atau terlalu pendek.');
  }

  // Trim whitespace/newlines yang mungkin ikut saat copy-paste
  const trimmed = staticQris.trim();
  const data = trimmed.endsWith('6304') ? trimmed : trimmed.slice(0, -4);
  const step1 = data.replace('010211', '010212');

  if (!step1.includes('5802ID')) {
    throw new Error(
      'Format QRIS tidak valid — tidak ditemukan tag 5802ID. ' +
      'Pastikan QRIS_STRING benar (scan ulang dari gambar QRIS merchant).'
    );
  }

  const amountStr = String(amount);
  const [before, after] = step1.split('5802ID');
  const nominalField = '54' + String(amountStr.length).padStart(2, '0') + amountStr;
  const raw = before + nominalField + '5802ID' + after;
  return raw + convertCRC16(raw);
}

// ─── Handler ─────────────────────────────────────────────────────────────────
async function handler(req, res) {
  // CORS preflight (untuk dev)
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  // ── Validasi input ──
  const { nama, tentang, nominal } = req.body || {};

  if (!nama || typeof nama !== 'string' || nama.trim().length === 0) {
    return res.status(400).json({ error: 'Nama wajib diisi.' });
  }
  if (!tentang || typeof tentang !== 'string' || tentang.trim().length === 0) {
    return res.status(400).json({ error: 'Tentang pembayaran wajib diisi.' });
  }
  if (!nominal) {
    return res.status(400).json({ error: 'Nominal wajib diisi.' });
  }

  const amount = parseInt(nominal, 10);
  if (isNaN(amount) || amount < 1) {
    return res.status(400).json({ error: 'Nominal tidak valid. Masukkan angka positif.' });
  }
  if (amount > 100_000_000) {
    return res.status(400).json({ error: 'Nominal maksimum Rp 100.000.000.' });
  }

  // ── Cek env vars penting ──
  const QRIS_STRING = process.env.QRIS_STRING;
  if (!QRIS_STRING) {
    console.error('[Create] ❌ QRIS_STRING tidak diset di environment');
    return res.status(500).json({ error: 'Konfigurasi server belum lengkap (QRIS_STRING).' });
  }
  if (!process.env.GOPAY_EMAIL || !process.env.GOPAY_PASSWORD) {
    console.error('[Create] ❌ GOPAY_EMAIL atau GOPAY_PASSWORD tidak diset');
    return res.status(500).json({ error: 'Konfigurasi server belum lengkap (credentials).' });
  }

  // ── Generate surcharge unik 1–100 ──
  // totalBayar = amount + surcharge → watcher match exact ke totalBayar
  const surcharge = Math.floor(Math.random() * 100) + 1; // 1-100
  const totalBayar = amount + surcharge;

  console.log(`[Create] nama=${nama.trim()}, nominal=${amount}, surcharge=${surcharge}, total=${totalBayar}`);

  // ── Build QRIS dengan totalBayar ──
  let dynamicQris;
  try {
    dynamicQris = buildDynamicQris(QRIS_STRING, totalBayar);
  } catch (e) {
    console.error('[Create] ❌ buildDynamicQris error:', e.message);
    return res.status(500).json({ error: e.message });
  }

  let qrisDataUrl;
  try {
    qrisDataUrl = await QRCode.toDataURL(dynamicQris, {
      scale: 8,
      errorCorrectionLevel: 'M',
      margin: 2,
    });
  } catch (e) {
    console.error('[Create] ❌ QR generate error:', e.message);
    return res.status(500).json({ error: 'Gagal generate kode QR: ' + e.message });
  }

  // ── Buat session ──
  const sessionId = crypto.randomUUID().slice(0, 8).toUpperCase();

  try {
    const ok = await sessions.set(sessionId, {
      nama: nama.trim(),
      tentang: tentang.trim(),
      nominal: amount,
      surcharge,
      totalBayar,
      status: 'pending',
      txId: null,
      waktu: null,
      createdAt: new Date().toISOString(),
    });

    if (!ok) {
      console.error(`[Create/${sessionId}] ❌ Gagal simpan session`);
      return res.status(500).json({ error: 'Gagal membuat sesi pembayaran.' });
    }

    console.log(`[Create/${sessionId}] ✅ Session dibuat — Rp ${amount} + ${surcharge} = Rp ${totalBayar}`);
  } catch (e) {
    console.error(`[Create/${sessionId}] ❌ Store error:`, e.message);
    return res.status(500).json({ error: 'Gagal menyimpan sesi: ' + e.message });
  }

  return res.status(200).json({
    sessionId,
    qrisDataUrl,
    nominal: amount,
    surcharge,
    totalBayar,
  });
}

export default withDebugLogging(handler);
