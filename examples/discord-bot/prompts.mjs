/** Bind displayed controls to their owner, session and exact current runtime result. */
export class PromptRegistry {
  #messages = new Map();
  #current = new Map();
  #now;
  constructor(options = {}) {
    this.#now = options.now ?? Date.now;
  }
  update(result, language = "en") {
    const token = result.selection?.id ?? result.confirmation?.id;
    const current = this.#current.get(result.sessionId);
    if (token && current?.token === token) return;
    this.#current.delete(result.sessionId);
    if (["needs_selection", "needs_confirmation"].includes(result.status))
      this.#current.set(result.sessionId, {
        requestId: result.requestId,
        token,
        expiresAt:
          result.confirmation?.expiresAt ??
          result.selection?.expiresAt ??
          this.#now() + 30 * 60_000,
        language,
      });
  }
  remember(messageId, owner, result, language = "en") {
    this.#prune();
    if (!result.selection && !result.confirmation) return;
    this.#messages.set(messageId, {
      owner,
      sessionId: result.sessionId,
      result,
      language,
      created: this.#now(),
    });
  }
  get(messageId) {
    this.#prune();
    return this.#messages.get(messageId);
  }
  resolve(messageId, owner, sessionId, action, id, consume = false) {
    const prompt = this.get(messageId);
    if (!prompt || prompt.owner !== owner || prompt.sessionId !== sessionId)
      return undefined;
    const selectionAction = action === "select" || action === "page";
    const confirmationAction = action === "confirm" || action === "cancel";
    if (!selectionAction && !confirmationAction) return undefined;
    const expected = confirmationAction
      ? prompt?.result.confirmation?.id
      : prompt?.result.selection?.id;
    if (
      expected !== id ||
      this.#current.get(sessionId)?.token !==
        (prompt.result.selection?.id ?? prompt.result.confirmation?.id) ||
      this.#current.get(sessionId)?.expiresAt <= this.#now()
    )
      return undefined;
    if (consume) this.#current.delete(sessionId);
    return prompt;
  }
  resolveReply(messageId, owner, sessionId) {
    const prompt = this.get(messageId);
    if (!prompt) return { state: "ordinary" };
    if (prompt.owner !== owner || prompt.sessionId !== sessionId)
      return { state: "forbidden" };
    return this.#current.get(sessionId)?.token ===
      (prompt.result.selection?.id ?? prompt.result.confirmation?.id)
      ? { state: "current", prompt }
      : { state: "stale", prompt };
  }
  clear(sessionId) {
    this.#current.delete(sessionId);
  }
  #prune() {
    for (const [id, state] of this.#current)
      if (state.expiresAt <= this.#now()) this.#current.delete(id);
    for (const [id, prompt] of this.#messages)
      if (this.#now() - prompt.created >= 60 * 60_000)
        this.#messages.delete(id);
    while (this.#current.size > 1000)
      this.clear(this.#current.keys().next().value);
    while (this.#messages.size > 5000)
      this.#messages.delete(this.#messages.keys().next().value);
  }
}
