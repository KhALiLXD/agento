# Travel agent — V2

This interactive CLI uses the real model and API you configure. Build the library from the repository root, then install the runner:

```powershell
npm ci
npm run build
npm ci --prefix examples/travel-agent
$env:AGENTO_API_BASE_URL = "https://your-travel-api.example"
$env:OPENAI_API_KEY = "your-model-key"
$env:AGENTO_USER_ACCESS_TOKEN = "your-user-access-token"
npm run example:travel
```

The YAML declares `/v1/flights/search`, `/v1/bookings/flights` and `/v1/bookings/me`. Match those paths, input/body fields and responses to your API. The booking endpoint is expected to use the user's API account for payment; no fake payment token is generated. The example never signs or verifies a user token.

The console supports `/tools`, `/invoke tool-id {"field":"value"}`, `/cancel`, `/reset` and `/exit`. Send natural language to exercise real model routing. Review a booking and type `CONFIRM` before it executes. `USER_ACCESS_TOKEN` is also accepted for compatibility with the previous runner.

For manual API invocation without model calls, use:

```powershell
npm run example:console -- --config examples/travel-agent/agent-config.yml --direct
```

For local HTTP set `AGENTO_ALLOW_INSECURE_HTTP=true`. Leave it unset for HTTPS. Tokens are forwarded only to tools with `request.auth.type: session`.
