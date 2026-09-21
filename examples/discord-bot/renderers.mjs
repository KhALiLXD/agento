const strings = {
  ar: {
    completed: "تمت العملية.",
    select: "اختاري من القائمة.",
    confirm: "راجعي الملخص ثم أكدي الطلب.",
    input: "أحتاج معلومة إضافية.",
    auth401: "رفض الـ API تسجيل الدخول. حدّثي جلسة المستخدم وأعيدي المحاولة.",
    auth403: "رفض الـ API العملية لعدم توفر الصلاحية.",
  },
  en: {
    completed: "The operation completed.",
    select: "Choose an option from the list.",
    confirm: "Review the summary, then confirm the request.",
    input: "More information is required.",
    auth401:
      "The API rejected authentication. Refresh the user session and try again.",
    auth403: "The API rejected the operation because permission is missing.",
  },
};

export function detectLanguage(text, previous = "en") {
  if (/\p{Script=Arabic}/u.test(text)) return "ar";
  if (/\p{Script=Latin}/u.test(text)) return "en";
  return previous;
}

export function messagesFor(language) {
  return strings[language] ?? strings.en;
}

export function renderResultText(result, language = "en") {
  const copy = messagesFor(language);
  if (result.status === "error") {
    if (result.error?.code === "AUTH_REJECTED")
      return result.error.details?.status === 403 ? copy.auth403 : copy.auth401;
    return (
      [result.error?.code, result.error?.message].filter(Boolean).join(": ") ||
      "Error"
    );
  }
  if (result.status === "needs_confirmation") {
    const preview = result.confirmation?.preview ?? {};
    return [
      result.message || copy.confirm,
      Object.keys(preview).length ? JSON.stringify(preview, null, 2) : "",
    ]
      .filter(Boolean)
      .join("\n");
  }
  if (result.status === "needs_selection") return result.message || copy.select;
  if (result.status === "needs_input") return result.message || copy.input;
  if (result.message) return result.message;
  if (result.data !== undefined) return JSON.stringify(result.data, null, 2);
  return copy.completed;
}

export function chunkMessage(text, limit = 2000) {
  if (!Number.isInteger(limit) || limit < 1)
    throw new RangeError("Invalid chunk limit.");
  const source = text || " ";
  const chunks = [];
  let remaining = source;
  while ([...remaining].length > limit) {
    const codepoints = [...remaining];
    const window = codepoints.slice(0, limit).join("");
    const newline = window.lastIndexOf("\n");
    const space = window.lastIndexOf(" ");
    const split = Math.max(newline, space);
    const take =
      split > Math.floor(limit / 2)
        ? [...window.slice(0, split + 1)].length
        : limit;
    chunks.push(codepoints.slice(0, take).join(""));
    remaining = codepoints.slice(take).join("");
  }
  if (remaining) chunks.push(remaining);
  return chunks;
}
