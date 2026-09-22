const strings = {
  ar: {
    completed: "تمت العملية.",
    select: "اختاري من القائمة.",
    confirm: "راجعي الملخص ثم أكدي الطلب.",
    input: "أحتاج معلومة إضافية.",
    auth401: "رفض الـ API تسجيل الدخول. حدّثي جلسة المستخدم وأعيدي المحاولة.",
    auth403: "رفض الـ API العملية لعدم توفر الصلاحية.",
    error: "تعذّر إكمال الطلب. حاولي مجددًا دون إعادة تأكيد الطلب القديم.",
    stale: "انتهت صلاحية هذا الطلب. استخدمي أحدث قائمة أو ابدئي طلبًا جديدًا.",
  },
  en: {
    completed: "The operation completed.",
    select: "Choose an option from the list.",
    confirm: "Review the summary, then confirm the request.",
    input: "More information is required.",
    auth401:
      "The API rejected authentication. Refresh the user session and try again.",
    auth403: "The API rejected the operation because permission is missing.",
    error:
      "The request could not be completed. Try again without reusing the old confirmation.",
    stale:
      "This request has expired. Use the latest prompt or start a new request.",
  },
};

export function detectLanguage(text, previous = "en") {
  if (/(?=\p{L})\p{Script=Arabic}/u.test(text)) return "ar";
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
    if (/STALE|EXPIRED/.test(result.error?.code ?? "")) return copy.stale;
    return copy.error;
  }
  if (result.status === "needs_confirmation") {
    const preview = result.confirmation?.preview ?? {};
    const labels =
      language === "ar"
        ? {
            service: "الخدمة",
            variant: "الخيار",
            date: "التاريخ",
            appointment_time: "الموعد",
            selected_time: "الموعد المتاح",
            time: "الوقت",
            price: "السعر",
            amount: "المبلغ",
            currency: "العملة",
            employee: "الموظفة",
            notes: "الملاحظات",
          }
        : {
            service: "Service",
            variant: "Option",
            date: "Date",
            appointment_time: "Appointment",
            selected_time: "Available time",
            time: "Time",
            price: "Price",
            amount: "Amount",
            currency: "Currency",
            employee: "Employee",
            notes: "Notes",
          };
    const lines = Object.entries(preview)
      .filter(
        ([key, value]) =>
          !/token|secret|password|authorization|_id$/i.test(key) &&
          ["string", "number", "boolean"].includes(typeof value),
      )
      .map(
        ([key, value]) =>
          `${labels[key] ?? key.replaceAll("_", " ")}: ${value}`,
      );
    return [
      result.message?.startsWith("Review and confirm") ? "" : result.message,
      ...lines,
      copy.confirm,
    ]
      .filter(Boolean)
      .join("\n");
  }
  if (result.status === "needs_selection") return result.message || copy.select;
  if (result.status === "needs_input") {
    const field = result.missing?.[0]?.split("/").at(-1);
    const questions =
      language === "ar"
        ? {
            date: "أي يوم بتحبي يكون الموعد؟",
            notes: "شو الملاحظات اللي بتحبي نضيفها؟",
            q: "أي خدمة بتحبي تبحثي عنها؟",
            preferred_time: "أي ساعة بتناسبك؟",
          }
        : {
            date: "Which date would you like?",
            notes: "What notes would you like to add?",
            q: "Which service would you like to find?",
            preferred_time: "What time would suit you?",
          };
    return (
      questions[field] ??
      (result.message?.startsWith("Please provide:")
        ? copy.input
        : result.message || copy.input)
    );
  }
  if (result.message) return result.message;
  if (result.data !== undefined) return JSON.stringify(result.data, null, 2);
  return copy.completed;
}

export function chunkMessage(text, limit = 2000) {
  if (!Number.isInteger(limit) || limit < 2)
    throw new RangeError("Invalid chunk limit.");
  const source = text || " ";
  const chunks = [];
  let remaining = source;
  while (remaining.length > limit) {
    let boundary = limit;
    if (/[\uD800-\uDBFF]/.test(remaining[boundary - 1])) boundary--;
    const window = remaining.slice(0, boundary);
    const newline = window.lastIndexOf("\n");
    const space = window.lastIndexOf(" ");
    const split = Math.max(newline, space);
    const take = split > Math.floor(limit / 2) ? split + 1 : boundary;
    chunks.push(remaining.slice(0, take));
    remaining = remaining.slice(take);
  }
  if (remaining) chunks.push(remaining);
  return chunks;
}
