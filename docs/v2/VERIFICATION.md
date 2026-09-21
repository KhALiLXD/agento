# Verification and release boundary

## Verification commands

```sh
npm ci
npm run lint
npm test
npm run test:coverage  # recent Node, verified on Node 24
npm pack --dry-run
```

The V2 compiler, provider conformance, routing, HTTP, orchestration, migration/MCP and security/lifecycle suites run without contacting a user's business API. Tests exercise successful and failing boundaries rather than checking private implementation details. The published examples are separate live checks and require `AGENTO_API_BASE_URL` plus real credentials.

Covered scenarios include duplicate/bad config and schemas, required query input, defaults and encoding, high-confidence one-call routing, Arabic normalization, multi-word keywords, multilingual semantic recall against English-only metadata, conversational no-match, bounded history, pending-input conversational detours, malformed/provider recall failure, lightweight prompt isolation, opaque credential isolation and upstream 401/403 handling, nested redaction, dependency selection and caching, confirmation expiry/context binding/replay/cancellation, concurrent sessions, rate limits, HTTP methods, 204, retries, stable idempotency keys, redirects, malformed/large output, timeouts, circuit breaking, interrupted-operation markers and presentation failure after a successful side effect.

The YAML examples are compilation-tested. To exercise them against a real API, set `AGENTO_API_BASE_URL` and `AGENTO_USER_ACCESS_TOKEN`, and `OPENAI_API_KEY`, then run the catalog or booking command. `-- --direct` does not require a model key. The Discord salon config is exercised with controlled HTTP fixtures in tests; the examples themselves use only the configured real API. Routing evaluations are reusable through `evaluateRouting`; they report selection accuracy, no-match rate, false positives on negative cases, argument accuracy, schema failures, tokens, model calls and latency. Evaluation does not execute business APIs. `evals/v2/routing.json` contains 34 English/Arabic positive and negative fixtures; `AGENTO_MODEL=<model-id> AGENTO_API_KEY=<key> node examples/v2/evaluate.mjs` runs them against a real provider (billable). No live accuracy score is claimed; expected lexical arguments may need provider-specific semantic scoring.

## Scope against the engineering prompt

| Milestone             | Implemented deliverables                                                                                                                   |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| Foundation            | Strong config/types, compiled schemas, immutable registries, dependency graph, typed errors, tests                                         |
| Models                | Five capability-aware protocol adapters, native tools, structured/validated fallback, conformance fixtures                                 |
| Routing               | Scored top-K retrieval, selected-tool validation, unified arguments, missing-input continuation, evaluations                               |
| Execution             | Explicit mapping, HTTP transport, dependency chains, facts, selection, opaque session-token forwarding, confirmed actions                  |
| Production mechanisms | Store transaction contract, TTLs, serialization, rate limits, safe retries, idempotency, circuit breaker, hooks/metrics and security tests |
| Compatibility         | Review-required legacy migration, MCP handler foundation, public API, examples and documentation                                           |

## Known limits and next priorities

1. The release is alpha. Run live provider contract/evaluation tests and an independent security review before labeling a deployment production-ready. Deterministic conformance cannot establish semantic routing quality or live protocol support.
2. Memory sessions, rate limits and circuit breakers are local. Supply distributed session transactions, encrypted opaque-token storage and rate limiting for horizontal scale. No Redis/DB implementation is shipped.
3. HTTP idempotency requires backend support. A timeout or crash can leave an ambiguous business outcome. Confirmation replay protection is not an exactly-once delivery guarantee.
4. MCP transport/CLI packaging is prepared, not shipped as a standalone server. Lightweight model recall is bounded to small catalogs; embedding retrieval remains an extension point for large deployments. Legacy implicit business flows need manual mapping review.
5. Streaming model output, parallel tool execution, provider-specific advanced schema translation, automatic provider retries and arbitrary JSONPath expressions are not implemented. Multiple native tool calls are rejected.
6. Config is trusted application code. Apply ingress/egress controls and size/complexity limits if accepting configs from third parties. AI prose is not an authoritative rendering of API facts.

Prioritize live provider evaluation fixtures, a distributed store reference implementation with fault-injection tests, then an official-SDK MCP transport. The eleven-tool salon config has been migrated; its response selection paths must match the host API. These extend the implemented core without changing its tool or execution contracts.
