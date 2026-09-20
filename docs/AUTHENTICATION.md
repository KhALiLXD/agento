# Authentication in AGENTO V2

AGENTO is an API execution layer. Authentication and authorization belong to the downstream API that owns the resource. AGENTO does not issue tokens, decode JWTs, fetch JWKS keys, validate issuers/audiences or infer user identity from claims.

## User access tokens

Mark a user-specific tool as session-authenticated:

```yaml
request:
  auth:
    type: session
```

Pass the real access token obtained by your application:

```ts
const result = await runtime.invoke({
  sessionId: serverOwnedSessionId,
  tool: "book",
  arguments: { slot_id: "slot-11" },
  auth: { token: userAccessToken },
});
```

The runtime validates only transport-safe input, stores the opaque value encrypted for the server-owned session and forwards it as `Authorization: Bearer <token>`. It never puts the token in model context, input schemas, ordinary session context, logs or public responses.

The API decides the result:

- `2xx`: the API accepted the call.
- `401`: missing, invalid or expired login according to the API.
- `403`: authenticated but not permitted by the API.

Both `401` and `403` become `AUTH_REJECTED`. The host can then ask the user to sign in again or explain that the operation is not allowed.

## Server credentials

For a server-to-server API key, keep it outside YAML values and use an environment reference:

```yaml
request:
  auth:
    type: api-key
    env: BOOKINGS_API_KEY
    header: X-API-Key
```

Use `type: none` only for genuinely public endpoints. Credentials must not appear in URLs, tool arguments, prompts or client-controlled context.

## Host responsibilities

The host application must:

1. Obtain the access token through its own trusted login flow.
2. Bind the server-owned `sessionId` to the authenticated caller.
3. Pass the caller's token on the first turn and on explicit continuations when appropriate.
4. Call `clearSession` on logout or account switching, or allocate a fresh session ID.
5. Translate `AUTH_REJECTED` into the host's sign-in/permission UX.

AGENTO cannot prove that an arbitrary client-selected session belongs to a user. That binding is intentionally outside the runtime.

## Transport safeguards

Credential-bearing requests require HTTPS, block redirects and redact known tokens recursively from results, history, hooks and diagnostics. For horizontal deployments, provide a shared encrypted opaque-token store and a distributed session transaction implementation. These safeguards protect transport and storage; they do not replace the API's identity or authorization policy.
