import type { CompiledAgent } from "../config/compiler.js";
export interface ToolCandidate {
  tool: string;
  score: number;
}
export interface RetrievalContext {
  limit: number;
  pendingTool?: string;
  dependencyTools?: readonly string[];
}
export interface ToolRetriever {
  retrieve(
    message: string,
    context: RetrievalContext,
  ): Promise<readonly ToolCandidate[]>;
}
const tokenize = (s: string) =>
  s
    .toLocaleLowerCase()
    .normalize("NFKC")
    .match(/[\p{L}\p{N}]+/gu) ?? [];
export class LexicalToolRetriever implements ToolRetriever {
  #index: Array<{
    id: string;
    words: Set<string>;
    hints: string[];
    keywords: Record<string, number>;
  }>;
  constructor(compiled: CompiledAgent) {
    this.#index = compiled.policies.tools.map((t) => ({
      id: t.id,
      words: new Set(tokenize(t.id + " " + t.tool.description)),
      hints: t.trigger_hints.map((h) => tokenize(h).join(" ")),
      keywords: t.keywords,
    }));
  }
  async retrieve(
    message: string,
    context: RetrievalContext,
  ): Promise<ToolCandidate[]> {
    const words = new Set(tokenize(message)),
      normalized = [...tokenize(message)].join(" ");
    return this.#index
      .map((t) => {
        let score = 0;
        for (const w of words)
          if (t.words.has(w)) score += 1 / Math.sqrt(t.words.size);
        for (const hint of t.hints)
          if (normalized === hint) score += 10;
          else if ((" " + normalized + " ").includes(" " + hint + " "))
            score += 3;
        for (const [keyword, weight] of Object.entries(t.keywords))
          if (words.has(keyword.toLowerCase())) score += weight;
        if (context.pendingTool === t.id) score += 5;
        if (context.dependencyTools?.includes(t.id)) score += 2;
        return { tool: t.id, score };
      })
      .filter((c) => c.score > 0)
      .sort((a, b) => b.score - a.score || a.tool.localeCompare(b.tool))
      .slice(0, context.limit);
  }
}
