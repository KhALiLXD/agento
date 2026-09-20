import type { AgentResult } from "../../dist/index.js";
interface Prompt {
  owner: string;
  sessionId: string;
  result: AgentResult;
}
export class PromptRegistry {
  update(result: AgentResult): void;
  remember(messageId: string, owner: string, result: AgentResult): void;
  get(messageId: string): Prompt | undefined;
  resolve(
    messageId: string,
    owner: string,
    sessionId: string,
    action: string,
    id: string,
    consume?: boolean,
  ): Prompt | undefined;
  clear(sessionId: string): void;
}
