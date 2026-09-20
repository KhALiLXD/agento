# AGENTO V2 developer guide

## Local workflow

```sh
npm ci
npm run build
npm test
npm run lint
npm run test:coverage
npm pack --dry-run
```

`npm test` runs the V2 compiler, model, routing, execution, session, security and compatibility suites. Unit tests use controlled adapters only to exercise deterministic runtime boundaries; the user-facing examples call the real API and provider configured through environment variables.

## Source boundaries

- `src/v2/config`: strict YAML/Zod/AJV compilation and explicit mapping validation.
- `src/v2/models`: native provider protocols and capability-aware routing.
- `src/v2/tools`: retrieval, routing and evaluation.
- `src/v2/execution`: deterministic input-to-request mapping.
- `src/v2/http`: bounded fetch, retries, idempotency, redirects and upstream error mapping.
- `src/v2/runtime`: session orchestration, dependencies, selection and confirmation.
- `src/v2/session`: transactional session state and facts.
- `src/v2/security`: recursive redaction and credential minimization.
- `src/auth`: encrypted storage for opaque session credentials only; there is no token verifier.

The package root and `/v2` subpath expose the same V2 API. There is no V1 runtime or local JWT/JWKS verification path.

## Adding a tool

1. Define a unique `id`, user-facing description and object `input_schema`.
2. Map every request field explicitly under `request.map`.
3. Choose `request.auth.type` (`none`, `session` or `api-key`).
4. Mark non-read-only methods as side effects and require confirmation.
5. Add dependency/selection paths when one API result supplies another tool's input.
6. Add an output schema when the host needs a stable contract.
7. Compile the config and run the V2 suite before connecting a live API.

## Live provider/API checks

The examples expect real credentials:

```sh
export AGENTO_API_BASE_URL=https://api.your-service.example
export AGENTO_USER_ACCESS_TOKEN=real-user-access-token
export OPENAI_API_KEY=your-model-api-key
npm run demo:catalog
npm run demo:booking
```

For model-routed examples also set `OPENAI_API_KEY`. Never commit these values. Use a server-side login integration to obtain per-user tokens; do not collect them from chat or Discord messages.

## Release checks

Before shipping, run the full deterministic suite, then manually exercise the travel and Discord examples against a staging API. Verify upstream `401`/`403`, token redaction, confirmation replay rejection, idempotency behavior and ambiguous side-effect reconciliation with the API owner.
