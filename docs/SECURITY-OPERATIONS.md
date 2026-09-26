# Authentication, sessions and production operations

## Authentication boundary

AGENTO v2 is an API-execution layer, not an identity provider or an
authorization gateway. It does not decode JWTs, fetch JWKS keys, validate
issuers/audiences, or decide whether a user may access a business resource.
The configured downstream API remains the authority for login state, token
validity, scopes and resource permissions.

For a user-authenticated tool, declare opaque session transport:

```yaml
request:
  auth:
    type: session
```

Pass the access token from the trusted host integration:

```ts
const result = await runtime.invoke({
  sessionId: serverOwnedSessionId,
  tool: "book",
  arguments: { date: "2026-10-01" },
  auth: { token: userAccessToken },
});
```

AGENTO forwards the token as `Authorization: Bearer <token>` when the tool is
executed. It can retain the opaque token in its encrypted session credential
store so a continuation such as `confirm()` can reuse it. It never sends the
token to a model, includes it in tool schemas, writes it to ordinary session
context, or exposes it in results and hooks. The token is not locally verified;
the API response is authoritative:

- `2xx`: the API accepted and completed the request.
- `401`: the API rejected the missing, invalid or expired authentication.
- `403`: the API rejected the authenticated caller's permission.

Both `401` and `403` are surfaced as the runtime error `AUTH_REJECTED`, with
the upstream status in the bounded error details. The host can translate that
result into its own “sign in again” or “not allowed” message.

The host must still bind `sessionId` to the authenticated caller. A session ID
is a conversation/credential-reuse handle, not proof of identity. Never accept
an arbitrary client-selected session ID or allow a client to attach another
user's token to an existing session. If account switching is supported, clear
the old session or use a fresh server-owned session ID.

If the API uses a static service credential instead of a user token, configure
it independently:

```yaml
request:
  auth:
    type: api-key
    env: SERVICE_KEY
    header: X-API-Key
```

The key is resolved from the host environment and is never exposed to model
tool definitions. `type: none` is appropriate only for genuinely public
endpoints. Do not place credentials in URLs, ordinary input fields or model
instructions.

## Transport and data minimization

- Credential-bearing requests require HTTPS. `allow_insecure_http: true` is
  for local development only.
- Redirects are rejected so a token cannot be forwarded to another origin.
- Known credential values, bearer strings and sensitive object fields are
  redacted recursively from model requests, user-visible results, hooks,
  configuration getters and history.
- Response projections enforce item and character limits; HTTP body byte
  limits are enforced before parsing.
- Only event metadata is emitted, not raw prompts, request bodies, headers or
  private model reasoning.

Redaction is a transport safeguard, not a generic PII detector. Return only
appropriate data from the API and apply domain-specific minimization in the
API itself.

## Session and concurrency contract

`SessionStore` exposes `get`, `set`, `delete`, `touch`, and `transact`. All
public operations on one session are serialized through `transact`; different
sessions can run concurrently. The provided memory store works across runtime
instances sharing that same store object in one process.

For horizontal deployment, provide all of:

- A shared session store whose `transact` uses renewable distributed
  locking/fencing or equivalent serialization.
- A shared encrypted opaque-token store and encryption key if credentials are
  reused across workers.
- A shared `RateLimiter` if limits must apply across workers.
- Backend idempotency and reconciliation for side effects.

The default memory implementations do not provide cross-process coordination.
Circuit breakers are per runtime instance. Session history is bounded
separately from a lifetime message counter. Expiration clears state and returns
`SESSION_EXPIRED`; a subsequent turn can start fresh. Facts also have
individual TTLs.

Before a confirmed side effect, the consumed confirmation and `EXECUTING`
marker are persisted. If a process dies or final persistence fails, another
worker observing that marker returns `TOOL_EXECUTION_UNCERTAIN`. Reconcile with
the upstream API before retrying; clearing the session is an operational
decision, not an automatic retry.

## Limits and observability

`rate_limits` independently governs AI calls, HTTP attempts and incoming
operations per window, plus lifetime operations per session. Retries consume
HTTP quota. Use a custom limiter or host gateway for global, tenant or IP
budgets.

Results report model/HTTP call counts, input/output tokens, duration, retry
count, dependency steps, routing duration and HTTP duration. `onEvent` emits
routing, candidates, selected tool, missing fields, dependencies,
confirmations, execution, model calls, retries and errors. `debug: true` adds
shortlist scores and mapped field names without chain-of-thought or secrets.
`diagnostics()` exposes circuit status.

Use a request `AbortSignal` for cancellation. Serve with a trusted immutable
config, manage environment keys outside code, and configure server/network
egress controls when APIs or configs originate from untrusted parties.
`dispose()` releases owned credential-store resources; it does not abort calls
already in progress.
