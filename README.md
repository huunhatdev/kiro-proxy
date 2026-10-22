# Kiro Manager

Web UI + OpenAI-compatible proxy to manage **Kiro accounts/tokens**, packaged for
Docker. Paste a Kiro token JSON, the app stores it, auto-refreshes it, discovers
the enterprise profile ARN, and serves `/v1/chat/completions` + `/v1/models`
backed by your enabled accounts (round-robin).

Pure Node.js standard library — no npm dependencies.

## Run with Docker

```bash
cd kiro-manager
cp .env.example .env     # then edit .env
docker compose up -d --build
# UI:     http://localhost:8080/
# OpenAI: http://localhost:8080/v1
```

All configuration lives in `.env` (see `.env.example` for every option).
`docker-compose.yml` reads it via `env_file` and `${...}` substitution. Accounts
persist in the `kiro-data` volume. `.env` is git-ignored and excluded from the
image, so secrets stay local.

### Run without Docker

```bash
cd kiro-manager
cp .env.example .env     # optional; the app also reads plain env vars
node src/server.mjs
```

`node src/server.mjs` auto-loads `.env` from the `kiro-manager/` directory. Real
environment variables always take precedence over `.env`.

## Using it

1. Open `http://localhost:8080/`.
2. Paste the contents of your Kiro token file
   (`~/.aws/sso/cache/kiro-auth-token.json`) into **Thêm Kiro account** and click
   **Thêm account**.
3. The app decodes the email, stores the token, and tries to find the **Profile
   ARN** automatically. If it can't (common inside Docker), paste it in the
   *Profile ARN* field, or set it later with the **ARN** button on the row.
4. Click **Test** on the row to confirm the account can talk to Kiro.
5. Point any OpenAI client at `http://localhost:8080/v1`.

### Picking an account

By default the proxy round-robins over all **enabled** accounts. To pin a
request to one account, send its id:

```
X-Kiro-Account: <account-id>
```

or `?account=<account-id>` on the URL.

### Selection mode & priority

The toggle at the top of the UI sets how the proxy chooses an account when a
request is not pinned:

- **Theo priority** (default): the account with the lowest `priority` number
  wins. Accounts sharing the lowest number are used round-robin. Lower = higher
  priority (e.g. `5` is preferred over `100`).
- **Xoay vòng** (round-robin): rotate across all eligible accounts equally.

In both modes the proxy **skips accounts that are out of quota** (known from the
last quota fetch). If every account is exhausted it still serves one rather than
failing. Expired tokens are refreshed automatically on use. Set each account's
priority in the **Prio** column (saved on change) or in the add form.

### Quota

Click **Refresh quota** to fetch live usage for every account, or the quota is
fetched per account via the API. Each row shows the plan, a credits bar
(used / limit), remaining amount, and the next reset date; an account over its
limit is flagged **hết quota** and skipped by the selector.

The data comes from Kiro's `getUsageLimits` control-plane endpoint and requires
a profile ARN (external_idp accounts).

### Auto-disable on auth failure + failover

When an account's request fails with an **authentication/authorization error**
(HTTP 401/403, or an "access denied / invalid token / suspended" message), the
account is **automatically set to inactive** and the reason is stored and shown
in the UI (status **tự tắt**). The selector then skips it.

Within a single `/v1/chat/completions` request the proxy **fails over**: if the
chosen account auth-fails before any response byte is sent, it disables that
account and retries the next eligible one, so the caller still gets an answer.
Quota errors (402) and transient/server errors (5xx, network) do **not** disable
an account — only credential problems do.

Re-enable an account with the **Bật** button; that clears the auto-disable
reason and stale error.

## Profile ARN

Kiro requires an enterprise profile ARN
(`arn:aws:codewhisperer:…:profile/…`) that is **not** inside the token file. The
app finds it in this order:

1. the `profileArn` you pass when adding an account (UI field), else
2. **network discovery** — it calls Kiro's `listAvailableProfiles` with your
   access token and reads the ARN from the response. This works in Docker with
   **no kiro-cli installed**. The token must be fresh enough to authenticate
   (the app refreshes it automatically before discovery), else
3. a mounted kiro-cli cache under `KIRO_HOME` (default `/root/.kiro`).

If all three fail (e.g. an account type the control plane refuses), paste the
ARN with the **ARN** button. The **Dò ARN** button re-runs network discovery on
demand for an existing account.

To get the ARN manually from a machine that has kiro-cli, read
`profileArn` in `~/.kiro/enterprise-management/<hash>/entry.json`.

Mounting `~/.kiro` into Docker (step 3) is optional — only needed when network
discovery is refused for your account type. See the commented volume in
`docker-compose.yml` and `KIRO_HOME_HOST` in `.env`.

## Security

- The access tokens this app stores can act as your account. Keep the port on a
  trusted network.
- Set `ADMIN_TOKEN` to require a token for the management UI/API
  (`?token=…` or `X-Admin-Token` header).
- Set `API_KEY` to require `Authorization: Bearer <API_KEY>` on `/v1/*`.
- Raw tokens are never returned by the API — only redacted previews.

## Environment variables

Set these in `.env` (copy `.env.example`).

| Var | Default | Scope | Meaning |
|-----|---------|-------|---------|
| `HOST_PORT` | `8080` | host | Port exposed on the host (what you browse to) |
| `PORT` | `8080` | container | Port the app listens on inside the container |
| `HOST` | `0.0.0.0` | container | Bind address (keep `0.0.0.0` in Docker) |
| `DATA_DIR` | `/data` (Docker) | container | Where `accounts.json` is stored |
| `ADMIN_TOKEN` | *(none)* | container | Protect the management UI/API |
| `API_KEY` | *(none)* | container | Protect the OpenAI proxy (`/v1/*`) |
| `KIRO_ENDPOINT` | `https://runtime.us-east-1.kiro.dev` | container | Backend base URL |
| `KIRO_ORIGIN` | `KIRO_CLI` | container | Request origin sent to Kiro |
| `KIRO_HOME` | `/root/.kiro` (Docker) | container | Where to look for the profile-ARN cache |
| `KIRO_HOME_HOST` | *(none)* | host | Host path to mount as `/root/.kiro` (also uncomment the volume in compose) |

## Models

`auto` (backend picks) plus `claude-sonnet-4`, `claude-sonnet-4.5`,
`claude-sonnet-4.5-1m`, `claude-sonnet-4.6`, `claude-sonnet-4.6-1m`,
`claude-opus-4.5/4.6/4.6-1m/4.7`, `claude-haiku-4.5`, `qwen3-coder-480b`,
`gpt-5.1`.

## Management API

All under `/api` (require `X-Admin-Token` when `ADMIN_TOKEN` is set):

| Method | Path | Body | Purpose |
|--------|------|------|---------|
| GET | `/api/accounts` | — | List accounts (redacted) + selectionMode |
| POST | `/api/accounts` | `{ json, label?, profileArn?, priority? }` | Add an account |
| PATCH | `/api/accounts/:id` | `{ label?, enabled?, profileArn?, priority? }` | Edit |
| DELETE | `/api/accounts/:id` | — | Remove |
| POST | `/api/accounts/:id/refresh` | — | Force token refresh |
| POST | `/api/accounts/:id/discover-arn` | — | Re-run network ARN discovery |
| POST | `/api/accounts/:id/test` | — | One-shot chat to verify |
| GET | `/api/accounts/:id/quota` | — | Fetch + cache usage for one account |
| POST | `/api/quota/refresh` | — | Fetch usage for all accounts |
| GET | `/api/settings` | — | Get selection mode |
| PUT | `/api/settings` | `{ selectionMode }` | `priority` or `round-robin` |

## Limitations

- Translates OpenAI **Chat Completions** to the Kiro **Responses** backend.
  Tool/function calling and image inputs are not wired through yet.
- Usage token counts are returned as zero.
