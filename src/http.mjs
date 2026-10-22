// http.mjs — tiny promise/stream HTTP helpers over node:http(s).

import http from 'node:http';
import https from 'node:https';

export function httpJson(url, { method = 'GET', headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const lib = u.protocol === 'http:' ? http : https;
    const h = { ...headers };
    if (body != null) h['content-length'] = Buffer.byteLength(body);
    const req = lib.request(u, { method, headers: h }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({
        status: res.statusCode ?? 0,
        headers: res.headers,
        body: Buffer.concat(chunks).toString('utf8'),
      }));
    });
    req.on('error', reject);
    if (body != null) req.write(body);
    req.end();
  });
}

// Streaming POST: calls onChunk(buf, res) for each chunk; resolves on end.
export function httpStream(url, { method = 'POST', headers = {}, body } = {}, onChunk) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const lib = u.protocol === 'http:' ? http : https;
    const h = { ...headers };
    if (body != null) h['content-length'] = Buffer.byteLength(body);
    const req = lib.request(u, { method, headers: h }, (res) => {
      res.on('data', (c) => onChunk(c, res));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers }));
      res.on('error', reject);
    });
    req.on('error', reject);
    if (body != null) req.write(body);
    req.end();
  });
}
