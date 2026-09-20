import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { randomBytes } from "node:crypto";
import * as library from "../../dist/index.js";
import { SessionCredentials } from "../../dist/auth/manager.js";

const memory = () => {
  const records = new Map();
  return {
    records,
    get: (id) => records.get(id),
    set: (id, record) => records.set(id, record),
    delete: (id) => records.delete(id),
  };
};
test("public entry points resolve to V2 and expose opaque credential storage only", async () => {
  const v2 = await import("../../dist/v2/index.js");
  assert.equal(library.default, library.AgentRuntime);
  assert.equal(v2.default, library.AgentRuntime);
  assert.equal("AgentHandler" in library, false);
  assert.equal("createJwtVerifier" in library, false);
  assert.equal(typeof library.MemorySessionTokenStore, "function");
});
test("real HTTP transport forwards arbitrary and expired-looking credentials; only the API rejects them", async (t) => {
  const calls = [];
  const server = createServer((req, res) => {
    const token = req.headers.authorization;
    calls.push(token);
    res.setHeader("content-type", "application/json");
    res.statusCode = !token ? 401 : token === "Bearer denied" ? 403 : 200;
    res.end(JSON.stringify({ ok: res.statusCode === 200 }));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => {
    server.closeAllConnections();
    return new Promise((resolve) => server.close(resolve));
  });
  const store = new library.MemorySessionStore();
  const runtime = await library.AgentRuntime.create({
    sessionStore: store,
    config: {
      version: "2",
      tools: [
        {
          id: "read",
          tool: {
            description: "read user records",
            input_schema: { type: "object", properties: {} },
          },
          request: {
            method: "GET",
            url: `http://127.0.0.1:${server.address().port}/records`,
            auth: { type: "session" },
            allow_insecure_http: true,
          },
        },
      ],
    },
  });
  t.after(() => runtime.dispose());
  const invoke = (token) =>
    runtime.invoke({
      sessionId: "s",
      tool: "read",
      ...(token === undefined ? {} : { auth: { token } }),
    });
  assert.equal((await invoke()).error.code, "AUTH_REJECTED");
  assert.equal((await invoke("opaque:value")).status, "completed");
  assert.equal((await invoke()).status, "completed");
  const expired =
    "eyJhbGciOiJub25lIn0." +
    Buffer.from('{"exp":1,"sub":"untrusted"}').toString("base64url") +
    ".anything";
  assert.equal((await invoke(expired)).status, "completed");
  const denied = await invoke("denied");
  assert.equal(denied.error.code, "AUTH_REJECTED");
  assert.equal(denied.error.details.status, 403);
  await runtime.clearSession("s");
  assert.equal((await invoke()).error.details.status, 401);
  assert.deepEqual(calls, [
    undefined,
    "Bearer opaque:value",
    "Bearer opaque:value",
    `Bearer ${expired}`,
    "Bearer denied",
    undefined,
  ]);
  assert.equal(
    JSON.stringify(await store.get("s")).includes("opaque:value"),
    false,
  );
  assert.equal("identity" in (await store.get("s")), false);
});
test("encrypted credentials survive across workers with one key, obey TTL and bind ciphertext to the session", async (t) => {
  const store = memory(),
    key = randomBytes(32);
  const one = new SessionCredentials({ store, encryptionKey: key }, 30_000);
  const two = new SessionCredentials({ store, encryptionKey: key }, 30_000);
  t.after(() => {
    one.dispose();
    two.dispose();
  });
  const expiry = Date.now() + 15_000;
  await one.resolve("alice", "secret:alice", expiry);
  const record = store.records.get("alice");
  assert.equal(record.value.includes("secret:alice"), false);
  assert.equal(record.expiresAt, expiry);
  assert.equal(await two.resolve("alice"), "secret:alice");
  store.records.set("bob", store.records.get("alice"));
  await assert.rejects(two.resolve("bob"), { code: "AUTH_STORAGE_ERROR" });
  store.records.get("alice").expiresAt = 1;
  assert.equal(await one.resolve("alice"), undefined);
  assert.equal(await two.resolve("alice"), undefined);
});
test("failed replacement and failed logout do not revive previous credentials", async (t) => {
  const store = memory(),
    key = randomBytes(32);
  const credentials = new SessionCredentials(
    { store, encryptionKey: key },
    30_000,
  );
  t.after(() => credentials.dispose());
  await credentials.resolve("s", "old");
  await assert.rejects(credentials.resolve("s", "new\r\nheader: bad"), {
    code: "AUTH_TOKEN_INVALID",
  });
  assert.equal(await credentials.resolve("s"), undefined);
  await credentials.resolve("s", "old");
  const remove = store.delete;
  store.delete = () => {
    throw Error("private-store-error");
  };
  await assert.rejects(credentials.clear("s"), { code: "AUTH_STORAGE_ERROR" });
  store.delete = remove;
  assert.equal(await credentials.resolve("s"), undefined);
  assert.equal(await credentials.resolve("s", "replacement"), "replacement");
});
test("late writes after a failed storage operation cannot restore a logged-out token", async (t) => {
  const store = memory(),
    key = randomBytes(32);
  const credentials = new SessionCredentials(
    { store, encryptionKey: key },
    30_000,
  );
  t.after(() => credentials.dispose());
  let late;
  const set = store.set;
  store.set = (_id, record) => {
    late = record;
    throw Error("write timeout");
  };
  await assert.rejects(credentials.resolve("s", "old"), {
    code: "AUTH_STORAGE_ERROR",
  });
  store.set = set;
  set("s", late);
  assert.equal(await credentials.resolve("s"), undefined);
  await credentials.resolve("s", "new");
  set("s", late);
  await assert.rejects(credentials.resolve("s"), {
    code: "AUTH_STORAGE_ERROR",
  });
});
test("custom credential stores require a storage encryption key, with no token-verification configuration", () => {
  assert.throws(() => new SessionCredentials({ store: memory() }, 1000), {
    code: "CONFIG_AUTH_INVALID",
  });
  assert.throws(
    () => new SessionCredentials({ encryptionKey: randomBytes(4) }, 1000),
    { code: "CONFIG_AUTH_INVALID" },
  );
});
