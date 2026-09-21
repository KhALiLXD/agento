import test from "node:test";
import assert from "node:assert/strict";
import {
  chunkMessage,
  detectLanguage,
  renderResultText,
} from "../../examples/discord-bot/renderers.mjs";

test("Discord message chunks preserve all content and Unicode", () => {
  assert.equal(chunkMessage("a".repeat(2000)).length, 1);
  assert.equal(chunkMessage("a".repeat(2001)).length, 2);
  const value = `${"x".repeat(1999)}🙂${"y".repeat(2001)}`;
  const chunks = chunkMessage(value);
  assert.equal(chunks.join(""), value);
  assert.ok(chunks.every((chunk) => [...chunk].length <= 2000));
  assert.ok(chunks.every((chunk) => !/[\ud800-\udbff]$/.test(chunk)));
  assert.ok(chunks.every((chunk) => !/^[\udc00-\udfff]/.test(chunk)));
});

test("Discord result renderer preserves runtime messages and complete previews", () => {
  assert.equal(
    renderResultText(
      { status: "needs_selection", message: "Choisissez" },
      "en",
    ),
    "Choisissez",
  );
  const confirmation = renderResultText(
    {
      status: "needs_confirmation",
      message: "راجعي الحجز",
      confirmation: { preview: { date: "2026-10-01", notes: "quiet" } },
    },
    "ar",
  );
  assert.match(confirmation, /راجعي الحجز/);
  assert.match(confirmation, /2026-10-01/);
  assert.match(confirmation, /quiet/);
  assert.equal(detectLanguage("٢", "ar"), "ar");
  assert.equal(detectLanguage("مرحبا", "en"), "ar");
});
