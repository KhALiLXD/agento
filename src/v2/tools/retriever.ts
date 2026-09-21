import type { CompiledAgent } from "../config/compiler.js";
export interface ToolCandidate {
  tool: string;
  score: number;
  source?: "lexical" | "model-recall" | "hybrid" | "pending";
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
export function normalizeForRetrieval(
  value: string,
  options: { unicode?: boolean; arabic?: boolean } = {},
): string {
  let normalized = options.unicode === false ? value : value.normalize("NFKC");
  if (options.arabic !== false)
    normalized = normalized
      .replace(/[\u064B-\u065F\u0670]/g, "")
      .replace(/\u0640/g, "")
      .replace(/[أإآٱ]/g, "ا");
  return normalized.toLocaleLowerCase();
}
const tokenize = (
  s: string,
  options?: { unicode?: boolean; arabic?: boolean },
) => normalizeForRetrieval(s, options).match(/[\p{L}\p{N}]+/gu) ?? [];
export class LexicalToolRetriever implements ToolRetriever {
  #index: Array<{
    id: string;
    words: Set<string>;
    text: string;
    hints: string[];
    keywords: Record<string, number>;
  }>;
  constructor(private compiled: CompiledAgent) {
    const policy = compiled.policies.routing.lexical,
      options = {
        unicode: policy.normalize_unicode,
        arabic: policy.normalize_arabic,
      };
    this.#index = compiled.policies.tools.map((t) => ({
      id: t.id,
      words: new Set(
        tokenize(
          [t.id, t.tool.title, t.tool.description].filter(Boolean).join(" "),
          options,
        ),
      ),
      text: tokenize(
        [t.id, t.tool.title, t.tool.description].filter(Boolean).join(" "),
        options,
      ).join(" "),
      hints: t.trigger_hints.map((h) => tokenize(h, options).join(" ")),
      keywords: Object.fromEntries(
        Object.entries(t.keywords).map(([keyword, weight]) => [
          tokenize(keyword, options).join(" "),
          weight,
        ]),
      ),
    }));
  }
  async retrieve(
    message: string,
    context: RetrievalContext,
  ): Promise<ToolCandidate[]> {
    const policy = this.compiled.policies.routing.lexical;
    if (!policy.enabled) return [];
    const options = {
        unicode: policy.normalize_unicode,
        arabic: policy.normalize_arabic,
      },
      words = new Set(tokenize(message, options)),
      normalized = [...tokenize(message, options)].join(" ");
    return this.#index
      .map((t) => {
        let score = 0;
        for (const w of words)
          if (t.words.has(w)) score += 1 / Math.sqrt(t.words.size);
        if (
          words.size > 1 &&
          (" " + t.text + " ").includes(" " + normalized + " ")
        )
          score += 1;
        for (const hint of policy.phrase_matching ? t.hints : [])
          if (normalized === hint) score += 10;
          else if ((" " + normalized + " ").includes(" " + hint + " "))
            score += 3;
        for (const [keyword, weight] of Object.entries(t.keywords))
          if (
            keyword &&
            (words.has(keyword) ||
              (policy.phrase_matching &&
                (" " + normalized + " ").includes(" " + keyword + " ")))
          )
            score += weight;
        if (context.pendingTool === t.id) score += 5;
        if (context.dependencyTools?.includes(t.id)) score += 2;
        return { tool: t.id, score, source: "lexical" as const };
      })
      .filter((c) => c.score > 0)
      .sort((a, b) => b.score - a.score || a.tool.localeCompare(b.tool))
      .slice(0, context.limit);
  }
}
