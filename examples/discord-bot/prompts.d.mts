import type { AgentResult } from "../../dist/index.js";
interface Prompt {
  owner: string;
  sessionId: string;
  result: AgentResult;
  language: "ar" | "en";
}
export class PromptRegistry {
  constructor(options?: { now?: () => number });
  update(result: AgentResult, language?: "ar" | "en"): void;
  remember(
    messageId: string,
    owner: string,
    result: AgentResult,
    language?: "ar" | "en",
  ): void;
  get(messageId: string): Prompt | undefined;
  resolve(
    messageId: string,
    owner: string,
    sessionId: string,
    action: string,
    id: string,
    consume?: boolean,
  ): Prompt | undefined;
  resolveReply(
    messageId: string,
    owner: string,
    sessionId: string,
  ):
    | { state: "ordinary" }
    | { state: "forbidden" }
    | { state: "current" | "stale"; prompt: Prompt };
  clear(sessionId: string): void;
}
