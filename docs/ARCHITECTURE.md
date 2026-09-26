# Architecture and decisions

## Baseline inspection

.
The previous flow combined a first-match trigger detector with textual JSON classification, a second field-extraction pass, loose conversation state, implicit response selection and HTTP execution inside the agent. The new runtime does not use those routing or extraction classes.

Preserved work includes encrypted opaque-credential storage, credential redaction
and transport safety. The V2 runtime deliberately does not own JWT verification or
business identity binding; the downstream API and the host integration remain
responsible for those decisions.

## Boundaries

1. **Compilation:** YAML → strict Zod config validation → AJV draft-07 schema compilation → reference/mapping/cycle checks → frozen definitions. Registry internals use private maps, with no public mutators.
2. **Retrieval/routing:** reusable lexical index → lightweight multilingual model recall only when confidence is weak → candidate fusion → native tool selection or schema-validated fallback → validate returned name and arguments.
3. **Orchestration:** explicit states, runtime-owned facts and a stack of dependency frames. Missing user fields are collected before dependency execution. Dependencies may execute only read-only tools.
4. **Execution:** explicit value sources → prepared request → confirmation for effects → opaque auth forwarding at the transport boundary → bounded HTTP → output schema validation.
5. **Conversation/presentation:** a valid no-tool route uses a credential-free conversational responder; tool results use sanitized, projected API facts. Neither path can authorize execution.

Model metadata contains only `name`, `description`, and `inputSchema`. It omits URL, auth, headers, timeouts and mapping rules. Top-level dependency-owned fields are removed from the model's input properties; the execution schema still requires them.

The compiler also caches a separate lightweight catalog containing only `id`, optional `title`, and `description`. Semantic recall sees this catalog and the sanitized current message, never endpoint configuration, schemas, session context, facts, API results or credentials. Returned IDs are intersected with the compiled registry before final routing. An empty recall is an intentional no-tool decision; provider failure is not.

Conversation is a runtime mode, not a fake tool. Ordinary chat follows `IDLE → ROUTING → COMPLETED`; a conversational detour while collecting input follows `GATHERING_INPUT → ROUTING → GATHERING_INPUT` and retains the frame and gathered arguments. Final execution, validation, dependencies, confirmation, authentication and HTTP mapping remain deterministic.

## Modules

```text
src/v2/
  config/           Zod schema, parser/compiler, safe paths, migration
  models/           capability contract and five wire-protocol adapters
  tools/            retrieval, routing and reusable routing evaluations
  execution/        explicit request value mapping
  http/             bounded transport, retries and circuit breaking
  runtime/          AgentRuntime and validated state transitions
  session/          facts, dependency frames, stores and atomic transactions
  security/         recursive and known-value redaction
  observability/    rate limits, hooks and metrics
  mcp/              protocol-independent tools/list + tools/call handlers
  errors.ts         typed error class and safe external boundaries
  index.ts          v2 public surface
```

The package root and `/v2` subpath expose the same `AgentRuntime` API. The old
`AgentHandler` runtime and verifier-based authentication path were removed so
there is one execution contract and one authentication boundary.

## Decisions and tradeoffs

- Zod validates configuration; AJV plus formats validates arbitrary tool JSON Schema. Two focused validators avoid hand-written partial JSON Schema enforcement. AJV validators are compiled once, not per message.
- Provider transports use native fetch rather than five SDK dependency trees. Conformance fixtures verify provider-specific wire formats. Explicit capabilities let deployments disable unsupported model features.
- Unknown arguments are rejected, not silently coerced. Missing values stay a runtime state, not invented defaults from the model. Declared JSON Schema defaults are applied by AJV.
- All non-GET/HEAD requests must declare side effects, and side effects require explicit confirmation. This intentionally treats read-only POST APIs conservatively in this release.
- Redirects are blocked for all tools. Configured origin and HTTP mapping remain deterministic. Private APIs and localhost are intentionally supported; the embedding service must enforce its network egress policy when accepting untrusted config.
- A session store must implement `transact` across the entire async operation. A plain Redis `get/set` pair is insufficient for multi-instance correctness. Memory storage demonstrates this contract within one process.
- Exactly-once business effects cannot be guaranteed across a network failure. Confirmation consumption prevents replay of the same approval; backend idempotency and reconciliation handle ambiguous delivery.
- Schema paths intentionally support a small dot-path subset, without scripts, wildcards or executable expressions. Full JSONPath can be added behind a separately reviewed mapping boundary.
