// api/status/[sessionId].js — Vercel Serverless Function
import { sessions } from '../_store.js';
import { withDebugLogging } from '../_debug_webhook.js';

async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Content-Type', 'application/json');

  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  const { sessionId } = req.query;

  if (!sessionId || typeof sessionId !== 'string') {
    return res.status(400).json({ error: 'Session ID tidak valid.' });
  }

  let session;
  try {
    session = await sessions.get(sessionId.toUpperCase());
  } catch (e) {
    console.error(`[Status/${sessionId}] ❌ Store error:`, e.message);
    return res.status(500).json({ error: 'Gagal membaca status sesi.' });
  }

  if (!session) {
    return res.status(404).json({ error: 'Sesi tidak ditemukan atau sudah kedaluwarsa.' });
  }

  return res.status(200).json(session);
}

export default withDebugLogging(handler);
