# Provider behavior and conformance

Capabilities are properties of the configured provider/model deployment. Defaults below describe the implemented adapter path, not a promise that every model offered by that provider supports it. Override `models.routing.capabilities` or implement `ModelAdapter` when a deployment differs.

| Provider  | Native tools                  | Structured routing fallback                      | Strict native tool schema by default | System instruction placement |
| --------- | ----------------------------- | ------------------------------------------------ | ------------------------------------ | ---------------------------- |
| OpenAI    | Chat Completions `tools`      | `response_format: json_schema`                   | Yes                                  | System message               |
| Anthropic | Messages `tools/input_schema` | Disabled conservatively; validated JSON fallback | No                                   | Top-level `system`           |
| Mistral   | Chat `tools`                  | `response_format: json_schema`                   | No                                   | System message               |
| Cohere    | v2 Chat `tools`               | `response_format: json_object` + `schema`        | No; `strict_tools` opt-in            | System message               |
| Ollama    | `/api/chat` `tools`           | `format` JSON Schema                             | No                                   | System message               |

OpenAI strict tool schemas encode unknown input values as nullable so the runtime can gather missing values instead of forcing invented arguments. Returned nulls are omitted for non-nullable input properties, then runtime validation determines missing values. Original application schemas remain authoritative. Provider JSON Schema subsets may reject advanced keywords accepted by AJV; configure `strictSchema: false` or use a supported schema subset for that deployment.

Native tools take precedence. Without native tools, structured output is used when declared; otherwise whole JSON (optionally one fenced JSON block) is parsed and validated with bounded retries. Prose scraping and greedy JSON regex extraction are not used. Model calls cannot select a tool outside the candidate set. Multiple simultaneous tool calls fail explicitly rather than executing unreviewed operations.

Routing uses temperature zero where supported. Model settings can disable temperature; common OpenAI reasoning model prefixes default to omission. Ollama places temperature in `options`. Presentation has separate model settings. Anthropic structured output support is deliberately not advertised by this conservative adapter; newer capabilities can be added with conformance fixtures rather than inferred from a provider name.

Conformance tests use representative wire responses and verify system placement, tool/argument parsing, token usage, error redaction, structured fallback and failure bounds. They do **not** establish live accuracy or availability for arbitrary provider/model versions. No paid provider API calls were made during implementation.

## Official protocol references

- [OpenAI function calling](https://developers.openai.com/api/docs/guides/function-calling)
- [OpenAI structured outputs](https://developers.openai.com/api/docs/guides/structured-outputs)
- [Anthropic tool use](https://platform.claude.com/docs/en/agents-and-tools/tool-use/overview)
- [Mistral function calling](https://docs.mistral.ai/capabilities/function_calling/)
- [Mistral structured output](https://docs.mistral.ai/capabilities/structured_output/custom/)
- [Cohere v2 Chat](https://docs.cohere.com/v2/reference/chat)
- [Ollama Chat](https://docs.ollama.com/api/chat)

Provider protocols evolve. Pin model IDs where stability matters and run the routing evaluation fixtures against your exact deployment before release.
