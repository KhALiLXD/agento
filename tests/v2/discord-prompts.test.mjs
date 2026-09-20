import test from "node:test";
import assert from "node:assert/strict";
import { PromptRegistry } from "../../examples/discord-bot/prompts.mjs";
const confirmation = (requestId = "request-a", id = "confirmation-a") => ({
  sessionId: "s",
  requestId,
  status: "needs_confirmation",
  confirmation: { id },
});
test("Discord approval controls bind the displayed action to its owner and session and consume once", () => {
  const prompts = new PromptRegistry(),
    result = confirmation();
  prompts.update(result);
  prompts.remember("m", "alice", result);
  assert.equal(
    prompts.resolve("m", "bob", "s", "confirm", "confirmation-a", true),
    undefined,
  );
  assert.equal(
    prompts.resolve(
      "m",
      "alice",
      "other-session",
      "confirm",
      "confirmation-a",
      true,
    ),
    undefined,
  );
  assert.equal(
    prompts.resolve("m", "alice", "s", "confirm", "different", true),
    undefined,
  );
  assert.ok(
    prompts.resolve("m", "alice", "s", "confirm", "confirmation-a", true),
  );
  assert.equal(
    prompts.resolve("m", "alice", "s", "confirm", "confirmation-a", true),
    undefined,
  );
});
test("old cancel/approval buttons and late replies cannot affect a newer operation", () => {
  const prompts = new PromptRegistry(),
    old = confirmation(),
    current = confirmation("request-b", "confirmation-b");
  prompts.update(old);
  prompts.remember("old-message", "alice", old);
  prompts.update(current);
  prompts.remember("new-message", "alice", current);
  prompts.remember("late-old-message", "alice", old);
  for (const message of ["old-message", "late-old-message"])
    assert.equal(
      prompts.resolve(message, "alice", "s", "cancel", "confirmation-a", true),
      undefined,
    );
  assert.ok(
    prompts.resolve("new-message", "alice", "s", "confirm", "confirmation-b"),
  );
  prompts.update({
    sessionId: "s",
    requestId: "complete",
    status: "completed",
  });
  assert.equal(
    prompts.resolve("new-message", "alice", "s", "confirm", "confirmation-b"),
    undefined,
  );
});
test("selection page changes retain the selection; an approval action cannot reuse its ID", () => {
  const prompts = new PromptRegistry(),
    result = {
      sessionId: "s",
      requestId: "r",
      status: "needs_selection",
      selection: { id: "pick" },
    };
  prompts.update(result);
  prompts.remember("m", "alice", result);
  assert.ok(prompts.resolve("m", "alice", "s", "page", "pick"));
  assert.equal(
    prompts.resolve("m", "alice", "s", "confirm", "pick", true),
    undefined,
  );
  assert.ok(prompts.resolve("m", "alice", "s", "select", "pick", true));
  assert.equal(
    prompts.resolve("m", "alice", "s", "select", "pick", true),
    undefined,
  );
});
