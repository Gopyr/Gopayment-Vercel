// gobiz.js — Modifikasi untuk Vercel (tanpa curl, tanpa fs cache)
// Sumber asli: https://github.com/kavionn/gobiz-payment

import moment from "moment-timezone";
import crypto from "crypto";
import { EventEmitter } from "node:events";

const BASE_URL = 'https://api.gobiz.co.id';
const CLIENT_ID = 'go-biz-web-new';

// ─── In-memory cache (Vercel serverless: stateless per-invocation) ────────────
// Token bisa hidup selama warm instance. Cold start = login ulang.
let _cachedToken = null;
let _cachedMerchantId = null;

function generateUUID() {
  return crypto.randomUUID();
}

function getAuthHeaders(uniqueId, accessToken) {
  return {
    'Accept': 'application/json, text/plain, */*',
    'Accept-Language': 'id',
    'Authentication-Type': 'go-id',
    'Authorization': accessToken ? `Bearer ${accessToken}` : 'Bearer',
    'Connection': 'keep-alive',
    'Content-Type': 'application/json',
    'Gojek-Country-Code': 'ID',
    'Gojek-Timezone': 'Asia/Jakarta',
    'Origin': 'https://portal.gofoodmerchant.co.id',
    'Referer': 'https://portal.gofoodmerchant.co.id/',
    'Sec-Fetch-Dest': 'empty',
    'Sec-Fetch-Mode': 'cors',
    'Sec-Fetch-Site': 'cross-site',
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36',
    'X-AppVersion': 'platform-v3.107.0-94ce5d57',
    'X-PhoneMake': 'Windows 10 64-bit',
    'X-PhoneModel': 'Chrome 149.0.0.0 on Windows 10 64-bit',
    'X-Platform': 'Web',
    'X-User-Locale': 'en-US',
    'X-User-Type': 'merchant',
    'sec-ch-ua': '"Google Chrome";v="149", "Chromium";v="149", "Not)A;Brand";v="24"',
    'sec-ch-ua-mobile': '?0',
    'sec-ch-ua-platform': '"Windows"',
    'x-DeviceOS': 'Web',
    'x-appId': 'go-biz-web-dashboard',
    'x-uniqueid': uniqueId,
  };
}

// ─── Login via fetch (ganti curl dari original) ────────────────────────────────
async function loginWithPassword(email, password) {
  const uniqueId = generateUUID();
  const headers = getAuthHeaders(uniqueId);

  console.log(`[Auth] Memvalidasi email: ${email}`);
  const reqRes = await fetch(`${BASE_URL}/goid/login/request`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ email, login_type: 'password', client_id: CLIENT_ID }),
  });
  const valData = await reqRes.json();
  if (valData.errors?.length > 0) {
    console.warn(`[Auth] Peringatan validasi email: ${valData.errors[0].message}`);
  }

  console.log('[Auth] Mengirim kredensial login...');
  const tokenRes = await fetch(`${BASE_URL}/goid/token`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      client_id: CLIENT_ID,
      grant_type: 'password',
      data: { email, password },
    }),
  });
  const tokenData = await tokenRes.json();
  if (tokenData.errors?.length > 0) {
    throw new Error(`Login gagal: ${tokenData.errors[0].message || 'Password salah atau akun bermasalah'}`);
  }

  return {
    access_token: tokenData.access_token,
    refresh_token: tokenData.refresh_token,
    expires_in: tokenData.expires_in,
  };
}

async function getUserMerchants(accessToken) {
  const uniqueId = generateUUID();
  console.log('[Auth] Mengambil daftar merchant...');
  const response = await fetch(`${BASE_URL}/v1/merchants/search`, {
    method: 'POST',
    headers: getAuthHeaders(uniqueId, accessToken),
    body: JSON.stringify({ from: 0, to: 50, _source: ['id', 'merchant_name'] }),
  });
  const resData = await response.json();
  if (!response.ok) {
    throw new Error(`Gagal mengambil list merchant (${response.status}): ${resData?.errors?.[0]?.message || 'Gagal autentikasi'}`);
  }
  return resData;
}

export default class GoPayMerchant {
  constructor(options = {}) {
    this.token = options.token || _cachedToken || null;
    this.merchantId = options.merchantId || _cachedMerchantId || null;
    this._initialized = false;
  }

  async _isTokenValid(token) {
    try {
      const uniqueId = generateUUID();
      const res = await fetch(`${BASE_URL}/v1/merchants/search`, {
        method: 'POST',
        headers: getAuthHeaders(uniqueId, token),
        body: JSON.stringify({ from: 0, to: 1, _source: ['id'] }),
      });
      return res.status !== 401;
    } catch {
      return false;
    }
  }

  async _doLogin() {
    const email = process.env.GOPAY_EMAIL;
    const password = process.env.GOPAY_PASSWORD;

    if (!email || !password) {
      throw new Error('[GoPayMerchant] GOPAY_EMAIL/GOPAY_PASSWORD belum diisi di environment variables');
    }

    console.log(`[GoPayMerchant] Login otomatis sebagai: ${email}`);
    const authData = await loginWithPassword(email, password);
    this.token = authData.access_token;
    _cachedToken = this.token; // simpan ke module-level cache
    console.log('[GoPayMerchant] Login berhasil.');
  }

  async init() {
    if (this._initialized) return;

    // Coba pakai token dari module-level cache
    if (!this.token && _cachedToken) {
      this.token = _cachedToken;
    }

    if (!this.token || !(await this._isTokenValid(this.token))) {
      console.log('[GoPayMerchant] Token tidak valid atau belum ada, login ulang...');
      await this._doLogin();
    }

    if (!this.merchantId && _cachedMerchantId) {
      this.merchantId = _cachedMerchantId;
    }

    if (!this.merchantId) {
      console.log('[GoPayMerchant] Mendeteksi Merchant ID secara otomatis...');
      const merchants = await getUserMerchants(this.token);

      let merchantList = [];
      if (Array.isArray(merchants)) {
        merchantList = merchants;
      } else if (merchants?.merchants && Array.isArray(merchants.merchants)) {
        merchantList = merchants.merchants;
      } else if (merchants?.hits && Array.isArray(merchants.hits)) {
        merchantList = merchants.hits;
      } else if (merchants?.hits?.hits && Array.isArray(merchants.hits.hits)) {
        merchantList = merchants.hits.hits.map(h => h._source || h);
      } else if (merchants?.data && Array.isArray(merchants.data)) {
        merchantList = merchants.data;
      }

      if (merchantList.length === 0) {
        throw new Error('[GoPayMerchant] Tidak ada merchant yang terasosiasi dengan akun ini.');
      }

      this.merchantId = merchantList[0].id || merchantList[0].merchant_id;
      _cachedMerchantId = this.merchantId; // simpan ke module-level cache
      const merchantName = merchantList[0].merchant_name || 'Tidak diketahui';
      console.log(`[GoPayMerchant] Menggunakan merchant: ${merchantName} (ID: ${this.merchantId})`);
    }

    this._initialized = true;
  }

  async getHistory({ days = 1, size = 50 } = {}) {
    try {
      await this.init();
      const data = await this.getTransactionsAnalytics({ days, size });
      const histories = [];

      // ✅ CONFIRMED dari debug output:
      //    API response: data.transactions[] (array langsung)
      //    gross_amount = dalam SEN (29000 = Rp 290), jadi ÷100 BENAR
      //    txId field yang benar: tx.id (bukan tx.transaction_id yang undefined)
      //    qris_provider_aspi_issuer tersedia di level tx langsung
      if (data && Array.isArray(data.transactions)) {
        for (const tx of data.transactions) {
          // gross_amount dalam sen → bagi 100 untuk dapat Rupiah
          const realAmount = typeof tx.gross_amount === 'number' ? tx.gross_amount / 100 : 0;
          const timeFormatted = tx.transaction_time
            ? moment(tx.transaction_time).tz('Asia/Jakarta').locale('id').format('DD MMM YYYY - HH:mm:ss')
            : '';
          histories.push({
            type: 'payin',
            amount: { displayed_text: `Rp ${realAmount}` },
            time: timeFormatted,
            raw: tx, // simpan full object agar watcher bisa akses semua field
          });
        }
        return { status: true, data: { histories } };
      }

      const journalData = await this.getTransactionsJournal({ days, size });
      if (journalData && Array.isArray(journalData.data)) {
        for (const item of journalData.data) {
          const tx = item.metadata?.transaction;
          if (!tx) continue;
          const realAmount = typeof tx.gross_amount === 'number' ? tx.gross_amount / 100 : 0;
          const timeFormatted = tx.transaction_time
            ? moment(tx.transaction_time).tz('Asia/Jakarta').locale('id').format('DD MMM YYYY - HH:mm:ss')
            : '';
          histories.push({
            type: 'payin',
            amount: { displayed_text: `Rp ${realAmount}` },
            time: timeFormatted,
            raw: item,
          });
        }
        return { status: true, data: { histories } };
      }

      return { status: false, message: 'Tidak ada data transaksi yang ditemukan.' };
    } catch (error) {
      return { status: false, message: error.message || 'Terjadi kesalahan saat mengambil riwayat.' };
    }
  }

  async getTransactionsAnalytics({ days = 1, size = 50 } = {}) {
    await this.init();
    const url = new URL('https://api.gojekapi.com/merchant-analytics/v2/merchants/transactions');

    const startTime = moment().subtract(days, 'days').tz('Asia/Jakarta').toISOString();
    const endTime = moment().tz('Asia/Jakarta').toISOString();

    url.searchParams.append('from', '0');
    url.searchParams.append('size', String(size));
    url.searchParams.append('statuses', 'SETTLEMENT,CAPTURE,REFUND,PARTIAL_REFUND');
    url.searchParams.append('payment_types', 'QRIS,GOPAY,OFFLINE_CREDIT_CARD,OFFLINE_DEBIT_CARD,CREDIT_CARD');
    url.searchParams.append('start_time', startTime);
    url.searchParams.append('end_time', endTime);
    url.searchParams.append('merchant_ids', this.merchantId);

    const headers = {
      accept: 'application/json, text/plain, */*',
      'accept-language': 'id-ID,id;q=0.9,en-US;q=0.8,en;q=0.7',
      'authentication-type': 'go-id',
      authorization: `Bearer ${this.token}`,
      'content-type': 'application/json',
      'sec-ch-ua': '"Chromium";v="137", "Not/A)Brand";v="24"',
      'sec-ch-ua-mobile': '?0',
      'sec-ch-ua-platform': '"Linux"',
      'sec-fetch-dest': 'empty',
      'sec-fetch-mode': 'cors',
      'sec-fetch-site': 'cross-site',
    };

    const response = await fetch(url.toString(), { method: 'GET', headers });

    if (response.status === 401) {
      console.log('[GoPayMerchant] Token expired (Analytics), login ulang...');
      this._initialized = false;
      this.token = null;
      _cachedToken = null;
      await this.init();
      const retryResponse = await fetch(url.toString(), {
        method: 'GET',
        headers: { ...headers, authorization: `Bearer ${this.token}` },
      });
      if (!retryResponse.ok) throw new Error(`HTTP Error Analytics (retry): ${retryResponse.status}`);
      return await retryResponse.json();
    }

    if (!response.ok) throw new Error(`HTTP Error Analytics: ${response.status} ${response.statusText}`);
    return await response.json();
  }

  async getTransactionsJournal({ days = 1, size = 50 } = {}) {
    await this.init();
    const url = 'https://api.gobiz.co.id/journals/search';

    const startTime = moment().subtract(days, 'days').tz('Asia/Jakarta').toISOString();
    const endTime = moment().tz('Asia/Jakarta').toISOString();

    const requestBody = {
      from: 0,
      size,
      sort: { time: { order: 'desc' } },
      included_categories: { incoming: ['transaction_share', 'action'] },
      query: [{
        clauses: [
          { op: 'not', clauses: [{ clauses: [{ field: 'metadata.source', op: 'in', value: ['GOSAVE_ONLINE','GoSave','GODEALS_ONLINE'] }, { field: 'metadata.gopay.source', op: 'in', value: ['GOSAVE_ONLINE','GoSave','GODEALS_ONLINE'] }], op: 'or' }] },
          { field: 'metadata.transaction.status', op: 'in', value: ['settlement','capture','refund','partial_refund'] },
          { op: 'or', clauses: [{ op: 'or', clauses: [{ field: 'metadata.transaction.payment_type', op: 'in', value: ['qris','gopay','offline_credit_card','offline_debit_card','credit_card'] }] }] },
          { field: 'metadata.transaction.transaction_time', op: 'gte', value: startTime },
          { field: 'metadata.transaction.transaction_time', op: 'lte', value: endTime },
          { field: 'metadata.transaction.merchant_id', op: 'equal', value: this.merchantId },
        ],
        op: 'and',
      }],
    };

    const headers = {
      accept: 'application/json, text/plain, */*, application/vnd.journal.v1+json',
      'accept-language': 'id-ID,id;q=0.9,en-US;q=0.8,en;q=0.7',
      'authentication-type': 'go-id',
      authorization: `Bearer ${this.token}`,
      'content-type': 'application/json',
      'sec-ch-ua': '"Chromium";v="137", "Not/A)Brand";v="24"',
      'sec-ch-ua-mobile': '?0',
      'sec-ch-ua-platform': '"Linux"',
      'sec-fetch-dest': 'empty',
      'sec-fetch-mode': 'cors',
      'sec-fetch-site': 'cross-site',
    };

    const response = await fetch(url, { method: 'POST', headers, body: JSON.stringify(requestBody) });

    if (response.status === 401) {
      console.log('[GoPayMerchant] Token expired (Journal), login ulang...');
      this._initialized = false;
      this.token = null;
      _cachedToken = null;
      await this.init();
      const retryResponse = await fetch(url, {
        method: 'POST',
        headers: { ...headers, authorization: `Bearer ${this.token}` },
        body: JSON.stringify(requestBody),
      });
      if (!retryResponse.ok) throw new Error(`HTTP Error Journal (retry): ${retryResponse.status}`);
      return await retryResponse.json();
    }

    if (!response.ok) throw new Error(`HTTP Error Journal: ${response.status} ${response.statusText}`);
    return await response.json();
  }
}

export class GoPayWatcher extends EventEmitter {
  constructor(merchant, intervalMs = 7_000) {
    super();
    this._merchant = merchant;
    this._interval = intervalMs;
    this._timer = null;
    this._seenIds = new Set();
    this._seeded = false;
    this._listeners = 0;
    this._polling = false;
  }

  _startPoller() {
    if (this._timer) return;
    this._poll();
    this._timer = setInterval(() => this._poll(), this._interval);
  }

  _stopPoller() {
    if (!this._timer) return;
    clearInterval(this._timer);
    this._timer = null;
  }

  async _poll() {
    if (this._polling) return;
    this._polling = true;
    try {
      const result = await this._merchant.getHistory({ days: 1, size: 30 });
      if (!result?.status || !Array.isArray(result?.data?.histories)) return;

      for (const entry of result.data.histories) {
        const raw = entry.raw || {};

        // CONFIRMED dari debug: field yg ada adalah raw.id (UUID), bukan raw.transaction_id
        // Fallback: id -> order_id -> wallstreet_transaction_id -> composite
        const txId = raw.id ?? raw.order_id ?? raw.wallstreet_transaction_id
          ?? `${entry.time}_${raw.gross_amount}`;

        if (!txId || this._seenIds.has(txId)) continue;
        this._seenIds.add(txId);
        if (!this._seeded) continue;

        // CONFIRMED: gross_amount dalam sen (29000 = Rp 290), divide by 100 BENAR
        const rawAmount = raw.gross_amount;
        const amount = typeof rawAmount === 'number' ? rawAmount / 100 : parseFloat(String(rawAmount ?? 0));

        // Extra meta untuk webhook: issuer bank, order_id, dll
        const meta = {
          issuer: raw.qris_provider_aspi_issuer || null,
          acquirer: raw.qris_provider_aspi_acquirer || null,
          orderId: raw.order_id || null,
          paymentType: raw.payment_type || null,
          channelType: raw.channel_type || null,
        };

        this.emit('payment', { amount, txId, entry, meta });
      }

      if (!this._seeded) {
        this._seeded = true;
        console.log(`[GoPayWatcher] Seed selesai. ${this._seenIds.size} transaksi dikenali.`);
      }

      if (this._seenIds.size > 500) {
        const arr = [...this._seenIds];
        this._seenIds = new Set(arr.slice(arr.length - 500));
      }
    } catch (e) {
      console.error('[GoPayWatcher] Error polling:', e.message);
    } finally {
      this._polling = false;
    }
  }

  waitForPayment(amount, { timeout = 5 * 60_000, tolerance = 0 } = {}) {
    return new Promise((resolve, reject) => {
      this._listeners++;
      this._startPoller();

      let timeoutHandle;
      const onPayment = (data) => {
        if (Math.abs(data.amount - amount) <= tolerance) {
          cleanup();
          resolve(data);
        }
      };
      const cleanup = () => {
        clearTimeout(timeoutHandle);
        this.off('payment', onPayment);
        this._listeners = Math.max(0, this._listeners - 1);
        if (this._listeners === 0) this._stopPoller();
      };

      timeoutHandle = setTimeout(() => {
        cleanup();
        reject(new Error(`Timeout: Pembayaran Rp ${amount.toLocaleString('id-ID')} tidak terdeteksi dalam ${timeout / 1000}s.`));
      }, timeout);

      this.on('payment', onPayment);
    });
  }

  reset() {
    this._seenIds.clear();
    this._seeded = false;
  }
}
