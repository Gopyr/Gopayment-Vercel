// api/check-payment.js
// Browser poll ini setiap 5 detik (dan bisa manual).
// Setiap request: login GoBiz → tarik history → cari exact match totalBayar.
// Kalau ketemu → update session success + kirim Discord.

import GoPayMerchant from './_gobiz.js';
import { sessions } from './_store.js';
import { withDebugLogging } from './_debug_webhook.js';
import { sendGatewayCallback } from './_gateway.js';

async function sendDiscordWebhook(session) {
  const webhookUrl = process.env.DISCORD_WEBHOOK_URL;
  if (!webhookUrl) { console.log('[Webhook] DISCORD_WEBHOOK_URL tidak diset, skip.'); return; }

  const { nama, tentang, nominal, surcharge, totalBayar, txId, waktu, sessionId, issuer, meta } = session;

  const APP_URL     = process.env.APP_URL || 'https://your-app.vercel.app';
  const receiptLink = `${APP_URL}/?receipt=${encodeURIComponent(txId)}`;
  const fmtRp = n => `Rp ${Number(n).toLocaleString('id-ID')}`;
  
  // Hanya tampilkan nama bank/issuer pengirim saja
  const bankName = issuer || '-';

  const receiptBlock = [
    `Nama          : ${nama}`,
    `Keterangan    : ${tentang}`,
    `Nominal       : ${fmtRp(nominal)}`,
    `Waktu         : ${waktu}`,
    `Link Bukti    : ${receiptLink}`,
    ``,
    `── Detail Transaksi ──`,
    `Total Dibayar : ${fmtRp(totalBayar)}`,
    `Pajak Unik    : +Rp ${surcharge}`,
    `Bank          : ${bankName}`,
    `Metode        : ${(meta?.paymentType || 'QRIS').toUpperCase()}`,
    `ID Transaksi  : ${txId || '-'}`,
  ].join('\n');

  const embedPayload = {
    content: `💰 **Pembayaran baru masuk!**`,
    username: 'Gpayment Notification',
    embeds: [{
      title: '✅ Pembayaran Berhasil Diterima',
      url: receiptLink,
      color: 0x2D9B6F,
      description: `\`\`\`\n${receiptBlock}\n\`\`\``,
      footer: {
        text: `Gpayment • ${waktu}`,
        icon_url: 'https://raw.githubusercontent.com/Gopyr/Gopayment-Vercel/main/public/favicon.svg'
      },
      timestamp: new Date().toISOString(),
    }],
    components: [{
      type: 1,
      components: [{
        type: 2,
        style: 5,
        label: '📋 Lihat Bukti Pembayaran',
        url: receiptLink,
      }],
    }],
  };

  // ── Kirim embed ke Discord ──
  try {
    const r = await fetch(webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(embedPayload),
    });
    console.log(`[Webhook] ${r.ok ? '✅' : '❌'} status=${r.status}`);
    if (!r.ok) console.error('[Webhook] body:', await r.text());
  } catch (e) {
    console.error('[Webhook] Error:', e.message);
  }
}

async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { sessionId } = req.body || {};
  if (!sessionId) return res.status(400).json({ error: 'sessionId wajib.' });

  // ── 1. Ambil session dari store ──────────────────────────────────────────────
  const session = await sessions.get(sessionId.toUpperCase());

  if (!session) {
    console.log(`[CheckPay/${sessionId}] session null / not found`);
    return res.status(404).json({ error: 'Session tidak ditemukan.' });
  }

  console.log(`[CheckPay/${sessionId}] session:`, JSON.stringify(session).slice(0, 200));

  // Guard: pastikan session punya field yang diperlukan
  if (typeof session.totalBayar !== 'number') {
    console.error(`[CheckPay/${sessionId}] ❌ session.totalBayar bukan number:`, session.totalBayar,
      '| full session:', JSON.stringify(session));
    return res.status(500).json({
      error: 'Data sesi rusak (totalBayar tidak valid). Buat tagihan baru.',
      debug: { totalBayar: session.totalBayar, keys: Object.keys(session) },
    });
  }

  // Kalau sudah selesai sebelumnya, return langsung
  if (session.status === 'success') return res.status(200).json({ found: true,  session });
  if (session.status === 'timeout') return res.status(200).json({ found: false, timedOut: true });

  const { totalBayar, nominal, surcharge, nama, tentang } = session;
  console.log(`[CheckPay/${sessionId}] → HIT GoBiz API, mencari totalBayar=${totalBayar}`);

  // ── 2. Login GoBiz ───────────────────────────────────────────────────────────
  let merchant;
  try {
    merchant = new GoPayMerchant();
    await merchant.init();
    console.log(`[CheckPay/${sessionId}] Merchant OK, id=${merchant.merchantId}`);
  } catch (e) {
    console.error(`[CheckPay/${sessionId}] ❌ Merchant init:`, e.message);
    return res.status(500).json({ error: 'Gagal terhubung ke payment API: ' + e.message });
  }

  // ── 3. Tarik history transaksi ────────────────────────────────────────────────
  let historyResult;
  try {
    historyResult = await merchant.getHistory({ days: 1, size: 50 });
    console.log(`[CheckPay/${sessionId}] getHistory status=${historyResult?.status}, count=${historyResult?.data?.histories?.length}`);
  } catch (e) {
    console.error(`[CheckPay/${sessionId}] ❌ getHistory:`, e.message);
    return res.status(500).json({ error: 'Gagal ambil riwayat transaksi: ' + e.message });
  }

  if (!historyResult?.status || !Array.isArray(historyResult?.data?.histories)) {
    console.warn(`[CheckPay/${sessionId}] ⚠️ Format history tidak dikenali:`, JSON.stringify(historyResult).slice(0,300));
    return res.status(200).json({ found: false, reason: 'Format history tidak dikenali.' });
  }

  const histories = historyResult.data.histories;
  console.log(`[CheckPay/${sessionId}] ${histories.length} transaksi, mencari ${totalBayar}`);

  // ── 4. Cari exact match totalBayar ────────────────────────────────────────────
  // gross_amount dari API dalam SEN → ÷100 = Rupiah (confirmed dari debug output)
  let matched = null;
  for (const entry of histories) {
    const raw = entry.raw || {};
    const txAmount = typeof raw.gross_amount === 'number' ? raw.gross_amount / 100 : 0;

    console.log(`[CheckPay/${sessionId}] cek: id=${raw.id} gross=${raw.gross_amount} parsed=${txAmount} target=${totalBayar} match=${txAmount === totalBayar}`);

    if (txAmount === totalBayar) {
      matched = { raw, entry };
      break;
    }
  }

  // ── 5. Tidak ketemu ───────────────────────────────────────────────────────────
  if (!matched) {
    const latestAmounts = histories.slice(0, 5).map(e => {
      const r = e.raw || {};
      return typeof r.gross_amount === 'number' ? r.gross_amount / 100 : 0;
    });
    console.log(`[CheckPay/${sessionId}] ❌ Tidak match. Latest amounts:`, latestAmounts);
    return res.status(200).json({
      found: false,
      checked: histories.length,
      looking_for: totalBayar,
      latest_amounts: latestAmounts,
    });
  }

  // ── 6. MATCH! ─────────────────────────────────────────────────────────────────
  const { raw } = matched;
  const txId  = raw.id ?? raw.order_id ?? raw.wallstreet_transaction_id ?? '-';
  const waktu = matched.entry.time
    || new Date().toLocaleString('id-ID', { timeZone: 'Asia/Jakarta' });
  const meta = {
    issuer:      raw.qris_provider_aspi_issuer   || null,
    acquirer:    raw.qris_provider_aspi_acquirer  || null,
    orderId:     raw.order_id                     || null,
    paymentType: raw.payment_type                 || 'QRIS',
    channelType: raw.channel_type                 || null,
  };

  console.log(`[CheckPay/${sessionId}] ✅ MATCH! txId=${txId} issuer=${meta.issuer} amount=${totalBayar}`);

  const updated = {
    ...session, status: 'success', txId, waktu,
    issuer: meta.issuer, orderId: meta.orderId, meta,
  };
  await sessions.set(sessionId.toUpperCase(), updated);

  // Simpan index txId → sessionId untuk share link / receipt page / PDF
  await sessions.setTxIndex(txId, sessionId.toUpperCase());

  // Discord webhook — hanya saat pertama kali confirmed (1 embed + PDF attach + tag user)
  await sendDiscordWebhook(updated);

  // Gateway Callback — kirim notifikasi ke server aplikasi eksternal (jika ada)
  if (updated.isGateway && updated.callbackUrl) {
    await sendGatewayCallback(updated);
  }

  return res.status(200).json({ found: true, session: updated });
}

export default withDebugLogging(handler);
