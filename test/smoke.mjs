// Smoke test untuk handler public repo Gopayment-Vercel
// Menguji: create-payment (dengan QRIS_STRING dummy), status, dan gateway auth.
process.env.QRIS_STRING = '00020101021126620016COM.GOJEK.WWW0118936009174433401945110021500091751862100809120110510271051303035145145802ID5921KEDAI KOPI CONTOH6007JAKARTA6105123456304C4A8';
process.env.GOPAY_EMAIL = 'contoh@example.com';
process.env.GOPAY_PASSWORD = 'contoh-password';
process.env.UPSTASH_REDIS_REST_URL = '';
process.env.UPSTASH_REDIS_REST_TOKEN = '';
process.env.GATEWAY_API_KEY = 'test-key-123';

const { default: createPayment } = await import('../api/create-payment.js');

function makeReq(method, body, query = {}, headers = {}) {
  return { method, body, query, headers };
}
function makeRes() {
  const res = { statusCode: 200, headers: {}, body: null };
  res.status = (code) => { res.statusCode = code; return res; };
  res.json = (data) => { res.body = data; return res; };
  res.setHeader = (k, v) => { res.headers[k] = v; return res; };
  res.end = () => res;
  return res;
}

// Test 1: create-payment
const res1 = makeRes();
const req1 = { method: 'POST', body: { nama: 'Test', tentang: 'Bayar test', nominal: 50000 } };
await createPayment(req1, res1);
console.log('create-payment status:', res1.statusCode);
if (res1.body && res1.body.sessionId) {
  console.log('sessionId:', res1.body.sessionId);
  console.log('qrisDataUrl prefix:', res1.body.qrisDataUrl.slice(0, 22));
  console.log('totalBayar:', res1.body.totalBayar, '(nominal + surcharge)');
} else {
  console.log('ERROR body:', res1.body || res1.body?.error);
}

// Test 2: gateway create butuh API key
const res2 = makeRes();
const req2 = { method: 'POST', body: { nama: 'T', tentang: 'T', nominal: 1000 }, query: {} };
const { default: gateway } = await import('../api/gateway.js');
await gateway(req2, res2);
console.log('gateway tanpa key status (expect 401):', res2.statusCode);

// Test 3: gateway dengan API key + env store (tanpa Redis -> mem fallback)
const res3 = makeRes();
const gReq = {
  method: 'POST',
  headers: { 'x-api-key': 'test-key-123' },
  query: { action: 'create' },
  body: { nama: 'ViaGateway', tentang: 'Integrasi', nominal: 25000 }
};
await gateway(gReq, res3);
console.log('gateway dengan key status (expect 200):', res3.statusCode);
if (res3.body) console.log('gateway create sessionId:', res3.body.sessionId, '| totalBayar:', res3.body.totalBayar);

console.log('\nOK');