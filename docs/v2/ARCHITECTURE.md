# Architecture and decisions

## Baseline inspection

The implementation started from `action-feature` at `d4374bbefb642fc3c3807821dc00eefd5e97f7d4` and compared `main` at `1e3eb3058d1f5e369d512b5c9feea730dbada5b3`. These branches diverged from `66c54993ed2c3f83bd7a8c93a941b390c9aea94d`. Main's separate changes were an example/config update and small provider/redaction changes; no useful new core architecture was discarded.

The previous flow combined a first-match trigger detector with textual JSON classification, a second field-extraction pass, loose conversation state, implicit response selection and HTTP execution inside the agent. The new runtime does not use those routing or extraction classes.

Preserved work includes encrypted opaque-credential storage, credential redaction
and transport safety. The V2 runtime deliberately does not own JWT verification or
business identity binding; the downstream API and the host integration remain
responsible for those decisions.

## Boundaries

1. **Compilation:** YAML → strict Zod config validation → AJV draft-07 schema compilation → reference/mapping/cycle checks → frozen definitions. Registry internals use private maps, with no public mutators.
2. **Retrieval/routing:** reusable lexical index → top K metadata → native tool selection or schema-validated fallback → validate returned name and arguments.
3. **Orchestration:** explicit states, runtime-owned facts and a stack of dependency frames. Missing user fields are collected before dependency execution. Dependencies may execute only read-only tools.
4. **Execution:** explicit value sources → prepared request → confirmation for effects → opaque auth forwarding at the transport boundary → bounded HTTP → output schema validation.
5. **Presentation:** sanitized, projected API facts → optional text model → versioned result. Presentation cannot authorize execution.

Model metadata contains only `name`, `description`, and `inputSchema`. It omits URL, auth, headers, timeouts and mapping rules. Top-level dependency-owned fields are removed from the model's input properties; the execution schema still requires them.

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
