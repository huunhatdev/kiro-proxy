// kiro.mjs — calls the Kiro backend (OpenAI Responses API) and discovers the
// enterprise profile ARN. Protocol reverse-engineered from kiro-cli:
//   POST https://runtime.us-east-1.kiro.dev/v1/responses   (SSE)
//   headers: Authorization: Bearer, x-amzn-kiro-origin, x-amzn-kiro-profile,
//            x-amzn-codewhisperer-optout, TokenType (for external_idp)

import fsSync from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { httpStream, httpJson } from './http.mjs';

export const ENDPOINT = process.env.KIRO_ENDPOINT || 'https://runtime.us-east-1.kiro.dev';
export const ORIGIN = process.env.KIRO_ORIGIN || 'KIRO_CLI';

// Control-plane host per region, used for metadata calls like getUsageLimits.
const CONTROL_PLANE_HOSTS = {
  'us-east-1': 'https://management.us-east-1.kiro.dev',
  'eu-central-1': 'https://management.eu-central-1.kiro.dev',
  'us-gov-east-1': 'https://management.us-gov-east-1.kiro.dev',
  'us-gov-west-1': 'https://management.us-gov-west-1.kiro.dev',
};

export const MODELS = [
  'auto',
  'claude-sonnet-4',
  'claude-sonnet-4.5',
  'claude-sonnet-4.5-1m',
  'claude-sonnet-4.6',
  'claude-sonnet-4.6-1m',
  'claude-opus-4.5',
  'claude-opus-4.6',
  'claude-opus-4.6-1m',
  'claude-opus-4.7',
  'claude-haiku-4.5',
  'qwen3-coder-480b',
  'gpt-5.1',
];
export const DEFAULT_MODEL = 'auto';

function contentToText(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content.map((p) => (typeof p === 'string' ? p : (p.text ?? ''))).join('');
  }
  return String(content ?? '');
}

export function messagesToInput(messages) {
  const input = [];
  const systemParts = [];
  for (const m of messages) {
    const text = contentToText(m.content);
    if (m.role === 'system' || m.role === 'developer') systemParts.push(text);
    else if (m.role === 'assistant') { if (text) input.push({ role: 'assistant', content: text }); }
    else input.push({ role: 'user', content: text });
  }
  return { input, instructions: systemParts.length ? systemParts.join('\n') : undefined };
}

function headersFor(store, acc) {
  const h = {
    'content-type': 'application/json',
    'authorization': `Bearer ${acc.accessToken}`,
    'x-amzn-kiro-origin': ORIGIN,
    'x-amzn-codewhisperer-optout': 'true',
    'accept': 'text/event-stream',
    'user-agent': 'kiro-manager/1.0',
  };
  if (acc.profileArn) h['x-amzn-kiro-profile'] = acc.profileArn;
  const tt = store.tokenType(acc);
  if (tt) h['TokenType'] = tt;
  return h;
}

// Discover the profile ARN by listing available profiles with the access token.
export async function discoverProfileArn(accessToken, tokenType) {
  const url = `${ENDPOINT}/v1/profiles`;
  const headers = {
    'authorization': `Bearer ${accessToken}`,
    'x-amzn-kiro-origin': ORIGIN,
    'accept': 'application/json',
  };
  if (tokenType) headers['TokenType'] = tokenType;
  try {
    const { status, body } = await httpJson(url, { headers });
    if (status >= 200 && status < 300) {
      const data = JSON.parse(body);
      const arr = data.profiles || data.profileList || (Array.isArray(data) ? data : []);
      const first = arr[0];
      const arn = first?.arn || first?.profileArn || first?.ARN;
      if (arn) return arn;
    }
  } catch { /* fall through */ }
  // Fallback: read the profile ARN that kiro-cli cached locally. Works when the
  // manager runs on the same host/volume as a kiro-cli install (mount
  // ~/.kiro into the container to use this).
  return discoverProfileArnLocal();
}

const ARN_RE = /arn:aws:codewhisperer:[a-z0-9-]+:\d+:profile\/[A-Za-z0-9]+/;

export function discoverProfileArnLocal(kiroHome) {
  const base = kiroHome || process.env.KIRO_HOME || path.join(os.homedir(), '.kiro');
  // 1) enterprise-management/<hash>/entry.json
  const emDir = path.join(base, 'enterprise-management');
  if (fsSync.existsSync(emDir)) {
    let entries = [];
    try { entries = fsSync.readdirSync(emDir, { withFileTypes: true }); } catch { /* ignore */ }
    for (const ent of entries) {
      const p = ent.isDirectory() ? path.join(emDir, ent.name, 'entry.json') : path.join(emDir, ent.name);
      if (!p.endsWith('.json')) continue;
      try {
        const obj = JSON.parse(fsSync.readFileSync(p, 'utf8'));
        if (typeof obj.profileArn === 'string' && obj.profileArn.includes('arn:aws:codewhisperer')) {
          return obj.profileArn;
        }
      } catch { /* ignore */ }
    }
  }
  // 2) recent logs
  const logDir = path.join(base, 'logs');
  if (fsSync.existsSync(logDir)) {
    try {
      const dirs = fsSync.readdirSync(logDir).sort().reverse().slice(0, 5);
      for (const d of dirs) {
        const lp = path.join(logDir, d, 'kiro.log');
        if (!fsSync.existsSync(lp)) continue;
        const m = fsSync.readFileSync(lp, 'utf8').match(ARN_RE);
        if (m) return m[0];
      }
    } catch { /* ignore */ }
  }
  return '';
}

// Call Kiro and stream assistant text via onDelta. Returns full text.
export async function callKiro({ store, acc, model, messages, onDelta }) {
  await store.getAccessToken(acc); // ensure fresh
  const { input, instructions } = messagesToInput(messages);
  const body = {
    model: model && model !== 'auto' ? model : 'auto',
    input,
    stream: true,
    origin: ORIGIN,
  };
  if (instructions) body.instructions = instructions;
  if (acc.profileArn) body.profileArn = acc.profileArn;

  const payload = JSON.stringify(body);
  let sseBuffer = '';
  let full = '';
  let errorInfo = null;
  const httpErr = [];

  const res = await httpStream(`${ENDPOINT}/v1/responses`, {
    method: 'POST',
    headers: headersFor(store, acc),
    body: payload,
  }, (chunk, res) => {
    if ((res.statusCode ?? 0) >= 400) { httpErr.push(chunk); return; }
    sseBuffer += chunk.toString('utf8');
    let nl;
    while ((nl = sseBuffer.indexOf('\n')) !== -1) {
      const line = sseBuffer.slice(0, nl).replace(/\r$/, '');
      sseBuffer = sseBuffer.slice(nl + 1);
      if (!line.startsWith('data:')) continue;
      const data = line.slice(5).trim();
      if (!data || data === '[DONE]') continue;
      let evt;
      try { evt = JSON.parse(data); } catch { continue; }
      const type = evt.type ?? '';
      if (type === 'response.output_text.delta' && typeof evt.delta === 'string') {
        full += evt.delta;
        if (onDelta) onDelta(evt.delta);
      } else if (type === 'error' || type === 'response.failed') {
        const e = type === 'error' ? evt.error : evt.response?.error;
        errorInfo = e?.message || e?.type || 'backend error';
      }
    }
  });

  if ((res.status ?? 0) >= 400) {
    const errType = res.headers['x-amzn-errortype'] || '';
    const bodyTxt = Buffer.concat(httpErr).toString('utf8');
    const err = new Error(`${errType || `HTTP ${res.status}`}${bodyTxt ? `: ${bodyTxt}` : ''}`);
    err.statusCode = res.status;
    throw err;
  }
  if (errorInfo && !full) {
    const err = new Error(errorInfo);
    err.statusCode = 502;
    throw err;
  }
  return full;
}

// ---------------------------------------------------------------------------
// Quota / usage limits
// ---------------------------------------------------------------------------
// GET https://management.<region>.kiro.dev/getUsageLimits
//   ?origin=AI_EDITOR&resourceType=AGENTIC_REQUEST&profileArn=<arn>
// Returns plan, per-resource usage breakdown (e.g. Credits used/limit), overage
// config and the next reset date. Requires a profile ARN for external_idp.

export async function fetchUsage({ store, acc }) {
  await store.getAccessToken(acc);
  const region = acc.region || 'us-east-1';
  const host = CONTROL_PLANE_HOSTS[region] || CONTROL_PLANE_HOSTS['us-east-1'];
  if (!acc.profileArn) {
    throw new Error('quota requires a profile ARN for this account');
  }
  const q = new URLSearchParams({
    origin: 'AI_EDITOR',
    resourceType: 'AGENTIC_REQUEST',
    profileArn: acc.profileArn,
  });
  const headers = {
    'authorization': `Bearer ${acc.accessToken}`,
    'accept': 'application/json',
    'user-agent': 'kiro-manager/1.0',
  };
  const tt = store.tokenType(acc);
  if (tt) headers['TokenType'] = tt;

  const { status, body } = await httpJson(`${host}/getUsageLimits?${q.toString()}`, { headers });
  if (status < 200 || status >= 300) {
    let msg = `HTTP ${status}`;
    try { msg = JSON.parse(body).message || msg; } catch { /* ignore */ }
    const err = new Error(`usage request failed: ${msg}`);
    err.statusCode = status;
    throw err;
  }
  return summarizeUsage(JSON.parse(body));
}

// Normalize the raw getUsageLimits response into a compact, UI-friendly shape.
export function summarizeUsage(raw) {
  const sub = raw.subscriptionInfo || {};
  const breakdown = Array.isArray(raw.usageBreakdownList) ? raw.usageBreakdownList : [];
  const resources = breakdown.map((b) => {
    const used = Number(b.currentUsageWithPrecision ?? b.currentUsage ?? 0);
    const limit = Number(b.usageLimitWithPrecision ?? b.usageLimit ?? 0);
    return {
      name: b.displayNamePlural || b.displayName || b.resourceType || 'Usage',
      resourceType: b.resourceType || '',
      used,
      limit,
      remaining: limit > 0 ? Math.max(0, limit - used) : null,
      percent: limit > 0 ? Math.min(100, (used / limit) * 100) : null,
      unit: b.unit || '',
      overageCap: Number(b.overageCap ?? 0),
      currentOverages: Number(b.currentOveragesWithPrecision ?? b.currentOverages ?? 0),
      overageCharges: Number(b.overageCharges ?? 0),
      currency: b.currency || '',
    };
  });
  // "primary" = the first CREDIT resource if present, else the first resource.
  const primary = resources.find((r) => r.resourceType === 'CREDIT') || resources[0] || null;
  const resetEpoch = Number(raw.nextDateReset || (breakdown[0] && breakdown[0].nextDateReset) || 0);
  return {
    plan: (sub.subscriptionTitle || '').trim(),
    planType: (sub.type || '').trim(),
    overageStatus: (raw.overageConfiguration?.overageStatus || '').trim(),
    resetAt: resetEpoch > 0 ? new Date(resetEpoch * 1000).toISOString() : null,
    daysUntilReset: raw.daysUntilReset ?? null,
    resources,
    primary,
    // exhausted = primary resource at/over its limit AND no overage room left.
    exhausted: primary
      ? (primary.limit > 0 && primary.used >= primary.limit &&
         (primary.overageCap <= 0 || primary.currentOverages >= primary.overageCap))
      : false,
    fetchedAt: new Date().toISOString(),
  };
}
