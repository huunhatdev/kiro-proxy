// server.mjs — Kiro Manager
//   - Web UI to manage Kiro accounts (paste token JSON, enable/disable, delete)
//   - OpenAI-compatible proxy (/v1/models, /v1/chat/completions) over those accounts
//
// Env:
//   PORT          (default 8080)
//   HOST          (default 0.0.0.0)
//   DATA_DIR      (default ./data)
//   ADMIN_TOKEN   if set, the management UI/API require ?token= or X-Admin-Token
//   API_KEY       if set, /v1/* require Authorization: Bearer <API_KEY>

import http from 'node:http';
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { AccountStore } from './store.mjs';
import { MODELS, DEFAULT_MODEL, callKiro, discoverProfileArn, fetchUsage } from './kiro.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Load a local .env (project root) for `node src/server.mjs` runs. Existing
// environment variables (e.g. from Docker/env_file) always take precedence, so
// this is a no-op inside the container. Minimal parser: KEY=VALUE per line,
// `#` comments, optional surrounding quotes stripped.
function loadDotEnv(file) {
  if (!fsSync.existsSync(file)) return;
  try {
    for (const rawLine of fsSync.readFileSync(file, 'utf8').split(/\r?\n/)) {
      const line = rawLine.trim();
      if (!line || line.startsWith('#')) continue;
      const eq = line.indexOf('=');
      if (eq === -1) continue;
      const key = line.slice(0, eq).trim();
      if (!key || process.env[key] !== undefined) continue;
      let val = line.slice(eq + 1).trim();
      if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
        val = val.slice(1, -1);
      }
      process.env[key] = val;
    }
  } catch { /* ignore malformed .env */ }
}
loadDotEnv(path.join(__dirname, '..', '.env'));

const PORT = Number(process.env.PORT) || 8080;
const HOST = process.env.HOST || '0.0.0.0';
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || '';
const API_KEY = process.env.API_KEY || '';

const store = new AccountStore(DATA_DIR);

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) });
  res.end(body);
}

function readBody(req, limit = 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) { reject(new Error('body too large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function adminOk(req, url) {
  if (!ADMIN_TOKEN) return true;
  const hdr = req.headers['x-admin-token'];
  const q = url.searchParams.get('token');
  return hdr === ADMIN_TOKEN || q === ADMIN_TOKEN;
}

function apiKeyOk(req) {
  if (!API_KEY) return true;
  return (req.headers['authorization'] || '') === `Bearer ${API_KEY}`;
}

function chunkObj(id, model, delta, finish = null) {
  return {
    id, object: 'chat.completion.chunk',
    created: Math.floor(Date.now() / 1000), model,
    choices: [{ index: 0, delta, finish_reason: finish }],
  };
}

// ---------------------------------------------------------------------------
// management API
// ---------------------------------------------------------------------------

async function handleAdminApi(req, res, url) {
  if (!adminOk(req, url)) return sendJson(res, 401, { error: 'unauthorized (admin token required)' });
  const parts = url.pathname.split('/').filter(Boolean); // ['api','accounts', id?]

  // GET /api/accounts
  if (req.method === 'GET' && parts.length === 2 && parts[1] === 'accounts') {
    return sendJson(res, 200, { accounts: store.list(), selectionMode: store.selectionMode });
  }

  // GET /api/settings
  if (req.method === 'GET' && parts.length === 2 && parts[1] === 'settings') {
    return sendJson(res, 200, { selectionMode: store.selectionMode });
  }

  // PUT /api/settings  { selectionMode }
  if (req.method === 'PUT' && parts.length === 2 && parts[1] === 'settings') {
    const raw = (await readBody(req)).toString('utf8');
    let patch;
    try { patch = JSON.parse(raw); } catch { return sendJson(res, 400, { error: 'invalid request JSON' }); }
    try { await store.setSelectionMode(patch.selectionMode); return sendJson(res, 200, { selectionMode: store.selectionMode }); }
    catch (err) { return sendJson(res, 400, { error: err.message }); }
  }

  // POST /api/accounts  { json, label }
  if (req.method === 'POST' && parts.length === 2 && parts[1] === 'accounts') {
    const raw = (await readBody(req)).toString('utf8');
    let payload;
    try { payload = JSON.parse(raw); } catch { return sendJson(res, 400, { error: 'invalid request JSON' }); }
    try {
      const view = await store.add(payload.json ?? payload, payload.label,
        payload.priority != null ? Number(payload.priority) : undefined);
      const acc = store.get(view.id);
      // explicit profileArn from the request wins
      if (payload.profileArn && typeof payload.profileArn === 'string' && !acc.profileArn) {
        acc.profileArn = payload.profileArn.trim();
        await store.save();
      }
      // otherwise auto-discover (network listAvailableProfiles, then local cache)
      if (!acc.profileArn) {
        try {
          await store.getAccessToken(acc);
          const d = await discoverProfileArn(acc.accessToken, store.tokenType(acc),
            acc.region ? [acc.region] : undefined);
          if (d.arn) {
            acc.profileArn = d.arn;
            if (d.region) acc.region = d.region;
            await store.save();
          } else {
            acc.lastError = 'không tự dò được Profile ARN — hãy nhập thủ công (account enterprise thường bị chặn liệt kê profile)';
            await store.save();
          }
        } catch (e) { acc.lastError = `profile discovery: ${e.message}`; await store.save(); }
      }
      return sendJson(res, 200, { account: store.redact(acc) });
    } catch (err) {
      return sendJson(res, 400, { error: err.message });
    }
  }

  // PATCH /api/accounts/:id  { label?, enabled?, profileArn? }
  if (req.method === 'PATCH' && parts.length === 3 && parts[1] === 'accounts') {
    const raw = (await readBody(req)).toString('utf8');
    let patch;
    try { patch = JSON.parse(raw); } catch { return sendJson(res, 400, { error: 'invalid request JSON' }); }
    try { return sendJson(res, 200, { account: await store.update(parts[2], patch) }); }
    catch (err) { return sendJson(res, 404, { error: err.message }); }
  }

  // DELETE /api/accounts/:id
  if (req.method === 'DELETE' && parts.length === 3 && parts[1] === 'accounts') {
    try { await store.remove(parts[2]); return sendJson(res, 200, { ok: true }); }
    catch (err) { return sendJson(res, 404, { error: err.message }); }
  }

  // POST /api/accounts/:id/refresh
  if (req.method === 'POST' && parts.length === 4 && parts[1] === 'accounts' && parts[3] === 'refresh') {
    const acc = store.get(parts[2]);
    if (!acc) return sendJson(res, 404, { error: 'account not found' });
    try { await store.refresh(acc); return sendJson(res, 200, { account: store.redact(acc) }); }
    catch (err) { return sendJson(res, 502, { error: err.message }); }
  }

  // POST /api/accounts/:id/discover-arn  -> re-run network ARN discovery
  if (req.method === 'POST' && parts.length === 4 && parts[1] === 'accounts' && parts[3] === 'discover-arn') {
    const acc = store.get(parts[2]);
    if (!acc) return sendJson(res, 404, { error: 'account not found' });
    try {
      await store.getAccessToken(acc);
      const d = await discoverProfileArn(acc.accessToken, store.tokenType(acc),
        acc.region ? [acc.region] : undefined);
      if (d.arn) {
        acc.profileArn = d.arn;
        if (d.region) acc.region = d.region;
        acc.lastError = null;
        await store.save();
        return sendJson(res, 200, { ok: true, profileArn: d.arn, source: d.source, account: store.redact(acc) });
      }
      const reason = `không tự dò được Profile ARN (${(d.errors || []).join(', ') || 'bị từ chối'}). Nhập thủ công bằng nút ARN.`;
      acc.lastError = reason; await store.save();
      return sendJson(res, 422, { ok: false, error: reason, account: store.redact(acc) });
    } catch (err) {
      acc.lastError = err.message; await store.save();
      return sendJson(res, 502, { error: err.message });
    }
  }

  // POST /api/accounts/:id/test  -> one-shot chat to confirm it works
  if (req.method === 'POST' && parts.length === 4 && parts[1] === 'accounts' && parts[3] === 'test') {
    const acc = store.get(parts[2]);
    if (!acc) return sendJson(res, 404, { error: 'account not found' });
    try {
      const text = await callKiro({
        store, acc, model: 'auto',
        messages: [{ role: 'user', content: 'Reply with exactly: OK' }],
      });
      await store.recordResult(acc, null);
      return sendJson(res, 200, { ok: true, reply: text.trim().slice(0, 100) });
    } catch (err) {
      const { disabled } = await store.recordResult(acc, err);
      return sendJson(res, err.statusCode || 502, { error: err.message, autoDisabled: disabled });
    }
  }

  // GET /api/accounts/:id/quota  -> fetch and cache usage for one account
  if (req.method === 'GET' && parts.length === 4 && parts[1] === 'accounts' && parts[3] === 'quota') {
    const acc = store.get(parts[2]);
    if (!acc) return sendJson(res, 404, { error: 'account not found' });
    try {
      const usage = await fetchUsage({ store, acc });
      acc.usage = usage; await store.recordResult(acc, null);
      return sendJson(res, 200, { usage, account: store.redact(acc) });
    } catch (err) {
      const { disabled } = await store.recordResult(acc, err);
      return sendJson(res, err.statusCode || 502, { error: err.message, autoDisabled: disabled });
    }
  }

  // POST /api/quota/refresh  -> refresh usage for all accounts
  if (req.method === 'POST' && parts.length === 3 && parts[1] === 'quota' && parts[2] === 'refresh') {
    const results = [];
    for (const acc of store.accounts) {
      try {
        const usage = await fetchUsage({ store, acc });
        acc.usage = usage; acc.lastError = null;
        results.push({ id: acc.id, ok: true });
      } catch (err) {
        const { disabled } = await store.recordResult(acc, err);
        results.push({ id: acc.id, ok: false, error: err.message, autoDisabled: disabled });
      }
    }
    await store.save();
    return sendJson(res, 200, { results, accounts: store.list() });
  }

  return sendJson(res, 404, { error: 'no such admin route' });
}

// ---------------------------------------------------------------------------
// OpenAI-compatible proxy
// ---------------------------------------------------------------------------

function handleModels(res) {
  sendJson(res, 200, {
    object: 'list',
    data: MODELS.map((m) => ({ id: m, object: 'model', created: 0, owned_by: 'kiro' })),
  });
}

async function handleChat(req, res, url) {
  const raw = (await readBody(req)).toString('utf8');
  let payload;
  try { payload = JSON.parse(raw); } catch { return sendJson(res, 400, { error: { message: 'invalid JSON body' } }); }

  const model = payload.model && MODELS.includes(payload.model) ? payload.model : DEFAULT_MODEL;
  const messages = Array.isArray(payload.messages) ? payload.messages : [];
  const stream = Boolean(payload.stream);
  const pinnedId = req.headers['x-kiro-account'] || url.searchParams.get('account') || '';

  const id = `chatcmpl-${crypto.randomBytes(12).toString('hex')}`;

  // -- non-streaming: full failover across accounts on auth failures --------
  if (!stream) {
    const tried = new Set();
    let lastErr = null;
    // try up to the number of enabled accounts (or 1 when pinned)
    const maxTries = pinnedId ? 1 : Math.max(1, store.accounts.filter((a) => a.enabled !== false).length);
    for (let i = 0; i < maxTries; i += 1) {
      const acc = store.pick(pinnedId);
      if (!acc || tried.has(acc.id)) break;
      tried.add(acc.id);
      try {
        const text = await callKiro({ store, acc, model, messages });
        await store.recordResult(acc, null);
        return sendJson(res, 200, {
          id, object: 'chat.completion', created: Math.floor(Date.now() / 1000), model,
          choices: [{ index: 0, message: { role: 'assistant', content: text }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
        });
      } catch (err) {
        lastErr = err;
        const { disabled } = await store.recordResult(acc, err);
        // Only fail over on auth failures; other errors return immediately.
        if (!disabled && !store.isAuthFailure(err)) {
          return sendJson(res, err.statusCode || 502, { error: { message: err.message } });
        }
        // otherwise loop to the next account
      }
    }
    return sendJson(res, lastErr?.statusCode || 503,
      { error: { message: lastErr ? `all accounts failed: ${lastErr.message}` : 'no enabled Kiro account configured' } });
  }

  // -- streaming: fail over only before the first byte is written -----------
  const tried = new Set();
  let acc = null;
  let started = false;
  const write = (o) => res.write(`data: ${JSON.stringify(o)}\n\n`);
  const maxTries = pinnedId ? 1 : Math.max(1, store.accounts.filter((a) => a.enabled !== false).length);
  let lastErr = null;

  for (let i = 0; i < maxTries; i += 1) {
    acc = store.pick(pinnedId);
    if (!acc || tried.has(acc.id)) break;
    tried.add(acc.id);
    try {
      // Probe credentials cheaply? No — we stream directly but buffer the first
      // delta decision: callKiro throws before emitting on HTTP >=400, so if the
      // first failure is an auth error and nothing was written yet, we retry.
      await callKiro({
        store, acc, model, messages,
        onDelta: (t) => {
          if (!started) {
            res.writeHead(200, {
              'content-type': 'text/event-stream; charset=utf-8',
              'cache-control': 'no-cache',
              'connection': 'keep-alive',
            });
            write(chunkObj(id, model, { role: 'assistant' }));
            started = true;
          }
          write(chunkObj(id, model, { content: t }));
        },
      });
      await store.recordResult(acc, null);
      if (!started) {
        // empty completion: still return a valid stream
        res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-cache', 'connection': 'keep-alive' });
        write(chunkObj(id, model, { role: 'assistant' }));
      }
      write(chunkObj(id, model, {}, 'stop'));
      res.write('data: [DONE]\n\n');
      res.end();
      return undefined;
    } catch (err) {
      lastErr = err;
      const { disabled } = await store.recordResult(acc, err);
      if (started) {
        // already streaming: cannot fail over, surface the error inline
        write(chunkObj(id, model, { content: `\n[proxy error] ${err.message}` }, 'stop'));
        res.write('data: [DONE]\n\n');
        res.end();
        return undefined;
      }
      if (!disabled && !store.isAuthFailure(err)) {
        return sendJson(res, err.statusCode || 502, { error: { message: err.message } });
      }
      // nothing written yet and it was an auth failure -> try next account
    }
  }
  return sendJson(res, lastErr?.statusCode || 503,
    { error: { message: lastErr ? `all accounts failed: ${lastErr.message}` : 'no enabled Kiro account configured' } });
}

// ---------------------------------------------------------------------------
// static UI
// ---------------------------------------------------------------------------

async function serveUI(res) {
  try {
    const html = await fs.readFile(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(html);
  } catch (err) {
    sendJson(res, 500, { error: `UI not found: ${err.message}` });
  }
}

// ---------------------------------------------------------------------------
// router
// ---------------------------------------------------------------------------

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  res.setHeader('access-control-allow-origin', '*');
  res.setHeader('access-control-allow-headers', 'authorization, content-type, x-admin-token, x-kiro-account');
  res.setHeader('access-control-allow-methods', 'GET, POST, PATCH, DELETE, OPTIONS');
  if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }

  try {
    if (url.pathname === '/health') return sendJson(res, 200, { status: 'ok', accounts: store.accounts.length });

    if (url.pathname === '/' || url.pathname === '/index.html') return serveUI(res);

    if (url.pathname.startsWith('/api/')) return await handleAdminApi(req, res, url);

    if (req.method === 'GET' && (url.pathname === '/v1/models' || url.pathname === '/models')) {
      if (!apiKeyOk(req)) return sendJson(res, 401, { error: { message: 'unauthorized' } });
      return handleModels(res);
    }
    if (req.method === 'POST' && (url.pathname === '/v1/chat/completions' || url.pathname === '/chat/completions')) {
      if (!apiKeyOk(req)) return sendJson(res, 401, { error: { message: 'unauthorized' } });
      return await handleChat(req, res, url);
    }
    return sendJson(res, 404, { error: { message: `no route for ${req.method} ${url.pathname}` } });
  } catch (err) {
    if (!res.headersSent) return sendJson(res, 500, { error: { message: err.message } });
    try { res.end(); } catch { /* ignore */ }
  }
});

await store.init();
server.listen(PORT, HOST, () => {
  console.log(`kiro-manager on http://${HOST}:${PORT}`);
  console.log(`  UI        : http://localhost:${PORT}/`);
  console.log(`  OpenAI    : http://localhost:${PORT}/v1`);
  console.log(`  data dir  : ${DATA_DIR}`);
  console.log(`  admin auth: ${ADMIN_TOKEN ? 'required' : 'open'}`);
  console.log(`  api key   : ${API_KEY ? 'required' : 'open'}`);
  console.log(`  accounts  : ${store.accounts.length}`);
});
