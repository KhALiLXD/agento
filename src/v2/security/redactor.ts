// Match credential names, not innocent names such as monkey, keyboard, or token_count.
export function sensitiveKey(key: string): boolean {
  const normalized = key.replace(/([a-z])([A-Z])/g, "$1_$2").toLowerCase();
  return (
    /^(?:authorization|bearer|cookie|set_cookie|session|credential|credentials|password|secret|token|api_key)$/.test(
      normalized.replace(/-/g, "_"),
    ) ||
    /(?:^|[_-])(?:password|secret|credential|credentials)$/.test(normalized) ||
    /^(?:access|refresh|id|auth|session)[_-]?token$/.test(normalized) ||
    /^(?:x[_-]?)?api[_-]?key$/.test(normalized)
  );
}
export function redact<T>(value: T, secrets: readonly string[] = []): T {
  const seen = new WeakSet<object>();
  const walk = (input: unknown): unknown => {
    if (typeof input === "string") {
      let s = input
        .replace(
          /\b(password|access[_-]?token|refresh[_-]?token|api[_-]?key|secret)\s*[:=]\s*[^\s,;]+/gi,
          "$1=[REDACTED]",
        )
        .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [REDACTED]");
      for (const secret of secrets)
        if (secret) s = s.split(secret).join("[REDACTED]");
      return s;
    }
    if (!input || typeof input !== "object") return input;
    if (seen.has(input)) return "[Circular]";
    seen.add(input);
    const result = Array.isArray(input)
      ? input.map(walk)
      : Object.fromEntries(
          Object.entries(input).map(([k, v]) => [
            walk(k),
            sensitiveKey(k) ? "[REDACTED]" : walk(v),
          ]),
        );
    seen.delete(input);
    return result;
  };
  return walk(value) as T;
}
