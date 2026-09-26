# AGENTO v2

**Already have an API? Make it agent-ready.**

AGENTO compiles declarative API definitions into model-facing tools and a separate execution registry. The runtime owns validation, dependency data flow, sessions, credential transport, confirmation, HTTP policy and errors. Models select a shortlisted tool and extract user arguments.

This branch is a **2.0.0-alpha.2 implementation**, not a claim that every deployment is production certified. The scoped package name `agento-runtime` is prepared locally; it has not been published or checked for registry ownership. Node 20.11+ is required. Coverage commands require a recent Node release (verified on Node 24).

## Start

```sh
npm ci
npm test
# Configure AGENTO_API_BASE_URL, OPENAI_API_KEY and AGENTO_USER_ACCESS_TOKEN first.
npm run demo:catalog
npm run demo:booking
```

The demos call the real API configured through `AGENTO_API_BASE_URL` and use `OPENAI_API_KEY` for real model routing. `AGENTO_USER_ACCESS_TOKEN` is optional; without it the API decides whether to reject the request. For local HTTP set `AGENTO_ALLOW_INSECURE_HTTP=true`. Add `-- --direct` for manual invocation without a model. They do not start a local API, inject a fake model, sign a local token or verify credentials locally. The booking walkthrough asks for explicit approval before the real side effect.

V2 treats user credentials as opaque transport data. Pass a user's access token as `auth.token`; AGENTO forwards it as `Authorization: Bearer ...` for tools with `request.auth.type: session`. The downstream API remains responsible for token validity, login state, scopes and resource permissions. A `401` or `403` response is returned as `AUTH_REJECTED`; V2 does not require a JWT verifier, JWKS URL or local authorization layer.

```ts
import { AgentRuntime, MemorySessionStore } from "agento-runtime";

const runtime = await AgentRuntime.create({
  configPath: "./agent.yml",
  sessionStore: new MemorySessionStore(),
  presentation: "raw",
});

const accessToken = request.authenticatedUserAccessToken;
const result = await runtime.invoke({
  sessionId: "server-owned-session-id",
  tool: "search-services",
  arguments: { q: "hair coloring" },
  auth: { token: accessToken },
});
```

For a later continuation, pass the token again or let the runtime reuse the
opaque token retained for that server-owned session. Never let a client choose
another user's session ID, and never put credentials in tool arguments or model
prompts.

For conversation, configure `models.routing` in YAML or supply a `ModelAdapter`, then call `runtime.chat({ sessionId, message })`. Raw invocation does not require a model. `config`, `configYml`, and `configPath` are mutually exclusive; files are read only during initialization.

## Configuration example

```yaml
version: "2"
assistant:
  name: Rozy
  language: auto
  system_prompt: |
    You are a friendly application assistant. Reply in the user's language.
    Do not invent facts that should come from application tools.
  conversation:
    enabled: true
models:
  routing:
    provider: openai
    model: gpt-4o-mini
    api_key: $ENV:OPENAI_API_KEY
    temperature: 0
  presentation:
    provider: openai
    model: gpt-4o-mini
    api_key: $ENV:OPENAI_API_KEY
    temperature: 0.5
routing:
  candidate_limit: 6
  lexical:
    min_score: 1.0
  semantic_recall:
    enabled: true
    candidate_limit: 6
    max_catalog_tools: 100
    max_catalog_chars: 100000
tools:
  - id: search-services
    tool:
      description: Search services by treatment or keyword.
      input_schema:
        type: object
        properties:
          q: { type: string, minLength: 1 }
          limit: { type: integer, minimum: 1, maximum: 50, default: 10 }
        required: [q]
    trigger_hints: [hair services]
    request:
      method: GET
      url: https://api.example.com/services
      map:
        query:
          q: $.q
          limit: $.limit
    response:
      model_view:
        path: $.data
        max_items: 20
        max_chars: 12000
        include: [id, name, price]
```

`trigger_hints` contribute scores; they never execute a tool by themselves. Retrieval first ranks normalized phrases, lexical matches and weighted keywords. Strong matches go directly to final tool selection. Weak or empty matches use a lightweight model-recall request containing only tool ID, title and description, then final selection receives only the shortlisted full tool definitions. This supports an Arabic, French or other model-supported user request against English-only metadata. Translated hints remain a useful cost/latency optimization, not a correctness requirement.

A valid no-tool result is conversational by default. `AgentRuntime.chat()` uses the presentation model (or routing model when no presentation model exists), bounded `session.history`, the assistant system prompt and a lightweight capability summary. It does not execute tools or receive credentials. Set `assistant.conversation.enabled: false` for router-only behavior, where no match returns `ROUTING_NO_MATCH`.

Semantic recall adds one model call only when lexical confidence is below `routing.lexical.min_score`. It is skipped when the catalog exceeds `routing.semantic_recall.max_catalog_tools` or `max_catalog_chars`; large deployments should inject a more selective retriever. Recall failure remains a model error rather than silently becoming conversation.

## Results and continuations

Every result has `version: '2'`, request/session IDs, a status and metrics. Handle all statuses:

| Status               | Application action                                                                                           |
| -------------------- | ------------------------------------------------------------------------------------------------------------ |
| `completed`          | Render `data`, `message`, or both.                                                                           |
| `needs_input`        | Ask for the `missing` JSON-pointer fields; send the reply through `chat`, or invoke with complete arguments. |
| `needs_selection`    | Render `selection.options`; call `select` with its ID and the chosen option ID.                              |
| `needs_confirmation` | Show `confirmation.preview` and call `confirm` only after the user approves.                                 |
| `error`              | Handle `error.code`; do not infer success from a generic message.                                            |

```ts
await runtime.select({
  sessionId,
  selectionId: result.selection!.id,
  choice: "slot-11",
});
await runtime.confirm({ sessionId, confirmationId: result.confirmation!.id });
await runtime.cancel({ sessionId });
```

A bare “yes” cannot confirm an action. Confirmation IDs are scoped to the current session, arguments, dependencies, context and config. Confirmation is consumed and persisted before executing. Replays, expiry or input/context changes are rejected. `cancel` clears the pending flow. A fresh direct invocation replaces the pending flow.

`presentation: 'raw' | 'ai' | 'both'` controls response formatting. AI presentation is optional, operates on bounded, sanitized API projections and may still be imperfect; use raw data for authoritative UI fields. Presentation failure preserves successful tool data and does not re-execute the API.

## Guides

- [Architecture and implementation decisions](ARCHITECTURE.md)
- [Configuration, dependencies, mapping and errors](CONFIGURATION.md)
- [Authentication, sessions and production operation](SECURITY-OPERATIONS.md)
- [Provider protocols and capability matrix](PROVIDERS.md)
- [Migration and MCP integration](MIGRATION-MCP.md)
- [Verification and remaining limits](VERIFICATION.md)
- [Catalog YAML](../../examples/v2/catalog.yml)
- [Booking YAML](../../examples/v2/booking.yml)
