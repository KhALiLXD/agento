import { fail } from "../errors.js";
export type RuntimeState =
  | "IDLE"
  | "ROUTING"
  | "RESOLVING_DEPENDENCIES"
  | "GATHERING_INPUT"
  | "AWAITING_SELECTION"
  | "AWAITING_CONFIRMATION"
  | "EXECUTING"
  | "PRESENTING_RESULT"
  | "COMPLETED"
  | "FAILED";
const transitions: Record<RuntimeState, readonly RuntimeState[]> = {
  IDLE: ["ROUTING", "RESOLVING_DEPENDENCIES"],
  ROUTING: [
    "RESOLVING_DEPENDENCIES",
    "GATHERING_INPUT",
    "AWAITING_SELECTION",
    "AWAITING_CONFIRMATION",
    "COMPLETED",
  ],
  RESOLVING_DEPENDENCIES: [
    "RESOLVING_DEPENDENCIES",
    "GATHERING_INPUT",
    "AWAITING_SELECTION",
    "AWAITING_CONFIRMATION",
    "EXECUTING",
  ],
  GATHERING_INPUT: ["ROUTING", "RESOLVING_DEPENDENCIES"],
  AWAITING_SELECTION: ["ROUTING", "RESOLVING_DEPENDENCIES"],
  AWAITING_CONFIRMATION: ["ROUTING", "RESOLVING_DEPENDENCIES", "EXECUTING"],
  EXECUTING: ["RESOLVING_DEPENDENCIES", "PRESENTING_RESULT"],
  PRESENTING_RESULT: ["COMPLETED", "AWAITING_SELECTION"],
  COMPLETED: ["IDLE"],
  FAILED: ["IDLE"],
};
export function transition(session: { state: RuntimeState }, to: RuntimeState) {
  if (
    to !== "FAILED" &&
    to !== "IDLE" &&
    !transitions[session.state].includes(to)
  )
    fail("INTERNAL_STATE_TRANSITION", "Invalid runtime state transition.", {
      from: session.state,
      to,
    });
  session.state = to;
}
