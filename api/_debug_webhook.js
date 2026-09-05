export async function sendDebugWebhook({ req, status, message }) {
  const webhookUrl = process.env.DEBUG_DISCORD_WEBHOOK_URL || process.env.DISCORD_WEBHOOK_URL;
  if (!webhookUrl) return;

  const method = req.method || 'GET';
  const url = req.url || req.originalUrl || '-';
  const host = req.headers?.host || 'gopayment.vercel.app';
  
  // Format time matching screenshot style: e.g. "AUG 18 09:20:50.69"
  const now = new Date();
  const months = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];
  const month = months[now.getUTCMonth()];
  const day = String(now.getUTCDate()).padStart(2, '0');
  const hours = String(now.getUTCHours()).padStart(2, '0');
  const minutes = String(now.getUTCMinutes()).padStart(2, '0');
  const seconds = String(now.getUTCSeconds()).padStart(2, '0');
  const millis = String(now.getUTCMilliseconds()).padStart(3, '0').slice(0, 2);
  const timeStr = `${month} ${day} ${hours}:${minutes}:${seconds}.${millis}`;

  const statusStr = `${method} ${status}`;
  
  // Color code matching HTTP status
  let color = 0x3498DB; // Default Blue
  if (status >= 200 && status < 300) color = 0x2D9B6F; // Green
  else if (status >= 300 && status < 400) color = 0x3498DB; // Blue
  else if (status >= 400 && status < 500) color = 0xFEE75C; // Yellow/Orange
  else if (status >= 500) color = 0xED4245; // Red

  const logMessage = message || '-';

  const logBlock = [
    `Time     : ${timeStr}`,
    `Status   : ${statusStr}`,
    `Host     : ${host}`,
    `Request  : ${url}`,
    `Messages : ${logMessage}`
  ].join('\n');

  const payload = {
    username: 'Gpayment Debug Log',
    embeds: [{
      title: `🔍 API Request: ${statusStr} ${url}`,
      color: color,
      description: `\`\`\`http\n${logBlock}\n\`\`\``,
      timestamp: new Date().toISOString(),
      footer: { text: `Gpayment Debug • Host: ${host}` }
    }]
  };

  try {
    await fetch(webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
  } catch (err) {
    console.error('[DebugWebhook] Failed to send Discord debug webhook:', err.message);
  }
}

export function withDebugLogging(handler) {
  return async (req, res) => {
    let statusCode = 200;
    let logMessages = [];

    const originalStatus = res.status;
    res.status = function(code) {
      statusCode = code;
      return originalStatus.apply(this, arguments);
    };

    const originalJson = res.json;
    res.json = function(data) {
      if (data && typeof data === 'object') {
        if (data.error) logMessages.push(data.error);
        else if (data.message) logMessages.push(data.message);
        else logMessages.push(JSON.stringify(data).slice(0, 150));
      }
      return originalJson.apply(this, arguments);
    };

    const originalSend = res.send;
    res.send = function(body) {
      if (typeof body === 'string') {
        logMessages.push(body.slice(0, 150));
      }
      return originalSend.apply(this, arguments);
    };

    const originalConsoleError = console.error;
    console.error = function(...args) {
      logMessages.push(args.map(a => typeof a === 'object' ? JSON.stringify(a) : String(a)).join(' '));
      originalConsoleError.apply(console, arguments);
    };

    try {
      await handler(req, res);
    } catch (err) {
      statusCode = 500;
      logMessages.push(err.message || String(err));
      console.error('[Handler Error]', err);
      throw err;
    } finally {
      console.error = originalConsoleError;
      const messageStr = logMessages.length > 0 ? logMessages.join(' | ') : 'Request completed successfully';
      
      // Noise reduction: Jangan kirim debug log jika ini adalah polling check-payment yang sukses tapi belum menemukan transaksi
      const isPolling = String(req.url || '').includes('check-payment');
      const isNotFoundPolling = isPolling && statusCode === 200 && messageStr.includes('"found":false');
      
      if (!isNotFoundPolling) {
        // Fire and forget (don't block response)
        sendDebugWebhook({
          req,
          status: statusCode,
          message: messageStr
        }).catch(() => {});
      }
    }
  };
}
