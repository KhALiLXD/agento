# AGENTO

**A schema-driven AI Agent Runtime for existing REST APIs.**

AGENTO connects natural-language AI agents to real REST APIs without handing execution policy to the model.

The model interprets user intent. AGENTO validates inputs, resolves dependencies, controls side effects, builds the HTTP request, manages session state, and executes within the contract you define. Your API remains responsible for authentication, authorization, and business rules.

> **Alpha:** AGENTO is under active development. The public API may still change before the first stable release.

**Documentation:** https://agento.khalil-ay.com  
**Source:** https://github.com/KhALiLXD/agento

---

## Why AGENTO?

A language model is useful for understanding what a user wants. It should not own your endpoints, credentials, request construction, application state, or permission to perform side effects.

Without a runtime, those responsibilities often collapse into prompts and model-generated requests.

With AGENTO:

```text
User
  ↓
AI Model
understands intent
  ↓
AGENTO
routes → validates → resolves → confirms → executes
  ↓
Your REST API
authenticates → authorizes → applies business rules
```

The probabilistic part stays at the edge. Safety- and correctness-critical execution stays deterministic.

---

## Install

AGENTO is a server-side ESM package for Node.js 20.11+.

```bash
npm install agento-runtime@alpha
```

Then import the public runtime:

```js
import { AgentRuntime } from "agento-runtime";
```

AGENTO is intended to run in trusted server-side Node.js environments, not directly in browser code.

---

## Quick start

### 1. Describe one API operation

```yaml
version: "2"

assistant:
  name: My Agent
  language: auto
  timezone: UTC

models:
  routing:
    provider: openai
    model: gpt-5.6-luna
    api_key: $ENV:OPENAI_API_KEY
    temperature: 0

tools:
  - id: search-services

    tool:
      description: Search available services by the user's search phrase.
      input_schema:
        type: object
        properties:
          query:
            type: string
            minLength: 1
        required: [query]

    request:
      method: GET
      url: https://api.example.com/services
      auth:
        type: none
      map:
        query:
          q: $.query
```

Here, the model-facing input is `query`, while the API still receives the parameter it actually expects:

```text
{ "query": "hair" }
        ↓
GET /services?q=hair
```

### 2. Create the Runtime

```js
import { AgentRuntime } from "agento-runtime";

const runtime = await AgentRuntime.create({
  configPath: "./config.yml",
  presentation: "raw",
});
```

Create the Runtime once when your server starts and reuse it for incoming requests.

### 3. Let AGENTO choose the Tool

```js
const result = await runtime.chat({
  sessionId: "user:123",
  message: "Find hair coloring services",
});

console.log(result);
```

When a routing model is configured, `chat()` handles natural-language Tool selection and extraction of declared user inputs.

If your application already knows exactly which Tool should run, use `invoke()` instead:

```js
const result = await runtime.invoke({
  sessionId: "user:123",
  tool: "search-services",
  arguments: {
    query: "hair coloring",
  },
});
```

---

## The execution model

AGENTO compiles one strict configuration into two different surfaces:

```text
config.yml
   │
   ├── Model-facing Tool definition
   │     name · description · input schema
   │
   └── Private execution registry
         URL · auth · mappings · dependencies · retry · effects
```

The model sees only what it needs for interpretation. Execution details remain under Runtime control.

A typical flow can look like:

```text
User intent
   ↓
Lexical Retrieval
   ↓
Semantic Recall when needed
   ↓
Validated Tool selection
   ↓
Input validation
   ↓
Dependency resolution
   ↓
Selection
   ↓
Confirmation
   ↓
Deterministic request mapping
   ↓
Bounded HTTP execution
   ↓
Your API
```

Not every message needs a Tool. With conversation enabled, AGENTO can handle safe conversational turns without pretending that an API operation was executed.

---

## Core capabilities

- **Hybrid Tool Routing** — lexical retrieval, semantic recall when needed, then bounded model selection.
- **Schema Validation** — declared inputs are validated before execution.
- **Deterministic Mapping** — values come from explicit sources rather than arbitrary model-generated requests.
- **Dependencies** — resolve trusted API-owned values before later operations use them.
- **Selection** — present server-backed choices without letting the model invent identifiers.
- **Confirmation** — side effects can wait for explicit user approval before execution.
- **Session State** — preserve conversation state, facts, references, and pending work.
- **Safe HTTP Execution** — bounded response sizes, timeouts, retry policies, redirect controls, and response validation.
- **Opaque Credential Transport** — user credentials can be forwarded to downstream APIs without making AGENTO the authorization authority.
- **Observability** — Runtime metrics and hooks expose routing and execution behavior.
- **MCP Adapter** — expose the same compiled capabilities through MCP.
- **Multilingual Conversation** — user messages can be multilingual while Tool metadata stays consistent.

---

## Authentication boundary

AGENTO does **not** replace your authentication system.

For a user-authenticated Tool:

```yaml
request:
  method: POST
  url: https://api.example.com/bookings
  auth:
    type: session
```

Your application supplies the current user's token at runtime:

```js
const result = await runtime.chat({
  sessionId: `user:${user.id}`,
  auth: {
    token: user.accessToken,
  },
  message: "Book tomorrow",
});
```

AGENTO forwards the credential to the configured downstream API. The API still decides whether the user is authenticated and authorized.

Keep these concepts separate:

```text
sessionId  → identifies AGENTO conversation/workflow state
auth.token → authenticates the caller with your API
```

---

## Human-in-the-loop effects

Read operations can execute directly when valid. Operations with side effects can require confirmation.

A Runtime result may be:

```text
completed
needs_input
needs_selection
needs_confirmation
error
```

For a write flow:

```text
resolve real API facts
   ↓
prepare operation
   ↓
return needs_confirmation
   ↓
user approves
   ↓
runtime.confirm(...)
   ↓
HTTP write
```

The host application renders the confirmation preview and decides when the user's approval is sufficient to continue.

---

## Runtime API

The main Runtime methods are:

```ts
AgentRuntime.create(...)
runtime.chat(...)
runtime.invoke(...)
runtime.select(...)
runtime.confirm(...)
runtime.cancel(...)
runtime.clearSession(...)
runtime.dispose()
```

Use `invoke()` when your server already knows the Tool. Use `chat()` when natural-language routing is part of the interaction.

For result handling, continuations, sessions, and state transitions, see the full Runtime guide.

---

## Documentation

The complete documentation lives at:

### https://agento.khalil-ay.com

Useful starting points:

- [Overview](https://agento.khalil-ay.com/docs/overview)
- [Installation](https://agento.khalil-ay.com/docs/installation)
- [Quick Start](https://agento.khalil-ay.com/docs/quick-start)
- [Configuration](https://agento.khalil-ay.com/docs/configuration)
- [Tools](https://agento.khalil-ay.com/docs/tools)
- [Mapping](https://agento.khalil-ay.com/docs/mapping)
- [Dependencies](https://agento.khalil-ay.com/docs/dependencies)
- [Routing](https://agento.khalil-ay.com/docs/routing)
- [Runtime Flow](https://agento.khalil-ay.com/docs/runtime-flow)
- [Authentication](https://agento.khalil-ay.com/docs/authentication)
- [Production](https://agento.khalil-ay.com/docs/production)
- [MCP](https://agento.khalil-ay.com/docs/mcp)
- [Troubleshooting](https://agento.khalil-ay.com/docs/troubleshooting)

Arabic documentation is also available from the language switcher on the documentation site.

---

## Contributing

AGENTO is open source and is intended to improve through real integrations, bug reports, discussions, and community contributions.

If you find a routing edge case, an API integration that the current config cannot express cleanly, a Runtime bug, or an area where the documentation can be clearer, contributions are welcome.

Before opening a large change, describe the problem and the expected Runtime behavior so the implementation can stay deterministic and broadly useful.

---

## Development

```bash
npm install
npm run build
npm test
npm run lint
```

Before packaging:

```bash
npm pack --dry-run
```

AGENTO is ESM-only and requires Node.js 20.11 or newer.

---

## License

AGENTO is licensed under the [Mozilla Public License 2.0](LICENSE).

The MPL-2.0 allows AGENTO to be used in larger applications while requiring modifications to MPL-covered files to remain available under the same license when distributed.

---

**The model interprets. AGENTO controls execution. Your API authorizes.**
