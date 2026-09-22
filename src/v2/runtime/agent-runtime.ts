import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { SessionCredentials } from "../../auth/manager.js";
import type { AuthenticationOptions } from "../../auth/types.js";
import {
  compileConfig,
  type CompiledAgent,
  type ToolDefinition,
} from "../config/compiler.js";
import { readPath, writePath, digest } from "../config/paths.js";
import type { ToolConfig } from "../config/schema.js";
import { AgentRuntimeError, boundaryError, fail } from "../errors.js";
import { mapValues, prepareRequest } from "../execution/mapper.js";
import { HttpExecutor } from "../http/executor.js";
import type { ModelAdapter, Usage } from "../models/interface.js";
import { ProviderModel } from "../models/providers.js";
import {
  ConversationResponder,
  assistantSystemPrompt,
} from "../conversation/responder.js";
import {
  MemoryRateLimiter,
  type RateLimiter,
  type RuntimeHook,
  type RuntimeMetrics,
} from "../observability/policies.js";
import { redact } from "../security/redactor.js";
import {
  MemorySessionStore,
  type SessionStore,
  type SessionStateV2,
  type Frame,
  type SelectionState,
} from "../session/store.js";
import {
  LexicalToolRetriever,
  type ToolRetriever,
} from "../tools/retriever.js";
import { ToolRouter } from "../tools/router.js";
import { transition, type RuntimeState } from "./state.js";
export type RuntimeAuthenticationOptions = AuthenticationOptions;
export interface RuntimeOptions {
  config?: unknown;
  configYml?: string;
  configPath?: string;
  model?: ModelAdapter;
  presentationModel?: ModelAdapter;
  sessionStore?: SessionStore;
  rateLimiter?: RateLimiter;
  retriever?: ToolRetriever;
  /**
   * Opaque credential transport for user-authenticated API tools. V2 does not
   * verify JWTs or decide business permissions; the downstream API does that.
   */
  authentication?: RuntimeAuthenticationOptions;
  fetch?: typeof fetch;
  env?: NodeJS.ProcessEnv;
  onEvent?: RuntimeHook;
  presentation?: "raw" | "ai" | "both";
  debug?: boolean;
  now?: () => Date;
}
export interface BaseRequest {
  sessionId: string;
  auth?: { token: string };
  context?: Record<string, unknown>;
  signal?: AbortSignal;
  presentation?: "raw" | "ai" | "both";
}
export interface InvokeRequestV2 extends BaseRequest {
  tool: string;
  arguments?: Record<string, unknown>;
}
export interface ChatRequestV2 extends BaseRequest {
  message: string;
}
export interface SelectionRequest extends BaseRequest {
  selectionId: string;
  choice: string;
}
export interface ConfirmationRequest extends BaseRequest {
  confirmationId: string;
}
export interface AgentResult {
  version: "2";
  requestId: string;
  sessionId: string;
  status:
    | "completed"
    | "needs_input"
    | "needs_selection"
    | "needs_confirmation"
    | "error";
  message?: string;
  tool?: { id: string; arguments?: Record<string, unknown> };
  data?: unknown;
  missing?: string[];
  selection?: {
    id: string;
    expiresAt: number;
    options: Array<{ id: string; label: string }>;
  };
  confirmation?: {
    id: string;
    expiresAt: number;
    preview: Record<string, unknown>;
  };
  error?: ReturnType<AgentRuntimeError["toJSON"]>;
  meta: RuntimeMetrics;
  debug?: Record<string, unknown>;
}
interface Turn {
  request: BaseRequest;
  id: string;
  session: SessionStateV2;
  metrics: RuntimeMetrics;
  secrets: string[];
  token?: string;
  debug: Record<string, unknown>;
  preservePendingOnError?: RuntimeState;
}
type Outcome = Omit<
  AgentResult,
  "version" | "requestId" | "sessionId" | "meta"
>;
export class AgentRuntime {
  #compiled: CompiledAgent;
  #store: SessionStore;
  #auth: SessionCredentials;
  #limiter: RateLimiter;
  #router: ToolRouter;
  #http: HttpExecutor;
  #model?: ModelAdapter;
  #presentation?: ModelAdapter;
  #conversation?: ConversationResponder;
  #hook?: RuntimeHook;
  #defaultPresentation: "raw" | "ai" | "both";
  #debug: boolean;
  #secrets: string[];
  #now: () => Date;
  #disposed = false;
  private constructor(compiled: CompiledAgent, options: RuntimeOptions) {
    this.#compiled = compiled;
    this.#store =
      options.sessionStore ??
      new MemorySessionStore(compiled.policies.session.max_sessions);
    this.#auth = new SessionCredentials(
      options.authentication ?? {},
      compiled.policies.session.ttl_ms,
    );
    this.#limiter = options.rateLimiter ?? new MemoryRateLimiter();
    this.#router = new ToolRouter(
      compiled,
      options.retriever ?? new LexicalToolRetriever(compiled),
    );
    const env = options.env ?? process.env,
      keys: Record<string, string> = {};
    this.#secrets = [];
    for (const t of compiled.policies.tools)
      if (t.request.auth.type === "api-key") {
        keys[t.request.auth.env] = env[t.request.auth.env] ?? "";
        this.#secrets.push(keys[t.request.auth.env]);
      }
    for (const m of Object.values(compiled.policies.models ?? {}))
      if (m?.api_key) this.#secrets.push(env[m.api_key.slice(5)] ?? "");
    this.#http = new HttpExecutor({ fetch: options.fetch, keys });
    this.#model =
      options.model ??
      (compiled.policies.models
        ? new ProviderModel(compiled.policies.models.routing, {
            fetch: options.fetch,
            env,
          })
        : undefined);
    this.#presentation =
      options.presentationModel ??
      (compiled.policies.models?.presentation
        ? new ProviderModel(compiled.policies.models.presentation, {
            fetch: options.fetch,
            env,
          })
        : this.#model);
    const conversationModel = compiled.policies.assistant.conversation
      .use_presentation_model
      ? this.#presentation
      : this.#model;
    if (conversationModel)
      this.#conversation = new ConversationResponder(
        compiled,
        conversationModel,
      );
    this.#hook = options.onEvent;
    this.#defaultPresentation = options.presentation ?? "raw";
    this.#debug = options.debug ?? false;
    this.#now = options.now ?? (() => new Date());
  }
  static async create(options: RuntimeOptions): Promise<AgentRuntime> {
    if (
      [options.config, options.configYml, options.configPath].filter(
        (x) => x !== undefined,
      ).length !== 1
    )
      fail(
        "CONFIG_INVALID",
        "Provide exactly one of config, configYml, or configPath.",
      );
    let input = options.config ?? options.configYml;
    if (options.configPath) {
      try {
        input = await readFile(options.configPath, "utf8");
      } catch {
        fail("CONFIG_INVALID", "Configuration file could not be read.");
      }
    }
    return new AgentRuntime(compileConfig(input, options.env), options);
  }
  listTools(): readonly ToolDefinition[] {
    return this.#compiled.tools.values();
  }
  getConfig(): unknown {
    return redact(structuredClone(this.#compiled.policies), this.#secrets);
  }
  diagnostics() {
    return { circuits: this.#http.diagnostics() };
  }
  dispose() {
    this.#disposed = true;
    this.#auth.dispose();
  }
  async clearSession(sessionId: string) {
    await this.#store.transact(sessionId, async () => {
      await this.#auth.clear(sessionId);
      await this.#store.delete(sessionId);
    });
  }
  invoke(request: InvokeRequestV2): Promise<AgentResult> {
    return this.#turn(request, async (t) => {
      this.#compiled.executions.get(request.tool);
      this.#reset(t.session);
      t.session.stack = [this.#frame(request.tool, request.arguments ?? {}, t)];
      transition(t.session, "RESOLVING_DEPENDENCIES");
      return this.#drive(t);
    });
  }
  chat(request: ChatRequestV2): Promise<AgentResult> {
    return this.#turn(request, async (t) => {
      if (
        typeof request.message !== "string" ||
        !request.message.trim() ||
        request.message.length > 20000
      )
        fail("INPUT_INVALID", "Message must contain 1–20000 characters.");
      const s = t.session,
        message = redact(request.message, t.secrets);
      if (/\p{L}/u.test(message)) s.lastUserMessage = message;
      s.history.push({ role: "user", content: message });
      this.#trim(s);
      if (/^\s*(?:cancel|إلغاء|الغاء)\s*$/i.test(message)) {
        this.#reset(s);
        delete s.references;
        return { status: "completed", message: "Cancelled." };
      }
      const waitingState = s.state;
      if (
        waitingState === "AWAITING_CONFIRMATION" &&
        /^\s*(?:yes|confirm|نعم|أكد|اكدي|تأكيد)\s*$/i.test(message)
      )
        return this.#confirmationResult(t);
      if (s.state === "AWAITING_SELECTION" && s.selection) {
        if (
          s.selection.expiresAt <= Date.now() ||
          s.selection.contextHash !== this.#selectionContextHash(t)
        )
          fail("INPUT_SELECTION_STALE", "Selection is absent or expired.");
        const chosen = this.#chatSelection(s.selection, message);
        if (chosen.kind === "matched")
          return this.#select(t, s.selection.token, chosen.id);
        if (chosen.kind === "ambiguous")
          return this.#selectionResult(
            s.selection,
            "More than one option has that name. Choose its displayed number.",
          );
      }
      if (!this.#model)
        fail(
          "MODEL_NOT_CONFIGURED",
          "chat requires a configured ModelAdapter.",
        );
      const pending =
        s.state === "GATHERING_INPUT" ? s.stack[s.stack.length - 1] : undefined;
      const activeFrame = s.stack[0];
      const waiting =
        waitingState === "AWAITING_SELECTION" ||
        waitingState === "AWAITING_CONFIRMATION"
          ? waitingState
          : undefined;
      t.preservePendingOnError = pending ? "GATHERING_INPUT" : waiting;
      if (!pending && !waiting) this.#reset(s);
      transition(s, "ROUTING");
      const start = Date.now();
      this.#emit(t, "onRoutingStarted", {});
      const routed = await this.#router.route(
        message,
        redact(
          s.history.length
            ? s.history
            : [{ role: "user" as const, content: message }],
          t.secrets,
        ),
        this.#model,
        {
          pendingTool: pending?.tool ?? activeFrame?.tool,
          signal: request.signal,
          secrets: t.secrets,
          onCall: () => this.#modelCall(t),
          onUsage: (u) => this.#usage(t, u),
          onCandidates: (c) => {
            const routing = (t.debug.routing ??= {}) as Record<string, unknown>;
            routing.candidates = c;
            this.#emit(t, "onCandidatesSelected", { candidates: c });
          },
          onLexical: (candidates, durationMs, confident) => {
            t.metrics.lexicalRetrievalMs += durationMs;
            const routing = (t.debug.routing ??= {}) as Record<string, unknown>;
            routing.lexical = { candidates, confident, durationMs };
            this.#emit(t, "onLexicalRetrievalFinished", {
              candidates,
              confident,
              durationMs,
            });
          },
          onModelRecallStart: () => {
            t.metrics.modelRecallCalls++;
            this.#emit(t, "onModelRecallStarted", {});
          },
          onModelRecall: (used, candidates, durationMs) => {
            t.metrics.modelRecallMs += durationMs;
            const routing = (t.debug.routing ??= {}) as Record<string, unknown>;
            routing.modelRecall = { used, candidates, durationMs };
            this.#emit(t, "onModelRecallFinished", {
              used,
              candidates,
              durationMs,
            });
          },
          onToolSelectionStart: () => {
            t.metrics.toolSelectionCalls++;
          },
          onToolSelection: (selected, durationMs) => {
            t.metrics.toolSelectionMs += durationMs;
            const routing = (t.debug.routing ??= {}) as Record<string, unknown>;
            routing.toolSelection = { selected, durationMs };
          },
          now: this.#now(),
          timezone: this.#compiled.policies.assistant.timezone,
        },
      );
      t.metrics.routingMs += Date.now() - start;
      if (!routed.call) {
        const routing = (t.debug.routing ??= {}) as Record<string, unknown>;
        if (
          (pending || waiting) &&
          !this.#compiled.policies.assistant.conversation.enabled
        ) {
          transition(s, waiting ?? "GATHERING_INPUT");
          routing.outcome = "pending-input";
          if (pending) return this.#missingInputResult(pending);
          return waiting === "AWAITING_SELECTION" && s.selection
            ? this.#selectionResult(s.selection)
            : this.#confirmationResult(t);
        }
        if (this.#compiled.policies.assistant.conversation.enabled) {
          if (!this.#conversation)
            fail(
              "MODEL_NOT_CONFIGURED",
              "Conversation requires a configured ModelAdapter.",
            );
          const conversationStarted = Date.now();
          t.metrics.conversationCalls++;
          this.#emit(t, "onConversationStarted", {
            pendingTool: pending?.tool,
          });
          let response: string;
          try {
            response = await this.#conversation.respond({
              messages: redact(
                s.history.length
                  ? s.history
                  : [{ role: "user" as const, content: message }],
                t.secrets,
              ),
              pendingTool:
                pending?.tool ??
                s.selection?.navigation?.tool ??
                s.selection?.dependency ??
                s.stack[s.stack.length - 1]?.tool,
              pendingFacts: s.selection?.facts ?? s.confirmation?.preview,
              signal: request.signal,
              secrets: t.secrets,
              onCall: () => this.#modelCall(t),
              onUsage: (usage) => this.#usage(t, usage),
            });
          } finally {
            const durationMs = Date.now() - conversationStarted;
            t.metrics.conversationMs += durationMs;
            this.#emit(t, "onConversationFinished", { durationMs });
          }
          routing.outcome = "conversation";
          transition(s, waiting ?? (pending ? "GATHERING_INPUT" : "COMPLETED"));
          t.preservePendingOnError = undefined;
          if (waiting === "AWAITING_SELECTION" && s.selection)
            return this.#selectionResult(s.selection, response);
          if (waiting === "AWAITING_CONFIRMATION")
            return {
              ...this.#confirmationResult(t),
              message: response,
            };
          return { status: "completed", message: response };
        }
        transition(s, "COMPLETED");
        routing.outcome = "no-match";
        return {
          status: "error",
          error: new AgentRuntimeError(
            "ROUTING_NO_MATCH",
            "No matching tool was selected.",
          ).toJSON(),
        };
      }
      this.#emit(t, "onToolSelected", { tool: routed.call.name });
      t.preservePendingOnError = undefined;
      if (
        (pending && routed.call.name === pending.tool) ||
        (activeFrame && routed.call.name === activeFrame.tool)
      ) {
        const frame =
          pending?.tool === routed.call.name ? pending : activeFrame!;
        const changed = Object.entries(routed.call.arguments).some(
          ([key, value]) => digest(value) !== digest(frame.arguments[key]),
        );
        if (changed) {
          for (const dependency of this.#compiled.executions.get(frame.tool)
            .config.depends_on)
            for (const path of Object.keys(dependency.map)) {
              const parts = path.slice(2).split(".");
              let object = frame.arguments;
              for (const part of parts.slice(0, -1))
                object = (object?.[part] ?? {}) as Record<string, unknown>;
              delete object[parts.at(-1)!];
            }
          frame.dependencies = {};
          delete frame.selectionFacts;
          delete frame.selectionExpiresAt;
          s.facts = {};
        }
        frame.arguments = { ...frame.arguments, ...routed.call.arguments };
        if (frame !== activeFrame) {
          const parent = s.stack[s.stack.length - 2];
          const link = this.#compiled.executions
            .get(parent.tool)
            .config.depends_on.find((dep) => dep.tool === frame.tool);
          for (const [key, source] of Object.entries(link?.arguments ?? {})) {
            const path =
              typeof source === "string"
                ? source
                : source.source === "tool-input"
                  ? source.path
                  : undefined;
            if (
              path &&
              path !== "$" &&
              Object.hasOwn(routed.call.arguments, key)
            )
              writePath(parent.arguments, path, routed.call.arguments[key]);
          }
        } else s.stack = [frame];
        delete s.selection;
        delete s.confirmation;
      } else {
        if (pending || waiting) this.#reset(s);
        s.stack = [this.#frame(routed.call.name, routed.call.arguments, t)];
      }
      transition(s, "RESOLVING_DEPENDENCIES");
      return this.#drive(t);
    });
  }
  select(request: SelectionRequest) {
    return this.#turn(request, (t) =>
      this.#select(t, request.selectionId, request.choice),
    );
  }
  confirm(request: ConfirmationRequest) {
    return this.#turn(request, async (t) => {
      const s = t.session,
        c = s.confirmation,
        f = s.stack[s.stack.length - 1];
      if (
        s.state !== "AWAITING_CONFIRMATION" ||
        !c ||
        !f ||
        c.token !== request.confirmationId ||
        c.expiresAt <= Date.now() ||
        c.hash !== this.#confirmationHash(t, c.prepared, c.preview)
      )
        fail(
          "CONFIRMATION_STALE",
          "Confirmation is absent, expired, or no longer matches the action.",
        );
      if (Object.values(f.dependencies).some((d) => d.expiresAt <= Date.now()))
        fail(
          "CONFIRMATION_STALE",
          "Dependency data expired. Invoke the tool again.",
        );
      // Persist consumption before HTTP. A crash leaves EXECUTING, which is never replayed automatically.
      delete s.confirmation;
      transition(s, "EXECUTING");
      await this.#store.set(s.id, s);
      return this.#execute(t, f, c.prepared);
    });
  }
  cancel(request: BaseRequest) {
    return this.#turn(request, async (t) => {
      this.#reset(t.session);
      delete t.session.references;
      return { status: "completed", message: "Cancelled." };
    });
  }
  #frame(tool: string, args: Record<string, unknown>, t: Turn): Frame {
    const execution = this.#compiled.executions.get(tool),
      input = structuredClone(args);
    let selectionFacts: Record<string, unknown> | undefined;
    let selectionExpiresAt: number | undefined;
    if (execution.config.references?.consume) {
      for (const [inputName, refName] of Object.entries(
        execution.config.references.consume,
      )) {
        const ref = t.session.references?.[refName];
        if (
          input[inputName] === undefined &&
          ref &&
          ref.expiresAt > Date.now() &&
          ref.contextHash === this.#selectionContextHash(t)
        ) {
          input[inputName] = structuredClone(ref.value);
          selectionFacts = { ...selectionFacts, ...ref.facts };
          selectionExpiresAt = Math.min(
            selectionExpiresAt ?? Infinity,
            ref.expiresAt,
          );
        }
      }
    }
    if (!execution.validatePartial(input))
      fail(
        "INPUT_SCHEMA_VIOLATION",
        "Tool arguments violate the input schema.",
      );
    return {
      tool,
      arguments: input,
      dependencies: {},
      selectionFacts,
      selectionExpiresAt,
    };
  }
  #displayData(t: Turn, value: unknown): unknown {
    const privateFields = new Set(
      this.#compiled.policies.tools.flatMap(
        (tool) => tool.response.private_fields,
      ),
    );
    const secrets = [...t.secrets];
    const collect = (item: unknown): void => {
      if (!item || typeof item !== "object") return;
      for (const [key, child] of Object.entries(item)) {
        if (privateFields.has(key) && typeof child === "string" && child)
          secrets.push(child);
        else collect(child);
      }
    };
    collect(value);
    collect(t.session.selection?.items);
    collect(t.session.stack);
    const strip = (item: unknown): unknown => {
      if (Array.isArray(item)) return item.map(strip);
      if (item && typeof item === "object")
        return Object.fromEntries(
          Object.entries(item)
            .filter(([key]) => !privateFields.has(key))
            .map(([key, child]) => [key, strip(child)]),
        );
      return item;
    };
    return redact(strip(value), secrets);
  }
  #reset(s: SessionStateV2) {
    transition(s, "IDLE");
    s.stack = [];
    delete s.selection;
    delete s.confirmation;
  }
  #trim(s: SessionStateV2) {
    const n = this.#compiled.policies.session.max_history_messages;
    s.history = n ? s.history.slice(-n) : [];
  }
  #missingInputResult(frame: Frame): Outcome {
    const validate = this.#compiled.executions.get(frame.tool).validateInput;
    validate(frame.arguments);
    const missing = (validate.errors ?? [])
      .filter((error) => error.keyword === "required")
      .map(
        (error) =>
          error.instancePath + "/" + String(error.params.missingProperty),
      );
    return {
      status: "needs_input",
      tool: { id: frame.tool },
      missing,
      message: "Please provide: " + missing.join(", "),
    };
  }
  #emit(t: Turn, name: string, details: Record<string, unknown>) {
    try {
      this.#hook?.({
        name,
        requestId: t.id,
        sessionId: t.session.id,
        at: Date.now(),
        details: redact(details, t.secrets),
      });
    } catch {
      /* Instrumentation must not turn a successful side effect into a failed call. */
    }
  }
  async #limit(t: Turn, kind: "ai_calls" | "tool_calls" | "messages") {
    const policy = this.#compiled.policies.rate_limits;
    await this.#limiter.consume(
      kind + ":" + t.session.id,
      policy[kind],
      policy.window_ms,
    );
  }
  async #modelCall(t: Turn) {
    await this.#limit(t, "ai_calls");
    t.metrics.modelCalls++;
    this.#emit(t, "onModelCall", { call: t.metrics.modelCalls });
  }
  #usage(t: Turn, u: Usage) {
    t.metrics.inputTokens += u.inputTokens;
    t.metrics.outputTokens += u.outputTokens;
  }
  #confirmationHash(
    t: Turn,
    prepared: ReturnType<typeof prepareRequest>,
    preview?: Record<string, unknown>,
  ) {
    const f = t.session.stack[t.session.stack.length - 1];
    return digest({
      prepared,
      session: t.session.id,
      config: this.#compiled.hash,
      tool: f?.tool,
      args: f?.arguments,
      dependencies: f?.dependencies,
      context: t.session.context,
      preview,
    });
  }
  async #turn(
    request: BaseRequest,
    operation: (turn: Turn) => Promise<Outcome>,
  ): Promise<AgentResult> {
    const started = Date.now(),
      id = randomUUID(),
      metrics: RuntimeMetrics = {
        modelCalls: 0,
        toolCalls: 0,
        inputTokens: 0,
        outputTokens: 0,
        durationMs: 0,
        retryCount: 0,
        dependencySteps: 0,
        routingMs: 0,
        lexicalRetrievalMs: 0,
        modelRecallMs: 0,
        toolSelectionMs: 0,
        conversationMs: 0,
        modelRecallCalls: 0,
        toolSelectionCalls: 0,
        conversationCalls: 0,
        httpMs: 0,
      };
    const fallback = (error: unknown): AgentResult => ({
      version: "2",
      requestId: id,
      sessionId: typeof request.sessionId === "string" ? request.sessionId : "",
      status: "error",
      error: boundaryError(error, "SESSION_STORE_FAILED").toJSON(),
      meta: { ...metrics, durationMs: Date.now() - started },
    });
    if (this.#disposed)
      return fallback(
        new AgentRuntimeError(
          "SESSION_RUNTIME_DISPOSED",
          "Runtime has been disposed.",
        ),
      );
    if (
      typeof request.sessionId !== "string" ||
      !/^[A-Za-z0-9_-]{1,200}$/.test(request.sessionId)
    )
      return fallback(
        new AgentRuntimeError("SESSION_ID_INVALID", "Invalid session ID."),
      );
    try {
      return await this.#store.transact(request.sessionId, async () => {
        let s = await this.#store.get(request.sessionId);
        const now = Date.now();
        if (s && (s.expiresAt <= now || s.configHash !== this.#compiled.hash)) {
          await this.#auth.clear(s.id);
          await this.#store.delete(s.id);
          return fallback(
            new AgentRuntimeError(
              "SESSION_EXPIRED",
              "Session expired or configuration changed. Start a fresh turn.",
            ),
          );
        }
        if (s?.state === "EXECUTING") {
          return fallback(
            new AgentRuntimeError(
              "TOOL_EXECUTION_UNCERTAIN",
              "A previous operation was interrupted during execution. Reconcile it with the backend before clearing the session.",
            ),
          );
        }
        s ??= {
          id: request.sessionId,
          expiresAt: now + this.#compiled.policies.session.ttl_ms,
          state: "IDLE",
          messageCount: 0,
          history: [],
          facts: {},
          stack: [],
          context: {},
          configHash: this.#compiled.hash,
        };
        const t: Turn = {
          request,
          id,
          session: s,
          metrics,
          secrets: [
            ...this.#secrets,
            ...(request.auth?.token ? [request.auth.token] : []),
          ],
          debug: {},
        };
        let outcome: Outcome;
        try {
          if (request.signal?.aborted)
            fail("INPUT_ABORTED", "Request was cancelled.");
          if (
            s.messageCount >=
            this.#compiled.policies.rate_limits.messages_per_session
          )
            fail("RATE_SESSION_LIMIT", "Session message limit exceeded.");
          await this.#limit(t, "messages");
          s.messageCount++;
          t.token = await this.#auth.resolve(
            s.id,
            request.auth?.token,
            Date.now() + this.#compiled.policies.session.ttl_ms,
          );
          if (t.token) t.secrets.push(t.token);
          if (request.context)
            s.context = redact(structuredClone(request.context), t.secrets);
          for (const [key, fact] of Object.entries(s.facts))
            if (fact.expiresAt !== undefined && fact.expiresAt <= now)
              delete s.facts[key];
          outcome = await operation(t);
        } catch (error) {
          let e = boundaryError(error);
          if (
            !(error instanceof AgentRuntimeError) &&
            error &&
            typeof error === "object" &&
            "code" in error &&
            typeof error.code === "string" &&
            error.code.startsWith("AUTH_")
          )
            e = new AgentRuntimeError(error.code, "Authentication failed.");
          const active = s.stack[s.stack.length - 1];
          if (
            metrics.toolCalls > 0 &&
            active &&
            this.#compiled.executions.get(active.tool).config.behavior
              .effect !== "read-only"
          )
            e = new AgentRuntimeError(e.code, e.message, {
              ...e.details,
              executionMayHaveOccurred: true,
            });
          if (
            (e.code === "CONFIRMATION_STALE" &&
              s.confirmation &&
              s.confirmation.expiresAt > Date.now() &&
              s.confirmation.hash ===
                this.#confirmationHash(
                  t,
                  s.confirmation.prepared,
                  s.confirmation.preview,
                )) ||
            (e.code === "INPUT_SELECTION_STALE" &&
              s.selection &&
              s.selection.expiresAt > Date.now() &&
              s.selection.contextHash === this.#selectionContextHash(t))
          ) {
            // A stale token must not cancel a newer valid operation.
          } else if (t.preservePendingOnError) {
            if (s.state !== t.preservePendingOnError)
              transition(s, t.preservePendingOnError);
          } else {
            transition(s, "FAILED");
            s.stack = [];
            delete s.selection;
            delete s.confirmation;
          }
          this.#emit(t, "onError", e.toJSON());
          outcome = { status: "error", error: e.toJSON() };
        }
        if (outcome.message)
          s.history.push({
            role: "assistant",
            content: redact(outcome.message, t.secrets),
          });
        this.#trim(s);
        s.expiresAt = Date.now() + this.#compiled.policies.session.ttl_ms;
        await this.#store.set(s.id, s);
        metrics.durationMs = Date.now() - started;
        return redact(
          {
            version: "2" as const,
            requestId: id,
            sessionId: s.id,
            ...outcome,
            meta: metrics,
            ...(this.#debug ? { debug: t.debug } : {}),
          },
          t.secrets,
        );
      });
    } catch (error) {
      return fallback(error);
    }
  }
  #dependencyArgs(
    t: Turn,
    parent: Frame,
    dep: ToolConfig["depends_on"][number],
  ) {
    return mapValues(dep.arguments, {
      input: parent.arguments,
      session: t.session.context,
      dependencies: Object.fromEntries(
        Object.entries(parent.dependencies).map(([k, v]) => [k, v.data]),
      ),
    });
  }
  async #drive(t: Turn): Promise<Outcome> {
    const s = t.session;
    while (s.stack.length) {
      if (
        ++t.metrics.dependencySteps > this.#compiled.policies.session.max_steps
      )
        fail("DEPENDENCY_LIMIT", "Dependency step limit exceeded.");
      const frame = s.stack[s.stack.length - 1],
        execution = this.#compiled.executions.get(frame.tool),
        tool = execution.config;
      // Ask for user-owned inputs before executing dependencies; dependency-owned inputs are resolved below.
      if (!execution.validateInput(frame.arguments)) {
        const errors = execution.validateInput.errors ?? [];
        if (errors.some((e) => e.keyword !== "required"))
          fail("INPUT_SCHEMA_VIOLATION", "Tool arguments violate the schema.");
        const produced = new Set(
          tool.depends_on.flatMap((d) =>
            Object.keys(d.map).map(
              (p) => "/" + p.slice(2).replaceAll(".", "/"),
            ),
          ),
        );
        const missing = errors
          .map((e) => e.instancePath + "/" + String(e.params.missingProperty))
          .filter((p) => !produced.has(p));
        if (missing.length) {
          transition(s, "GATHERING_INPUT");
          this.#emit(t, "onMissingInput", { tool: frame.tool, missing });
          return {
            status: "needs_input",
            tool: { id: frame.tool },
            missing,
            message: "Please provide: " + missing.join(", "),
          };
        }
      }
      let pushed = false;
      for (const dep of tool.depends_on) {
        // Host/navigation inputs can satisfy an explicit missing-only dependency.
        // Once resolved here, its TTL still governs the cached fact.
        if (
          dep.when === "missing" &&
          !frame.dependencies[dep.tool] &&
          Object.keys(dep.map).every(
            (path) => readPath(frame.arguments, path) !== undefined,
          )
        )
          continue;
        const args = this.#dependencyArgs(t, frame, dep),
          hash = this.#dependencyHash(t, frame, dep);
        let cached = frame.dependencies[dep.tool];
        const fact = s.facts[frame.tool + ":dependency:" + dep.tool];
        if (
          !cached &&
          fact &&
          fact.expiresAt !== undefined &&
          fact.expiresAt > Date.now() &&
          fact.sourceToolId === dep.tool
        ) {
          const value = fact.value as Frame["dependencies"][string];
          if (value.hash === hash) {
            this.#applyDependency(t, frame, dep, value.data, fact.expiresAt);
            cached = frame.dependencies[dep.tool];
          }
        }
        if (cached && cached.expiresAt > Date.now() && cached.hash === hash)
          continue;
        delete frame.dependencies[dep.tool];
        this.#emit(t, "onDependencyStarted", {
          tool: frame.tool,
          dependency: dep.tool,
        });
        s.stack.push(this.#frame(dep.tool, args, t));
        pushed = true;
        break;
      }
      if (pushed) continue;
      if (!execution.validateInput(frame.arguments)) {
        const errors = execution.validateInput.errors ?? [],
          missing = errors
            .filter((e) => e.keyword === "required")
            .map(
              (e) => e.instancePath + "/" + String(e.params.missingProperty),
            );
        if (errors.some((e) => e.keyword !== "required"))
          fail("INPUT_SCHEMA_VIOLATION", "Tool arguments violate the schema.");
        transition(s, "GATHERING_INPUT");
        this.#emit(t, "onMissingInput", { tool: frame.tool, missing });
        return {
          status: "needs_input",
          tool: { id: frame.tool },
          missing,
          message: "Please provide: " + missing.join(", "),
        };
      }
      const prepared = prepareRequest(tool, {
        input: frame.arguments,
        session: s.context,
        dependencies: Object.fromEntries(
          Object.entries(frame.dependencies).map(([k, v]) => [k, v.data]),
        ),
      });
      if (tool.behavior.confirmation.required) {
        const configuredPreview = mapValues(
          tool.behavior.confirmation.preview,
          {
            input: frame.arguments,
            session: s.context,
            dependencies: Object.fromEntries(
              Object.entries(frame.dependencies).map(([key, value]) => [
                key,
                value.data,
              ]),
            ),
            selection: frame.selectionFacts,
          },
        );
        const preview = redact(
          Object.keys(tool.behavior.confirmation.preview).length
            ? configuredPreview
            : Object.fromEntries(
                Object.entries(frame.arguments).filter(([key]) =>
                  Object.hasOwn(
                    this.#compiled.tools.get(frame.tool).inputSchema
                      .properties ?? {},
                    key,
                  ),
                ),
              ),
          t.secrets,
        );
        transition(s, "AWAITING_CONFIRMATION");
        s.confirmation = {
          token: randomUUID(),
          hash: this.#confirmationHash(t, prepared, preview),
          prepared,
          preview,
          expiresAt: Math.min(
            Date.now() + tool.behavior.confirmation.ttl_ms,
            frame.selectionExpiresAt ?? Infinity,
            ...Object.values(frame.dependencies).map((d) => d.expiresAt),
          ),
        };
        this.#emit(t, "onConfirmationRequested", { tool: frame.tool });
        return this.#confirmationResult(t);
      }
      transition(s, "EXECUTING");
      return this.#execute(t, frame, prepared);
    }
    return fail("INTERNAL_EMPTY_EXECUTION", "No pending tool.");
  }
  #confirmationResult(t: Turn): Outcome {
    const c = t.session.confirmation,
      f = t.session.stack[t.session.stack.length - 1];
    if (
      !c ||
      !f ||
      c.expiresAt <= Date.now() ||
      c.hash !== this.#confirmationHash(t, c.prepared, c.preview)
    )
      fail(
        "CONFIRMATION_STALE",
        "Confirmation is absent, expired, or changed.",
      );
    return {
      status: "needs_confirmation",
      tool: { id: f.tool },
      message: /\p{Script=Arabic}/u.test(t.session.lastUserMessage ?? "")
        ? "راجعي تفاصيل الطلب ثم استخدمي زر التأكيد لتنفيذه."
        : "Review and confirm this action using its confirmation ID.",
      confirmation: {
        id: c.token,
        expiresAt: c.expiresAt,
        preview: redact(c.preview ?? {}, t.secrets),
      },
    };
  }
  #selectionResult(s: SelectionState, introduction?: string): Outcome {
    if (s.expiresAt <= Date.now())
      fail(
        "INPUT_SELECTION_STALE",
        "Selection expired during the response. Request fresh options.",
      );
    if (s.language === "ar") {
      if (
        introduction ===
        "The requested option is unavailable. Choose one of these alternatives."
      )
        introduction = "الخيار المطلوب غير متاح. اختاري أحد البدائل التالية.";
      if (
        introduction ===
        "More than one option has that name. Choose its displayed number."
      )
        introduction =
          "يوجد أكثر من خيار بهذا الاسم. اختاري الرقم الظاهر بجانبه.";
    }
    const list = s.options
      .map((option, index) => `${index + 1}. ${option.label}`)
      .join("\n");
    return {
      status: "needs_selection",
      message: [
        introduction ??
          (s.language === "ar"
            ? "اختاري أحد الخيارات التالية:"
            : "Select an option."),
        list,
      ]
        .filter(Boolean)
        .join("\n"),
      selection: {
        id: s.token,
        expiresAt: s.expiresAt,
        options: s.options,
      },
    };
  }
  #chatSelection(
    selection: SelectionState,
    message: string,
  ):
    { kind: "matched"; id: string } | { kind: "ambiguous" } | { kind: "none" } {
    const value = message
      .trim()
      .replace(/[٠-٩]/g, (digit) => String("٠١٢٣٤٥٦٧٨٩".indexOf(digit)))
      .replace(/[۰-۹]/g, (digit) => String("۰۱۲۳۴۵۶۷۸۹".indexOf(digit)));
    if (/^[1-9]\d*$/.test(value)) {
      const option = selection.options[Number(value) - 1];
      return option ? { kind: "matched", id: option.id } : { kind: "none" };
    }
    const normalize = (text: string) =>
      text
        .normalize("NFKC")
        .toLocaleLowerCase()
        .replace(/[أإآٱ]/g, "ا")
        .replace(/ى/g, "ي")
        .replace(/ة/g, "ه")
        .replace(/\p{M}/gu, "")
        .replace(/[^\p{L}\p{N}]+/gu, " ")
        .trim();
    const matches = selection.options.filter(
      (option) => normalize(option.label) === normalize(value),
    );
    if (matches.length === 1) return { kind: "matched", id: matches[0].id };
    return matches.length > 1 ? { kind: "ambiguous" } : { kind: "none" };
  }
  #selectionMatches(
    selection: SelectionState,
    config: NonNullable<ToolConfig["selection"]>,
    input: Record<string, unknown>,
  ): { explicit: boolean; indices: number[] } {
    if (!config.match) return { explicit: false, indices: [] };
    const expected = readPath(input, config.match.input_path);
    if (typeof expected !== "string" && typeof expected !== "number")
      return { explicit: false, indices: [] };
    const normalized = String(expected).trim().toLocaleLowerCase();
    const indices = selection.items
      .map((item, index) => ({
        index,
        value: readPath(item, config.match!.item_path),
      }))
      .filter(
        ({ value }) =>
          (typeof value === "string" || typeof value === "number") &&
          String(value).trim().toLocaleLowerCase() === normalized,
      )
      .map(({ index }) => index);
    return { explicit: true, indices };
  }
  #subsetSelection(selection: SelectionState, indices: number[]) {
    if (selection.facts)
      selection.facts = indices.map((index) => selection.facts![index]);
    selection.items = indices.map((index) => selection.items[index]);
    selection.options = indices.map((index) => selection.options[index]);
    return selection;
  }
  #makeSelection(
    t: Turn,
    data: unknown,
    config: NonNullable<ToolConfig["selection"]>,
    expiresAt: number,
    allowEmpty = false,
    publication?: SelectionState["publication"],
  ): SelectionState {
    const items = readPath(data, config.items_path);
    if (
      !Array.isArray(items) ||
      (!allowEmpty && items.length === 0) ||
      items.length > 1000
    )
      fail(
        "DEPENDENCY_SELECTION_INVALID",
        allowEmpty
          ? "Selection must contain 0–1000 items."
          : "Selection must contain 1–1000 items.",
        { items_path: config.items_path },
      );
    const options = items.map((item) => {
      const id = readPath(item, config.id_path),
        label = readPath(item, config.label_path);
      if (
        !["string", "number"].includes(typeof id) ||
        typeof label !== "string"
      )
        return fail(
          "DEPENDENCY_SELECTION_INVALID",
          "Selection item does not match configured ID/label paths.",
          { id_path: config.id_path, label_path: config.label_path },
        );
      return { id: config.id_sensitive ? randomUUID() : String(id), label };
    });
    if (new Set(options.map((o) => o.id)).size !== options.length)
      fail("DEPENDENCY_SELECTION_INVALID", "Selection IDs must be unique.");
    const selection: SelectionState = {
      token: randomUUID(),
      items,
      options,
      expiresAt,
      contextHash: this.#selectionContextHash(t),
      language:
        this.#compiled.policies.assistant.language === "ar" ||
        (this.#compiled.policies.assistant.language === "auto" &&
          /\p{Script=Arabic}/u.test(t.session.lastUserMessage ?? ""))
          ? "ar"
          : "en",
      facts: items.map(
        (item) =>
          this.#displayData(
            t,
            Object.fromEntries(
              Object.entries(config.facts ?? {}).flatMap(([key, path]) => {
                const value = readPath(item, path);
                return value === undefined ? [] : [[key, value]];
              }),
            ),
          ) as Record<string, unknown>,
      ),
    };
    selection.publication = publication;
    return selection;
  }
  #selectionContextHash(t: Turn) {
    return digest({
      session: t.session.id,
      config: this.#compiled.hash,
      context: t.session.context,
    });
  }
  #dependencyHash(
    t: Turn,
    parent: Frame,
    dep: ToolConfig["depends_on"][number],
  ) {
    return digest({
      arguments: this.#dependencyArgs(t, parent, dep),
      context: t.session.context,
    });
  }
  #applyDependency(
    t: Turn,
    parent: Frame,
    dep: ToolConfig["depends_on"][number],
    data: unknown,
    expiresAt: number,
  ) {
    if (dep.select) {
      const facts = Object.fromEntries(
        Object.entries(dep.select.facts ?? {}).flatMap(([key, path]) => {
          const value = readPath(data, path);
          return value === undefined ? [] : [[key, value]];
        }),
      );
      parent.selectionFacts = {
        ...parent.selectionFacts,
        ...(this.#displayData(t, facts) as Record<string, unknown>),
      };
      parent.selectionExpiresAt = Math.min(
        parent.selectionExpiresAt ?? Infinity,
        expiresAt,
      );
    }
    const hash = this.#dependencyHash(t, parent, dep);
    for (const [target, source] of Object.entries(dep.map)) {
      const value = readPath(data, source);
      if (value === undefined)
        fail(
          "DEPENDENCY_UNRESOLVED",
          "Dependency output is missing a mapped value.",
        );
      writePath(parent.arguments, target, value);
      const key = parent.tool + ":" + target;
      t.session.facts[key] = {
        key,
        value,
        source: "tool",
        sourceToolId: dep.tool,
        createdAt: Date.now(),
        expiresAt,
      };
    }
    parent.dependencies[dep.tool] = { data, expiresAt, hash };
    const cacheKey = parent.tool + ":dependency:" + dep.tool;
    t.session.facts[cacheKey] = {
      key: cacheKey,
      value: { data, expiresAt, hash },
      source: "tool",
      sourceToolId: dep.tool,
      createdAt: Date.now(),
      expiresAt,
    };
    this.#emit(t, "onDependencyResolved", {
      tool: parent.tool,
      dependency: dep.tool,
    });
  }
  #publishSelection(t: Turn, selection: SelectionState, item: unknown) {
    const publication = selection.publication;
    if (!publication) return;
    const value = readPath(item, publication.path);
    if (value === undefined)
      fail(
        "DEPENDENCY_UNRESOLVED",
        "Selected item is missing its configured reference.",
      );
    t.session.references ??= {};
    t.session.references[publication.name] = {
      value: structuredClone(value),
      expiresAt: Math.min(selection.expiresAt, Date.now() + publication.ttl_ms),
      sourceToolId: publication.sourceToolId,
      contextHash: selection.contextHash,
      facts: selection.facts?.[selection.items.indexOf(item)],
    };
  }
  async #select(t: Turn, token: string, choice: string): Promise<Outcome> {
    const s = t.session,
      selection = s.selection;
    if (
      s.state !== "AWAITING_SELECTION" ||
      !selection ||
      selection.token !== token ||
      selection.expiresAt <= Date.now() ||
      selection.contextHash !== this.#selectionContextHash(t)
    )
      fail("INPUT_SELECTION_STALE", "Selection is absent or expired.");
    const index = selection.options.findIndex((o) => o.id === choice);
    if (index < 0)
      fail("INPUT_SELECTION_INVALID", "Choose an ID from the current options.");
    const selected = selection.items[index];
    this.#publishSelection(t, selection, selected);
    delete s.selection;
    transition(s, "RESOLVING_DEPENDENCIES");
    if (selection.dependency) {
      const parent = s.stack[s.stack.length - 1],
        dep = this.#compiled.executions
          .get(parent.tool)
          .config.depends_on.find((d) => d.tool === selection.dependency);
      if (!dep)
        fail("DEPENDENCY_UNRESOLVED", "Selection dependency is unavailable.");
      this.#applyDependency(t, parent, dep, selected, selection.expiresAt);
      parent.selectionFacts = {
        ...parent.selectionFacts,
        ...selection.facts?.[index],
      };
      parent.selectionExpiresAt = Math.min(
        parent.selectionExpiresAt ?? Infinity,
        selection.expiresAt,
      );
    } else if (selection.navigation) {
      const args = mapValues(selection.navigation.arguments ?? {}, {
        input: selection.navigation.sourceArguments ?? {},
        session: s.context,
        dependencies: {},
      });
      for (const [target, source] of Object.entries(selection.navigation.map)) {
        const value = readPath(selected, source);
        if (value === undefined)
          fail("DEPENDENCY_UNRESOLVED", "Navigation mapping is missing.");
        writePath(args, target, value);
      }
      s.stack = [this.#frame(selection.navigation.tool, args, t)];
      s.stack[0].selectionFacts = {
        ...s.stack[0].selectionFacts,
        ...selection.facts?.[index],
      };
      s.stack[0].selectionExpiresAt = selection.expiresAt;
    } else fail("INPUT_SELECTION_INVALID", "No pending navigation.");
    return this.#drive(t);
  }
  async #execute(
    t: Turn,
    frame: Frame,
    prepared: ReturnType<typeof prepareRequest>,
  ): Promise<Outcome> {
    const s = t.session,
      execution = this.#compiled.executions.get(frame.tool),
      tool = execution.config;
    this.#emit(t, "onToolExecutionStarted", { tool: frame.tool });
    t.debug.execution = {
      tool: frame.tool,
      mappedQuery: Object.keys(tool.request.map.query),
      dependencyCount: tool.depends_on.length,
    };
    let data: unknown;
    try {
      data = await this.#http.execute(tool, prepared, {
        token: t.token,
        signal: t.request.signal,
        beforeAttempt: async () => {
          await this.#limit(t, "tool_calls");
          t.metrics.toolCalls++;
        },
        onRetry: (attempt) => {
          t.metrics.retryCount++;
          this.#emit(t, "onRetry", { tool: frame.tool, attempt });
        },
        onLatency: (ms) => {
          t.metrics.httpMs += ms;
        },
      });
    } catch (error) {
      const recovery = tool.behavior.recovery;
      if (
        !(error instanceof AgentRuntimeError) ||
        !recovery ||
        !recovery.statuses.includes(error.details.status as 409 | 410)
      )
        throw error;
      const dep = tool.depends_on.find(
        (entry) => entry.tool === recovery.refresh_dependency,
      )!;
      for (const path of Object.keys(dep.map)) {
        const parts = path.slice(2).split(".");
        let object = frame.arguments;
        for (const part of parts.slice(0, -1))
          object = (object?.[part] ?? {}) as Record<string, unknown>;
        delete object[parts.at(-1)!];
      }
      delete frame.dependencies[dep.tool];
      delete frame.selectionFacts;
      delete frame.selectionExpiresAt;
      s.facts = {};
      delete s.confirmation;
      delete s.selection;
      transition(s, "RESOLVING_DEPENDENCIES");
      const refreshed = await this.#drive(t);
      return {
        ...refreshed,
        message: [
          "The previous option is no longer available. Review the refreshed result before confirming.",
          refreshed.message,
        ]
          .filter(Boolean)
          .join("\n"),
      };
    }
    if (execution.validateOutput && !execution.validateOutput(data))
      fail(
        "TOOL_OUTPUT_SCHEMA_VIOLATION",
        "API response violates the configured output schema.",
      );
    const safe = redact(data, t.secrets);
    if (tool.behavior.effect !== "read-only") s.facts = {};
    this.#emit(t, "onToolExecutionFinished", { tool: frame.tool });
    s.stack.pop();
    if (s.stack.length) {
      const parent = s.stack[s.stack.length - 1],
        dep = this.#compiled.executions
          .get(parent.tool)
          .config.depends_on.find((d) => d.tool === frame.tool);
      if (!dep) fail("DEPENDENCY_UNRESOLVED", "Missing dependency link.");
      parent.selectionFacts = {
        ...parent.selectionFacts,
        ...frame.selectionFacts,
      };
      transition(s, "RESOLVING_DEPENDENCIES");
      const dependencyExpiry = Math.min(
        Date.now() + dep.ttl_ms,
        ...Object.values(frame.dependencies).map((d) => d.expiresAt),
      );
      if (dep.select) {
        const selection = this.#makeSelection(
          t,
          safe,
          dep.select,
          dependencyExpiry,
          true,
          tool.references?.publish
            ? { ...tool.references.publish, sourceToolId: tool.id }
            : undefined,
        );
        selection.facts = selection.facts?.map((facts) => ({
          ...frame.selectionFacts,
          ...facts,
        }));
        if (!selection.items.length) {
          transition(s, "GATHERING_INPUT");
          return {
            status: "needs_input",
            tool: { id: parent.tool },
            missing: [],
            message:
              "No matching options are currently available. Try another date or preference.",
          };
        }
        const match = this.#selectionMatches(
          selection,
          dep.select,
          parent.arguments,
        );
        if (match.explicit && match.indices.length === 1) {
          this.#publishSelection(
            t,
            selection,
            selection.items[match.indices[0]],
          );
          this.#applyDependency(
            t,
            parent,
            dep,
            selection.items[match.indices[0]],
            selection.expiresAt,
          );
        } else if (!match.explicit && selection.items.length === 1) {
          this.#publishSelection(t, selection, selection.items[0]);
          this.#applyDependency(
            t,
            parent,
            dep,
            selection.items[0],
            selection.expiresAt,
          );
        } else {
          if (match.indices.length > 1)
            this.#subsetSelection(selection, match.indices);
          selection.dependency = dep.tool;
          s.selection = selection;
          transition(s, "AWAITING_SELECTION");
          return this.#selectionResult(
            selection,
            match.explicit && match.indices.length === 0
              ? "The requested option is unavailable. Choose one of these alternatives."
              : undefined,
          );
        }
      } else this.#applyDependency(t, parent, dep, safe, dependencyExpiry);
      return this.#drive(t);
    }
    transition(s, "PRESENTING_RESULT");
    const result: Outcome = {
      status: "completed",
      tool: { id: frame.tool },
      data: this.#displayData(t, safe),
    };
    const presentation = t.request.presentation ?? this.#defaultPresentation;
    if (presentation !== "raw") {
      const view = tool.response.model_view;
      let projected = readPath(
        this.#displayData(t, safe),
        view.path === "$" ? (tool.response.items_path ?? "$") : view.path,
      );
      const projectItem = (item: unknown) =>
        view.include && item && typeof item === "object" && !Array.isArray(item)
          ? Object.fromEntries(
              view.include
                .filter((k) => Object.hasOwn(item, k))
                .map((k) => [k, (item as Record<string, unknown>)[k]]),
            )
          : item;
      projected = Array.isArray(projected)
        ? projected.slice(0, view.max_items).map(projectItem)
        : projectItem(projected);
      const hasChoices = Boolean(tool.selection && tool.navigates_to);
      if (hasChoices) {
        const items = readPath(safe, tool.selection!.items_path);
        projected = { optionCount: Array.isArray(items) ? items.length : 0 };
      }
      const text = JSON.stringify(projected) ?? "null";
      const compact =
        text.length > view.max_chars
          ? { truncated: true, preview: text.slice(0, view.max_chars) }
          : projected;
      try {
        if (!this.#presentation)
          fail("MODEL_NOT_CONFIGURED", "AI presentation requires a model.");
        await this.#modelCall(t);
        const response = await this.#presentation.generateText({
          system: redact(
            assistantSystemPrompt(this.#compiled, {
              kind: "tool_result",
              toolInstructions: hasChoices
                ? "The host renders all choices in a deterministic list. Write one short introductory question only. Never name, enumerate, describe, price, or number options. You only know the count, not their contents. If count is zero, explain no results were found."
                : tool.response.instructions,
            }),
            t.secrets,
          ),
          messages: [
            {
              role: "user",
              content: JSON.stringify(
                compact &&
                  typeof compact === "object" &&
                  !Array.isArray(compact)
                  ? {
                      ...redact(compact, t.secrets),
                      _agento: {
                        lastUserMessage: s.lastUserMessage,
                        resultType:
                          tool.selection && tool.navigates_to
                            ? "needs_selection"
                            : "completed",
                      },
                    }
                  : {
                      apiFacts: redact(compact, t.secrets),
                      _agento: {
                        lastUserMessage: s.lastUserMessage,
                        resultType:
                          tool.selection && tool.navigates_to
                            ? "needs_selection"
                            : "completed",
                      },
                    },
              ),
            },
          ],
          signal: t.request.signal,
        });
        this.#usage(t, response.usage);
        result.message = redact(response.text, t.secrets);
        if (
          hasChoices &&
          /(?:^|\n)\s*(?:\d+[.)]|[-*•])\s/m.test(result.message)
        )
          result.message = /\p{Script=Arabic}/u.test(s.lastUserMessage ?? "")
            ? "اختاري من الخيارات التالية:"
            : "Choose from the following options:";
        if (presentation === "ai") delete result.data;
      } catch {
        const fallback = JSON.stringify(compact, null, 2);
        result.message =
          fallback && fallback !== "null"
            ? fallback
            : "Tool completed; natural-language presentation is unavailable.";
        this.#emit(t, "onPresentationFailed", { tool: frame.tool });
      }
    }
    if (tool.selection && tool.navigates_to) {
      const selection = this.#makeSelection(
        t,
        safe,
        tool.selection,
        Math.min(Date.now() + 60000, frame.selectionExpiresAt ?? Infinity),
        true,
        tool.references?.publish
          ? { ...tool.references.publish, sourceToolId: tool.id }
          : undefined,
      );
      selection.facts = selection.facts?.map((facts) => ({
        ...frame.selectionFacts,
        ...facts,
      }));
      if (selection.items.length === 0) {
        transition(s, "COMPLETED");
        return result;
      }
      s.selection = selection;
      selection.navigation = {
        ...tool.navigates_to,
        sourceArguments: structuredClone(frame.arguments),
      };
      const match = this.#selectionMatches(
        selection,
        tool.selection,
        frame.arguments,
      );
      if (match.explicit && match.indices.length === 1) {
        transition(s, "AWAITING_SELECTION");
        return this.#select(
          t,
          selection.token,
          selection.options[match.indices[0]].id,
        );
      }
      if (match.indices.length > 1)
        this.#subsetSelection(selection, match.indices);
      transition(s, "AWAITING_SELECTION");
      return {
        ...result,
        ...this.#selectionResult(
          s.selection,
          match.explicit && match.indices.length === 0
            ? [
                result.message,
                "The requested option is unavailable. Choose one of these alternatives.",
              ]
                .filter(Boolean)
                .join("\n")
            : result.message,
        ),
      };
    }
    transition(s, "COMPLETED");
    return result;
  }
}
