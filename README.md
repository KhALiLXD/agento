# AGENTO

AGENTO is a schema-driven AI runtime for executing real REST APIs. The public package API is V2 (`AgentRuntime`); the old `AgentHandler` runtime and local JWT/JWKS verifier have been removed.

V2 owns configuration compilation, model tool routing, input/dependency resolution, confirmation, bounded HTTP execution, session state and safe opaque credential transport. Your downstream API remains the authority for authentication, token expiry, scopes and business authorization. AGENTO forwards `auth.token` as `Authorization: Bearer ...` for tools configured with `request.auth.type: session`; upstream `401`/`403` becomes `AUTH_REJECTED`.

For Windows/PowerShell and the existing salon API, start with [دليل التشغيل بالعربية](docs/RUNNING_AR.md) or [Discord setup](examples/discord-bot/README.md).

## Install and verify

```sh
npm ci
npm run build
npm test
npm run lint
```

The test suite is deterministic and exercises the runtime boundaries with controlled transport/model adapters. The published examples do not create mock APIs or fake tokens; they require your real API and credentials.

## Minimal V2 usage

```ts
import { AgentRuntime } from "agento-runtime";

const runtime = await AgentRuntime.create({ configPath: "./agent.yml" });
const result = await runtime.invoke({
  sessionId: "server-owned-session-id",
  tool: "search-services",
  arguments: { q: "hair coloring" },
  auth: { token: request.userAccessToken },
});

if (result.status === "needs_confirmation") {
  // Only after explicit user approval:
  await runtime.confirm({
    sessionId: result.sessionId,
    confirmationId: result.confirmation.id,
    auth: { token: request.userAccessToken },
  });
}
```

Never put credentials in tool arguments, prompts or client-selected session IDs. Bind the session ID to the authenticated caller in your host application. AGENTO stores the opaque token encrypted for continuations; it never decodes or verifies it.

## Configuration shape

```yaml
version: "2"
models:
  routing:
    provider: openai
    model: gpt-4o-mini
    api_key: $ENV:OPENAI_API_KEY
tools:
  - id: search-services
    tool:
      description: Search the service catalog
      input_schema:
        type: object
        properties:
          q: { type: string, minLength: 1 }
        required: [q]
    request:
      method: GET
      url: https://api.example.com/services
      map:
        query: { q: $.q }
```

For user-specific endpoints:

```yaml
request:
  method: POST
  url: https://api.example.com/bookings
  auth: { type: session }
```

See [the V2 guide](docs/v2/README.md) for statuses, mappings, dependencies, confirmation, HTTP policy and production session-store requirements.

## Real API examples

Catalog and booking are API contract templates. Set your API base and model credentials, then use the interactive chat console:

```sh
export AGENTO_API_BASE_URL=https://api.your-service.example
export AGENTO_USER_ACCESS_TOKEN=real-user-access-token
export OPENAI_API_KEY=your-model-api-key
npm run demo:catalog
npm run demo:booking
```

Use `-- --direct` to invoke the same APIs manually without a model (no model key is needed in that mode). The console supports `/tools`, `/invoke tool-id {"field":"value"}`, `/cancel` and `/exit`. Booking executes only after you type `CONFIRM`. `examples/travel-agent` is an interactive V2 CLI using a real OpenAI model and travel API. `examples/discord-bot` is a Discord integration using the same V2 runtime and an API-owned user token.

## Documentation

- [V2 guide](docs/v2/README.md)
- [Configuration and mapping](docs/v2/CONFIGURATION.md)
- [Authentication boundary and operations](docs/v2/SECURITY-OPERATIONS.md)
- [Provider setup](docs/v2/PROVIDERS.md)
- [MCP integration](docs/v2/MIGRATION-MCP.md)
- [Verification and known limits](docs/v2/VERIFICATION.md)

## Development

```sh
npm run format
npm run test:coverage
npm pack --dry-run
```

The package requires Node.js 20.11 or newer and is ESM-only.
