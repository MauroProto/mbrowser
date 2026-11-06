import http from 'node:http';

/** Raw HTTP requests allow exact Origin/Host tests (fetch normalizes some headers). */
export function requestHttp(base, { path = '/', method = 'GET', headers = {}, body, timeoutMs = 2000 } = {}) {
  const url = new URL(path, base);
  return new Promise((resolve, reject) => {
    const request = http.request(url, { method, headers }, (response) => {
      const chunks = [];
      response.on('data', (chunk) => chunks.push(chunk));
      response.once('error', reject);
      response.once('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let json;
        try { json = JSON.parse(text); } catch { /* Non-JSON rejection bodies are valid. */ }
        resolve({ status: response.statusCode, headers: response.headers, text, json });
      });
    });
    request.setTimeout(timeoutMs, () => request.destroy(new Error('Test HTTP request timed out')));
    request.once('error', reject);
    if (body !== undefined) request.write(body);
    request.end();
  });
}
