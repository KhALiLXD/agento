import type { AgentResult } from "../../dist/index.js";
export type DiscordLanguage = "ar" | "en";
export function detectLanguage(
  text: string,
  previous?: DiscordLanguage,
): DiscordLanguage;
export function messagesFor(language: DiscordLanguage): Record<string, string>;
export function renderResultText(
  result: AgentResult,
  language?: DiscordLanguage,
): string;
export function chunkMessage(text: string, limit?: number): string[];
