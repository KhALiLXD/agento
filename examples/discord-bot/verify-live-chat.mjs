// Opt-in provider evaluation with GET-only business transport. Never confirms a booking.
import assert from "node:assert/strict";
import { AgentRuntime } from "../../dist/index.js";
import { loadExampleConfig } from "../shared/config.mjs";

const config = await loadExampleConfig(
  new URL("./agent-config.yml", import.meta.url),
);
const calls = [];
const origins = new Set(
  config.tools.map((tool) => new URL(tool.request.url).origin),
);
const runtime = await AgentRuntime.create({
  config,
  presentation: "both",
  fetch: async (url, init) => {
    if (origins.has(new URL(url).origin)) {
      assert.equal(
        init?.method ?? "GET",
        "GET",
        "Live chat verifier prohibits business writes",
      );
      calls.push(new URL(url).pathname);
    }
    return fetch(url, init);
  },
});
const request = { sessionId: "live_chat_readonly" };
function record(turn, result) {
  console.log(
    JSON.stringify({
      turn,
      status: result.status,
      tool: result.tool?.id,
      message: result.message,
      preview: result.confirmation?.preview,
      error: result.error?.code,
      modelCalls: result.meta.modelCalls,
      httpCalls: result.meta.toolCalls,
    }),
  );
}
try {
  const greeting = await runtime.chat({ ...request, message: "مرحبا" });
  record("greeting", greeting);
  assert.equal(greeting.status, "completed");
  assert.equal(calls.length, 0, "Greeting must not execute a business API");
  const search = await runtime.chat({
    ...request,
    message: "ابحثي عن إزالة شعر الإبط",
  });
  record("search", search);
  assert.equal(search.status, "needs_selection");
  const details = await runtime.select({
    ...request,
    selectionId: search.selection.id,
    choice: search.selection.options[0].id,
  });
  record("details", details);
  const variants = await runtime.chat({
    ...request,
    message: "شو خيارات هاي الخدمة وأسعارها؟ مش حجز لسه",
  });
  record("variants", variants);
  assert.equal(variants.status, "completed");
  assert.equal(variants.tool?.id, "get-service-variants");
  assert.ok(
    !calls.includes("/api/availability"),
    "Variant browsing must not request a booking date",
  );
  const date =
    process.env.AGENTO_LIVE_DATE ??
    new Date(Date.now() + 86400000).toISOString().slice(0, 10);
  let booking = await runtime.chat({
    ...request,
    message: `بدي أحجز هاي الخدمة يوم ${date} والملاحظات: أفضّل الهدوء`,
  });
  record("booking-start", booking);
  assert.equal(booking.status, "needs_selection");
  const selectionId = booking.selection.id;
  const beforeQuestion = calls.length;
  const question = await runtime.chat({
    ...request,
    message: "كم سعر الخيار الثاني؟",
  });
  record("pending-price-question", question);
  assert.equal(
    question.selection?.id,
    selectionId,
    "Price question must preserve the pending selection",
  );
  assert.equal(
    calls.length,
    beforeQuestion,
    "Available option facts must answer without another API call",
  );
  booking = await runtime.chat({ ...request, message: "٢" });
  for (let step = 0; booking.status === "needs_selection" && step < 4; step++) {
    booking = await runtime.select({
      ...request,
      selectionId: booking.selection.id,
      choice: booking.selection.options[0].id,
    });
  }
  record("confirmation-not-submitted", booking);
  assert.equal(
    booking.status,
    "needs_confirmation",
    JSON.stringify(booking.error),
  );
  assert.equal(booking.confirmation.preview.notes, "أفضّل الهدوء");
  console.log(JSON.stringify({ verified: true, calls, writes: 0 }));
} finally {
  runtime.dispose();
}
