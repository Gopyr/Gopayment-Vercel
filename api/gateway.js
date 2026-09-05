import { createPaymentSession, enforceGatewayRateLimit, requireGatewayAuth, getGatewaySession } from './_gateway.js';
import { sessions } from './_store.js';

async function runPaymentCheck(req, sessionId) {
  const protocol = req.headers['x-forwarded-proto'] || 'https';
  const host = req.headers.host;
  const response = await fetch(`${protocol}://${host}/api/check-payment`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sessionId }),
  });
  return response.json().catch(() => ({}));
}

async function handleCreate(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  if (!(await enforceGatewayRateLimit(req, res, 'create'))) return;
  if (!requireGatewayAuth(req)) return res.status(401).json({ error: 'Invalid or missing API Key.' });
  const { nama, tentang, nominal, callbackUrl } = req.body || {};
  if (!nama || !tentang || !nominal) return res.status(400).json({ error: 'nama, tentang, and nominal are required.' });
  try {
    const session = await createPaymentSession({ nama, tentang, nominal, callbackUrl });
    const protocol = req.headers['x-forwarded-proto'] || 'http';
    const host = req.headers.host;
    const paymentUrl = `${protocol}://${host}/pay/${session.sessionId}`;
    return res.status(200).json({
      success: true, sessionId: session.sessionId, paymentUrl, totalBayar: session.totalBayar,
      statusUrl: `${protocol}://${host}/api/gateway?action=status&sessionId=${session.sessionId}`
    });
  } catch (e) { return res.status(500).json({ error: e.message }); }
}

async function handleStatus(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });
  if (!(await enforceGatewayRateLimit(req, res, 'status'))) return;
  if (!requireGatewayAuth(req)) return res.status(401).json({ error: 'Invalid or missing API Key.' });
  const sessionId = String(req.query?.sessionId || '').toUpperCase();
  if (!sessionId) return res.status(400).json({ error: 'sessionId is required.' });
  try {
    let data = await getGatewaySession(sessionId);
    if (!data) return res.status(404).json({ error: 'Session not found.' });
    let checkResult = null;
    if (data.status === 'pending') {
      checkResult = await runPaymentCheck(req, sessionId);
      data = await sessions.get(sessionId) || data;
    }
    const confirmed = data.status === 'success';
    return res.status(200).json({
      success: true, confirmed, sessionId, status: confirmed ? 'success' : (data.status || 'pending'),
      totalBayar: data.totalBayar, txId: data.txId || null, paidAt: data.waktu || null,
      checkedAt: new Date().toISOString(),
      check: checkResult ? { found: Boolean(checkResult.found), timedOut: Boolean(checkResult.timedOut) } : null,
    });
  } catch (e) { return res.status(502).json({ error: 'Gagal mengecek status pembayaran.' }); }
}

async function handlePayment(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });
  if (!(await enforceGatewayRateLimit(req, res, 'payment'))) return;
  const sessionId = String(req.query?.sessionId || '').toUpperCase();
  if (!sessionId) return res.status(400).json({ error: 'sessionId is required.' });
  const session = await getGatewaySession(sessionId);
  if (!session) return res.status(404).json({ error: 'Payment session not found.' });
  return res.status(200).json({
    sessionId, nama: session.nama, tentang: session.tentang, nominal: session.nominal,
    surcharge: session.surcharge, totalBayar: session.totalBayar, status: session.status,
    qrisDataUrl: session.qrisDataUrl || null, txId: session.txId || null,
    waktu: session.waktu || null, createdAt: session.createdAt,
  });
}

export default async function handler(req, res) {
  const action = req.query?.action;
  if (action === 'create') return handleCreate(req, res);
  if (action === 'status') return handleStatus(req, res);
  if (action === 'payment') return handlePayment(req, res);
  return res.status(404).json({ error: 'Action not found' });
}
