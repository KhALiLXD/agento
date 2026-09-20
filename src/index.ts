/**
 * AGENTO's public API is V2. User credentials are opaque transport values;
 * downstream APIs own authentication and authorization decisions.
 */
export {
  AgentRuntime as default,
  AgentRuntime,
} from "./v2/runtime/agent-runtime.js";
export * from "./v2/index.js";
