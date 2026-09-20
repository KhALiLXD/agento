# Configuration and execution contract

`src/v2/config/schema.ts` is the canonical config contract. Unknown configuration keys are rejected. Initialization rejects duplicate tool IDs, unsupported methods/providers, missing descriptions, invalid schemas/URLs, unsafe auth, unresolved path placeholders, undeclared input mappings, unknown dependencies, duplicate/conflicting dependency mappings, missing navigation targets and dependency cycles.

## Mapping

All user fields live in `tool.input_schema`. `request.map.path`, `.query`, `.body`, and `.headers` select where they are sent. No implicit query-versus-payload inference is used in v2.

| Source     | Example                                                          | Resolution                               |
| ---------- | ---------------------------------------------------------------- | ---------------------------------------- |
| Tool input | `$.q` or `{ source: tool-input, path: $.q }`                     | Validated arguments                      |
| Session    | `{ source: session, path: $.user.id }`                           | Host-supplied, sanitized session context |
| Dependency | `{ source: dependency, tool: availability, path: $.slot_token }` | Explicitly declared dependency result    |
| Constant   | `{ source: constant, value: SAR }`                               | Frozen configuration value               |
| Generated  | `{ source: generated, generator: uuid }`                         | Generated when preparing the operation   |

Missing optional tool-input mappings are omitted. Missing session/dependency/constant sources fail explicitly. Query arrays repeat the key; nested query/header objects are rejected. Body mappings can map nested input objects as values. Paths support `$` and `$.object.field`; numeric path components can address array entries. Prototype-related property names are forbidden. Path values are encoded and traversal/slash/control-character values are rejected. Authentication headers must be configured through `request.auth`.

Input/output JSON Schema uses draft-07 with local references, strict AJV validation and standard formats (including date). Remote references are not fetched. Root input schemas must be objects. Request source validation requires explicit properties for referenced paths; complex `$ref`-only property mappings should be flattened. Limits include maximum tool count, history length, response bytes and dependency steps. Apply host-level limits to untrusted YAML sizes and schema complexity.

## Dependencies and facts

A dependency specifies `tool`, optional input `arguments`, output-to-parent `map`, optional `select`, and `ttl_ms`:

```yaml
depends_on:
  - tool: availability
    arguments:
      date: $.date
    select:
      items_path: $.slots
      id_path: $.slot_token
      label_path: $.label
    map:
      $.slot_token: $.slot_token
    ttl_ms: 30000
```

`when: missing` resolves a dependency only when a mapped destination is absent from host/navigation inputs. The default `when: always` refreshes/resolves the dependency even with supplied destination values. Once resolved, cached dependency data still obeys its TTL.

Dependency map keys are **parent destination paths**, values are **dependency output paths**. This is the reverse of legacy `field_mapping`. Selection paths must be configured; no `id/name/title` heuristic exists. One item is selected automatically for a dependency, multiple items pause for selection, and an empty or malformed set fails explicitly. Duplicate option IDs are rejected.

Facts store source, producing tool, creation time and expiry. Dependency results are cached against arguments and session context. Expired facts are removed; successful side effects invalidate cached facts. Confirmation expiry cannot outlive its dependency data, including expiry inherited from a multi-level chain. Selection is bound to the server-owned session and context. Internal dependency-owned inputs are omitted from confirmation previews. Navigation is explicit and selection-based; dependency graphs, not navigation paths, are required to be acyclic.

## Authentication mapping

V2 does not verify user JWTs or make business authorization decisions. For
user-specific APIs, use `request.auth.type: session`; the host supplies an
opaque access token through `auth.token`, and AGENTO forwards it as a Bearer
header. The API decides whether the token is valid and whether the caller may
perform the operation. Upstream `401` and `403` responses become
`AUTH_REJECTED`.

Use `request.auth.type: api-key` for a server-to-server credential resolved from
an environment variable. Use `none` only for public endpoints. Keep the
server-owned session ID bound to the caller; AGENTO cannot infer that binding
from an opaque token.

## HTTP policy

- Timeout includes fetch and body reading; response bodies are streamed with a byte ceiling.
- GET/HEAD and declared idempotent operations can retry transient errors. Other side effects get one attempt unless backend idempotency is explicitly declared.
- `retry.attempts` is the **total** number of attempts, not retries. Maximum is 5. Backoff supports a multiplier and bounded jitter.
- A generated `Idempotency-Key` and generated mapped values stay stable across retries and confirmation. The backend must implement idempotency for the guarantee to mean anything.
- 3xx responses are blocked; 4xx are categorized, with upstream 401/403 surfaced as `AUTH_REJECTED`; 429 and 5xx are transient. 204/205 and HEAD yield `null`. JSON MIME types are parsed; malformed JSON is distinct from HTTP failure.
- Circuit breakers are per runtime/tool. Ordinary 400/401/403/404 do not count as server instability. A single recovery probe is allowed after reset.

## Errors

| Boundary      | Examples                                                                                                                 |
| ------------- | ------------------------------------------------------------------------------------------------------------------------ |
| Config        | `CONFIG_INVALID`, `CONFIG_SCHEMA_INVALID`, `CONFIG_DEPENDENCY_CYCLE`, `CONFIG_PATH_PARAMETER_UNRESOLVED`                 |
| Model         | `MODEL_PROVIDER_ERROR`, `MODEL_TIMEOUT`, `MODEL_RESPONSE_MALFORMED`, `MODEL_SCHEMA_VIOLATION`                            |
| Routing/input | `ROUTING_NO_MATCH`, `INPUT_REQUIRED`, `INPUT_SCHEMA_VIOLATION`, `INPUT_SELECTION_STALE`                                  |
| Auth/session  | `AUTH_REJECTED`, `AUTH_REQUIRED` (missing service key), `SESSION_EXPIRED`                                                |
| Execution     | `TOOL_TIMEOUT`, `TOOL_REDIRECT_BLOCKED`, `TOOL_SERVER_ERROR`, `TOOL_OUTPUT_SCHEMA_VIOLATION`, `TOOL_EXECUTION_UNCERTAIN` |
| Policy        | `CONFIRMATION_STALE`, `DEPENDENCY_LIMIT`, `RATE_LIMITED`, `RATE_SESSION_LIMIT`                                           |

Initialization errors throw `AgentRuntimeError`. Public runtime operations return an error result. Provider/API response bodies and arbitrary external error messages are excluded from error details. Errors after a side-effect HTTP attempt carry `details.executionMayHaveOccurred: true`; reconcile with the backend before retrying the business operation. Developers receive actionable config paths without resolved secrets.
