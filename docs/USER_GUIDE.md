# AGENTO user guide

AGENTO V2 turns a strict YAML tool catalog into a runtime that routes user messages, gathers validated inputs, resolves declared dependencies, asks for confirmation and calls your real APIs.

## Start

```sh
npm ci
npm run build
npm test
```

To run a real API walkthrough:

```sh
export AGENTO_API_BASE_URL=https://api.your-service.example
export AGENTO_USER_ACCESS_TOKEN=real-user-access-token
export OPENAI_API_KEY=your-model-api-key
npm run demo:catalog
npm run demo:booking
```

The examples do not start a fake HTTP server and do not sign or verify local JWTs. They use the token supplied by your trusted host integration.

## Runtime creation

```ts
import { AgentRuntime } from "agento-runtime";

const runtime = await AgentRuntime.create({
  configPath: "./agent.yml",
  presentation: "raw", // use "ai" when models.presentation is configured
});
```

Exactly one of `config`, `configYml` or `configPath` is required. V2 rejects unknown configuration keys and compiles input/output schemas at startup.

## Calling tools

For deterministic server-side calls, use `invoke`:

```ts
const result = await runtime.invoke({
  sessionId: serverOwnedSessionId,
  tool: "search-services",
  arguments: { q: "hair coloring" },
  auth: { token: userAccessToken },
});
```

For model-routed conversation, configure `models.routing` and call `chat`:

```ts
const result = await runtime.chat({
  sessionId: serverOwnedSessionId,
  message: "Find me a hair coloring appointment",
  auth: { token: userAccessToken },
});
```

Handle every result status:

| Status               | Host action                                                                                     |
| -------------------- | ----------------------------------------------------------------------------------------------- |
| `completed`          | Render `message` and/or authoritative `data`.                                                   |
| `needs_input`        | Ask for the JSON-pointer fields in `missing`, then continue with `chat` or a complete `invoke`. |
| `needs_selection`    | Render `selection.options` and call `select` with the returned option ID.                       |
| `needs_confirmation` | Show `confirmation.preview`; call `confirm` only after explicit approval.                       |
| `error`              | Handle `error.code`; never infer success from prose.                                            |

```ts
await runtime.select({
  sessionId,
  selectionId: result.selection.id,
  choice: selectedOptionId,
  auth: { token: userAccessToken },
});
await runtime.confirm({
  sessionId,
  confirmationId: result.confirmation.id,
  auth: { token: userAccessToken },
});
```

Use `cancel` to clear a pending flow and `clearSession` when the host logs a user out or changes account binding. `dispose` releases process-local resources.

## Authentication boundary

AGENTO does not implement login, decode JWT claims, fetch JWKS keys, check issuers/audiences or decide business permissions. Configure user endpoints with:

```yaml
request:
  auth:
    type: session
```

Pass the access token in `auth.token`. AGENTO forwards it as a Bearer header and retains it encrypted only for the server-owned session. A downstream `401` or `403` is returned as `AUTH_REJECTED`. Use `api-key` for a server-to-server environment credential and `none` only for genuinely public endpoints.

The host must bind each session ID to the caller. Never accept an arbitrary client session ID or put a token in a prompt, ordinary input field, URL, log or response.

## Mapping and dependencies

All fields are declared in `tool.input_schema`; request destinations are explicit under `request.map.path`, `query`, `body` and `headers`. Sources can be tool input, session context, dependency output, constants or generated UUIDs. Dependencies and selection paths are explicit and validated at startup. No legacy implicit field or endpoint behavior is inherited.

## Operational guidance

- Use HTTPS for every credential-bearing tool; redirects are blocked.
- Configure backend idempotency before enabling retries for side effects.
- Use a distributed `SessionStore` and `RateLimiter` when running multiple workers.
- Treat side-effect failures as potentially ambiguous and reconcile with the API before retrying.
- Keep model presentation optional; raw API data is authoritative.
