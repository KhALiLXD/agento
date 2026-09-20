import type { JsonSchema } from "../config/schema.js";
import type { ToolDefinition } from "../config/compiler.js";
export interface ModelCapabilities {
  nativeTools: boolean;
  structuredOutput: boolean;
  strictSchema: boolean;
  systemMessages: boolean;
  temperature: boolean;
}
export interface ModelMessage {
  role: "user" | "assistant";
  content: string;
}
export interface GenerationRequest {
  system: string;
  messages: readonly ModelMessage[];
  temperature?: number;
  signal?: AbortSignal;
}
export interface Usage {
  inputTokens: number;
  outputTokens: number;
}
export interface TextGenerationResult {
  text: string;
  usage: Usage;
}
export interface StructuredGenerationResult {
  data: unknown;
  usage: Usage;
}
export interface ToolSelectionRequest extends GenerationRequest {
  tools: readonly ToolDefinition[];
}
export interface ToolCall {
  name: string;
  arguments: Record<string, unknown>;
}
export interface ToolSelectionResult {
  call: ToolCall | null;
  usage: Usage;
}
export interface ModelAdapter {
  capabilities(): ModelCapabilities;
  generateText(request: GenerationRequest): Promise<TextGenerationResult>;
  generateStructured(
    request: GenerationRequest & { schema: JsonSchema },
  ): Promise<StructuredGenerationResult>;
  selectTool(request: ToolSelectionRequest): Promise<ToolSelectionResult>;
}
