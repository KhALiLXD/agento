/** Bind displayed controls to their owner, session and exact current runtime result. */
export class PromptRegistry {
  #messages = new Map();
  #current = new Map();
  update(result) {
    this.clear(result.sessionId);
    if (["needs_selection", "needs_confirmation"].includes(result.status))
      this.#current.set(result.sessionId, {
        requestId: result.requestId,
        created: Date.now(),
      });
  }
  remember(messageId, owner, result) {
    this.#prune();
    if (this.#current.get(result.sessionId)?.requestId !== result.requestId)
      return;
    this.#messages.set(messageId, {
      owner,
      sessionId: result.sessionId,
      result,
    });
  }
  get(messageId) {
    this.#prune();
    return this.#messages.get(messageId);
  }
  resolve(messageId, owner, sessionId, action, id, consume = false) {
    const prompt = this.get(messageId);
    const expected =
      action === "confirm" || action === "cancel"
        ? prompt?.result.confirmation?.id
        : prompt?.result.selection?.id;
    if (
      !prompt ||
      prompt.owner !== owner ||
      prompt.sessionId !== sessionId ||
      expected !== id ||
      this.#current.get(sessionId)?.requestId !== prompt.result.requestId
    )
      return undefined;
    if (consume) this.clear(sessionId);
    return prompt;
  }
  clear(sessionId) {
    this.#current.delete(sessionId);
    for (const [id, prompt] of this.#messages)
      if (prompt.sessionId === sessionId) this.#messages.delete(id);
  }
  #prune() {
    for (const [id, state] of this.#current)
      if (Date.now() - state.created >= 30 * 60_000) this.clear(id);
    while (this.#current.size > 1000)
      this.clear(this.#current.keys().next().value);
  }
}
