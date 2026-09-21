# Configuration and execution contract

`src/v2/config/schema.ts` is the canonical config contract. Unknown configuration keys are rejected. Initialization rejects duplicate tool IDs, unsupported methods/providers, missing descriptions, invalid schemas/URLs, unsafe auth, unresolved path placeholders, undeclared input mappings, unknown dependencies, duplicate/conflicting dependency mappings, missing navigation targets and dependency cycles.

## Assistant and routing

`assistant.system_prompt` controls global persona, tone and casual conversation. It is separate from `tool.response.instructions`, which controls presentation only after an API executes. `assistant.language: auto` asks the model to respond primarily in the current user's language; it does not translate structured arguments. Conversation is enabled by default and can be disabled with `assistant.conversation.enabled: false`.

Routing has two retrieval stages:

1. `routing.lexical` performs cheap Unicode-aware matching. Arabic diacritics and tatweel are removed and common alef forms are normalized by default. Trigger hints and multi-word keywords are phrase-aware.
2. When the best lexical score is below `routing.lexical.min_score`, `routing.semantic_recall` asks the routing model for up to `candidate_limit` IDs from the cached lightweight catalog. Only `id`, `title`, and `description` are included. Unknown IDs are discarded.

The fused shortlist is bounded by `routing.candidate_limit`; only then are full model-facing tool definitions and input schemas sent to final tool selection. Endpoint URLs, methods, mappings, dependencies, auth configuration, headers and credentials are never part of recall. Strong lexical routes avoid the recall call. Recall is skipped above `max_catalog_tools` or `max_catalog_chars` so large catalogs do not enter an unbounded prompt; provide a custom selective retriever for those deployments. Tool titles and descriptions also have compiler-enforced size limits.

No tool and no lexical candidate are different outcomes. A successful recall/selection decision with no relevant tool enters conversation. A recall provider failure remains `MODEL_PROVIDER_ERROR`. With conversation disabled, a deliberate no-match returns `ROUTING_NO_MATCH`.

```yaml
assistant:
  language: auto
  system_prompt: |
    Respond naturally. Do not invent application facts.
  conversation:
    enabled: true
    include_capability_summary: true
routing:
  candidate_limit: 6
  lexical:
    min_score: 1.0
    normalize_arabic: true
    phrase_matching: true
  semantic_recall:
    enabled: true
    candidate_limit: 6
    max_catalog_tools: 100
    max_catalog_chars: 100000
```

Metrics distinguish `lexicalRetrievalMs`, `modelRecallMs`, `toolSelectionMs`, and `conversationMs`, plus call counts for recall, selection and conversation. Debug mode reports candidates, confidence, recall use, final selection and `conversation`/`no-match` outcome without prompts or chain-of-thought.

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

An optional deterministic `selection.match` can connect a user-owned preference extracted into tool input with a field returned by the API. A unique exact match is selected automatically; zero or multiple matches still require explicit selection. The model never supplies the server-owned selected ID.

```yaml
selection:
  items_path: $.slots
  id_path: $.slot_token
  label_path: $.start_at
  match:
    input_path: $.preferred_time
    item_path: $.start_time
```

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
