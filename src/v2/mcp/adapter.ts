import type {
  AgentRuntime,
  BaseRequest,
  ConfirmationRequest,
  SelectionRequest,
} from "../runtime/agent-runtime.js";
/** Protocol-independent MCP tools/list + tools/call foundation.
 * Mount these handlers in the official SDK; transport authentication resolves BaseRequest.
 * Session and credential data MUST NOT come from model tool arguments. */
export function createMcpAdapter(
  runtime: AgentRuntime,
  resolveContext: () => Promise<BaseRequest>,
) {
  return {
    async listTools() {
      const config = runtime.getConfig() as {
        tools: Array<{
          id: string;
          behavior: { effect: string };
          request: { idempotency?: unknown; retry: { idempotent: boolean } };
        }>;
      };
      return {
        tools: runtime.listTools().map((t) => {
          const policy = config.tools.find((x) => x.id === t.name)!;
          return {
            ...t,
            annotations: {
              readOnlyHint: policy.behavior.effect === "read-only",
              destructiveHint: policy.behavior.effect === "destructive",
              idempotentHint:
                policy.behavior.effect === "read-only" ||
                !!policy.request.idempotency ||
                policy.request.retry.idempotent,
              openWorldHint: true,
            },
            outputSchema: {
              type: "object",
              properties: {
                version: { const: "2" },
                status: { type: "string" },
              },
              required: ["version", "status"],
            },
          };
        }),
      };
    },
    async callTool(request: {
      name: string;
      arguments?: Record<string, unknown>;
    }) {
      const context = await resolveContext();
      const result = await runtime.invoke({
        ...context,
        tool: request.name,
        arguments: request.arguments,
        presentation: "raw",
      });
      return {
        isError: result.status === "error",
        content: [{ type: "text" as const, text: JSON.stringify(result) }],
        structuredContent: result,
      };
    },
    // Host-controlled continuations: never expose confirmation as a model-callable tool.
    async confirm(confirmationId: string) {
      const context = await resolveContext();
      return runtime.confirm({
        ...context,
        confirmationId,
      } satisfies ConfirmationRequest);
    },
    async select(selectionId: string, choice: string) {
      const context = await resolveContext();
      return runtime.select({
        ...context,
        selectionId,
        choice,
      } satisfies SelectionRequest);
    },
  };
}
