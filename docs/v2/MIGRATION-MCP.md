# Migration and MCP foundation

## Migrating an old configuration

The V2 package has one public runtime: `AgentRuntime`. The old `AgentHandler` runtime and its verifier-based authentication path are not shipped. A legacy YAML file can be converted into a review-required V2 draft, but it is never executed as V1.

```ts
import { migrateLegacyConfig, compileConfig } from "@lousin/agento/v2";
const draft = migrateLegacyConfig(oldYaml);
console.log(draft.warnings);
// Review request.auth, dependencies, selections and response presentation first.
const compiled = compileConfig(draft.config);
```

Migration returns a **review-required draft**, not a silently runnable compatibility mode. It translates descriptions, triggers, query fields, payload fields, known value sources, path placeholders and response hints. It unifies query/body/path input schemas and defaults mutating methods to confirmation-required effects. Undeclared arbitrary sources fail explicitly.

| Legacy                                        | v2                                             |
| --------------------------------------------- | ---------------------------------------------- |
| `endpoints`                                   | `tools`                                        |
| `description_for_ai`                          | `tool.description`                             |
| `query_params`, conversational payload fields | `tool.input_schema` + `request.map`            |
| `payload` session/generated/constants         | Explicit value source objects                  |
| `field_mapping: response_field: input_field`  | `map: $.input_field: $.response_field`         |
| Implicit `id/name/title` selection            | Explicit `items_path`, `id_path`, `label_path` |
| `action`                                      | `behavior.effect` + required confirmation      |
| Text “yes” confirmation                       | Host-mediated `confirm` with the pending ID    |
| `authToken`                                   | `auth: { token }` (opaque pass-through to API) |
| v1 response envelope                          | Version `2` with discriminated status handling |

Auth/headers, implicit selection/navigation/dependencies, providers, global policy and custom instructions require review. Warnings identify these omissions. Define `request.auth.type: session` for user-specific tools and pass the opaque access token in `auth.token`; the downstream API remains responsible for authentication and authorization. Do not treat successful schema compilation as approval of business semantics.

## MCP

```ts
import { createMcpAdapter } from "@lousin/agento/v2";
const handlers = createMcpAdapter(runtime, async () => ({
  sessionId: serverSessionId,
  auth: { token: verifiedCallerAccessToken },
}));

const listResult = await handlers.listTools();
const callResult = await handlers.callTool({
  name: "search-services",
  arguments: { q: "hair" },
});
```

Mount these functions in the official MCP SDK's `tools/list` and `tools/call` handlers. Tool metadata and read-only/destructive/idempotent annotations derive from the same compiled config. `structuredContent` contains the versioned AGENTO result; its advertised output schema describes that envelope, not the upstream API body. `isError` identifies runtime errors. Missing input/selection/confirmation are structured continuation states.

This is an **adapter foundation**, not a complete MCP transport server: initialization, transport, protocol negotiation, transport auth and request-scoped identity resolution belong to the host SDK integration. Resolve a fresh context for each call. Never derive credentials or session ownership from model-supplied tool arguments. Host `select` and `confirm` methods are provided; confirmation is intentionally not listed as a model-callable tool.

The core runtime has no MCP package dependency and works without MCP. A future CLI/transport can use these handlers without duplicating business configuration.

Official references: [MCP tools specification](https://modelcontextprotocol.io/specification/2025-06-18/server/tools), [MCP TypeScript SDK](https://github.com/modelcontextprotocol/typescript-sdk).
