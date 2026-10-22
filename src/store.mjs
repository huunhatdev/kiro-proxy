// store.mjs — persistent multi-account Kiro token store.
//
// Accounts are persisted to <dataDir>/accounts.json. Each account holds the
// fields needed to call the Kiro backend and to refresh the token:
//   { id, label, accessToken, refreshToken, expiresAt, authMethod,
//     tokenEndpoint, clientId, scopes, profileArn, email, enabled,
//     createdAt, lastRefreshAt, lastError }
//
// Secrets never leave this process except toward the Kiro/Microsoft endpoints.
// The HTTP layer returns redacted views (see redact()).

import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { httpJson } from './http.mjs';

const TOKEN_TYPE_MAP = { external_idp: 'EXTERNAL_IDP', IdC: 'SSO_OIDC' };

function nowIso() { return new Date().toISOString(); }

function b64urlDecode(input) {
  const norm = input.replace(/-/g, '+').replace(/_/g, '/');
  const pad = norm.length % 4;
  const padded = norm + (pad ? '='.repeat(4 - pad) : '');
  return Buffer.from(padded, 'base64').toString('utf8');
}

export function decodeJwt(token) {
  if (typeof token !== 'string') return null;
  const parts = token.split('.');
  if (parts.length < 2) return null;
  try { return JSON.parse(b64urlDecode(parts[1])); } catch { return null; }
}

// Extract whatever useful fields we can from a pasted Kiro token JSON.
export function normalizeImport(raw) {
  const obj = typeof raw === 'string' ? JSON.parse(raw) : raw;
  const pick = (...keys) => {
    for (const k of keys) {
      if (obj[k] != null && String(obj[k]).trim() !== '') return obj[k];
    }
    return undefined;
  };
  const accessToken = pick('accessToken', 'access_token');
  const refreshToken = pick('refreshToken', 'refresh_token');
  if (!accessToken || !refreshToken) {
    throw new Error('JSON must contain accessToken/access_token and refreshToken/refresh_token');
  }
  let scopes = pick('scopes', 'scope');
  if (Array.isArray(scopes)) scopes = scopes.join(' ');

  const claims = decodeJwt(accessToken) || {};
  const email = pick('email') || claims.preferred_username || claims.email || '';

  // Region hint from the token endpoint / profile ARN (control plane is regional).
  let region = pick('region') || '';
  const arnGuess = pick('profileArn', 'profile_arn') || '';
  const m = arnGuess.match(/arn:aws:codewhisperer:([a-z0-9-]+):/);
  if (!region && m) region = m[1];
  if (!region) region = 'us-east-1';

  return {
    accessToken,
    refreshToken,
    expiresAt: pick('expiresAt', 'expires_at', 'expired') || nowIso(),
    authMethod: pick('authMethod', 'auth_method') || 'external_idp',
    tokenEndpoint: pick('tokenEndpoint', 'token_endpoint') || '',
    clientId: pick('clientId', 'client_id') || '',
    scopes: scopes || '',
    profileArn: arnGuess,
    region,
    email,
  };
}

export class AccountStore {
  constructor(dataDir) {
    this.dataDir = dataDir;
    this.file = path.join(dataDir, 'accounts.json');
    this.accounts = [];
    this.selectionMode = 'priority'; // 'priority' | 'round-robin'
    this.rr = 0; // round-robin cursor
    this._refreshing = new Map();
  }

  async init() {
    await fs.mkdir(this.dataDir, { recursive: true });
    if (fsSync.existsSync(this.file)) {
      try {
        const data = JSON.parse(await fs.readFile(this.file, 'utf8'));
        this.accounts = Array.isArray(data.accounts) ? data.accounts : [];
        if (data.selectionMode === 'priority' || data.selectionMode === 'round-robin') {
          this.selectionMode = data.selectionMode;
        }
      } catch (err) {
        console.error(`[store] could not read ${this.file}: ${err.message}`);
        this.accounts = [];
      }
    }
  }

  async save() {
    const tmp = `${this.file}.tmp`;
    await fs.writeFile(tmp, JSON.stringify({ selectionMode: this.selectionMode, accounts: this.accounts }, null, 2), 'utf8');
    await fs.rename(tmp, this.file);
  }

  async setSelectionMode(mode) {
    if (mode !== 'priority' && mode !== 'round-robin') throw new Error('mode must be priority or round-robin');
    this.selectionMode = mode;
    await this.save();
  }

  tokenType(acc) { return TOKEN_TYPE_MAP[acc.authMethod] ?? undefined; }

  isExpired(acc, skewMs = 120000) {
    const exp = Date.parse(acc.expiresAt);
    return !Number.isFinite(exp) || exp - skewMs <= Date.now();
  }

  list() { return this.accounts.map((a) => this.redact(a)); }

  get(id) { return this.accounts.find((a) => a.id === id); }

  redact(acc) {
    const claims = decodeJwt(acc.accessToken) || {};
    return {
      id: acc.id,
      label: acc.label || acc.email || acc.id,
      email: acc.email || claims.preferred_username || '',
      authMethod: acc.authMethod,
      profileArn: acc.profileArn || '',
      region: acc.region || 'us-east-1',
      enabled: acc.enabled !== false,
      priority: Number.isFinite(acc.priority) ? acc.priority : 100,
      expiresAt: acc.expiresAt,
      expired: this.isExpired(acc, 0),
      createdAt: acc.createdAt,
      lastRefreshAt: acc.lastRefreshAt || null,
      lastError: acc.lastError || null,
      autoDisabledReason: acc.autoDisabledReason || null,
      autoDisabledAt: acc.autoDisabledAt || null,
      usage: acc.usage || null,
      // never expose raw tokens
      accessTokenPreview: acc.accessToken ? `${acc.accessToken.slice(0, 10)}…(${acc.accessToken.length})` : '',
    };
  }

  async add(rawJson, label, priority) {
    const norm = normalizeImport(rawJson);
    const acc = {
      id: crypto.randomBytes(8).toString('hex'),
      label: (label && label.trim()) || norm.email || '',
      enabled: true,
      priority: Number.isFinite(priority) ? priority : 100,
      createdAt: nowIso(),
      lastRefreshAt: null,
      lastError: null,
      usage: null,
      ...norm,
    };
    this.accounts.push(acc);
    await this.save();
    return this.redact(acc);
  }

  async update(id, patch) {
    const acc = this.get(id);
    if (!acc) throw new Error('account not found');
    if (typeof patch.label === 'string') acc.label = patch.label;
    if (typeof patch.enabled === 'boolean') {
      acc.enabled = patch.enabled;
      // Manually re-enabling clears the auto-disable markers and stale error.
      if (patch.enabled) { acc.autoDisabledAt = null; acc.autoDisabledReason = null; acc.lastError = null; }
    }
    if (typeof patch.profileArn === 'string') acc.profileArn = patch.profileArn;
    if (patch.priority != null && Number.isFinite(Number(patch.priority))) acc.priority = Number(patch.priority);
    await this.save();
    return this.redact(acc);
  }

  async remove(id) {
    const i = this.accounts.findIndex((a) => a.id === id);
    if (i === -1) throw new Error('account not found');
    this.accounts.splice(i, 1);
    await this.save();
  }

  // Return a valid access token for an account, refreshing if needed.
  async getAccessToken(acc) {
    if (this.isExpired(acc)) await this.refresh(acc);
    return acc.accessToken;
  }

  async refresh(acc) {
    if (this._refreshing.has(acc.id)) return this._refreshing.get(acc.id);
    const p = this._doRefresh(acc).finally(() => this._refreshing.delete(acc.id));
    this._refreshing.set(acc.id, p);
    return p;
  }

  async _doRefresh(acc) {
    if (!acc.refreshToken || !acc.tokenEndpoint) {
      throw new Error('cannot refresh: missing refreshToken or tokenEndpoint');
    }
    const form = new URLSearchParams();
    form.set('grant_type', 'refresh_token');
    form.set('refresh_token', acc.refreshToken);
    if (acc.clientId) form.set('client_id', acc.clientId);
    if (acc.scopes) form.set('scope', acc.scopes);

    const { status, body } = await httpJson(acc.tokenEndpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: form.toString(),
    });
    if (status < 200 || status >= 300) {
      acc.lastError = `refresh failed (${status})`;
      await this.save();
      throw new Error(`token refresh failed (${status}): ${body.slice(0, 300)}`);
    }
    const parsed = JSON.parse(body);
    acc.accessToken = parsed.access_token ?? acc.accessToken;
    if (parsed.refresh_token) acc.refreshToken = parsed.refresh_token;
    const expiresInSec = Number(parsed.expires_in) || 3600;
    acc.expiresAt = new Date(Date.now() + expiresInSec * 1000).toISOString();
    acc.lastRefreshAt = nowIso();
    acc.lastError = null;
    await this.save();
    return acc.accessToken;
  }

  // Is this account known to be out of quota (from the last usage fetch)?
  isExhausted(acc) {
    return Boolean(acc.usage && acc.usage.exhausted);
  }

  priorityOf(acc) {
    return Number.isFinite(acc.priority) ? acc.priority : 100;
  }

  // Classify an error as an authentication/authorization failure that should
  // take the account out of rotation. 401 (invalid/expired token the refresh
  // could not fix) and 403 (access denied / suspended) qualify. 402 (monthly
  // limit) and 5xx / network errors do NOT — those are quota or transient.
  isAuthFailure(err) {
    const code = err && err.statusCode;
    if (code === 401 || code === 403) return true;
    const msg = String(err?.message || '').toLowerCase();
    return /accessdenied|unauthorized|forbidden|invalid.*token|token.*expired|suspend/.test(msg)
      && !/monthly limit|quota|402/.test(msg);
  }

  // Record the outcome of using an account. On an auth failure the account is
  // auto-disabled so the selector skips it; the reason is stored for the UI.
  async recordResult(acc, err) {
    if (!err) {
      if (acc.lastError || acc.autoDisabledAt) { acc.lastError = null; }
      await this.save();
      return { disabled: false };
    }
    acc.lastError = err.message;
    if (this.isAuthFailure(err)) {
      acc.enabled = false;
      acc.autoDisabledAt = nowIso();
      acc.autoDisabledReason = `auth failure (${err.statusCode || 'error'}): ${err.message}`.slice(0, 300);
      await this.save();
      console.warn(`[store] auto-disabled account ${acc.id} (${acc.label || acc.email}): ${acc.autoDisabledReason}`);
      return { disabled: true };
    }
    await this.save();
    return { disabled: false };
  }

  // Pick an account to serve a request.
  //  - pin by id if given and usable
  //  - otherwise choose among enabled, non-expired, non-exhausted accounts
  //  - priority mode: lowest priority number wins; round-robin within a tie
  //  - round-robin mode: rotate across all eligible accounts
  // Falls back to ignoring the exhausted filter if every account is exhausted,
  // so a request still gets a (likely-overage) account rather than failing.
  pick(preferredId) {
    if (preferredId) {
      const acc = this.get(preferredId);
      if (acc && acc.enabled !== false) return acc;
    }
    let pool = this.accounts.filter((a) => a.enabled !== false && !this.isExpired(a, 0));
    if (pool.length === 0) {
      // allow expired ones (they'll be refreshed on use)
      pool = this.accounts.filter((a) => a.enabled !== false);
    }
    if (pool.length === 0) return null;

    let eligible = pool.filter((a) => !this.isExhausted(a));
    if (eligible.length === 0) eligible = pool; // everyone exhausted -> use anyway

    if (this.selectionMode === 'priority') {
      const minPrio = Math.min(...eligible.map((a) => this.priorityOf(a)));
      const top = eligible.filter((a) => this.priorityOf(a) === minPrio);
      const acc = top[this.rr % top.length];
      this.rr = (this.rr + 1) % top.length;
      return acc;
    }
    // round-robin across all eligible
    const acc = eligible[this.rr % eligible.length];
    this.rr = (this.rr + 1) % eligible.length;
    return acc;
  }
}
