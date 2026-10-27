import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { stripTypeScriptTypes } from "node:module";
import { test } from "node:test";
import { createContext, SourceTextModule } from "node:vm";

const source = stripTypeScriptTypes(await readFile(new URL("./auto-title.ts", import.meta.url), "utf8"));
const flush = () => new Promise((resolve) => setImmediate(resolve));

async function setup({ complete, model = { id: "current-model" } } = {}) {
  let finish;
  let signal;
  let calls = 0;
  let completionModel;
  let completionOptions;
  let name;
  let sessionId = "first";
  const completion = new Promise((resolve) => { finish = resolve; });
  const deadline = new AbortController();
  const context = createContext({
    AbortController,
    AbortSignal: {
      any: (signals) => AbortSignal.any(signals),
      timeout: (milliseconds) => {
        assert.equal(milliseconds, 15_000);
        return deadline.signal;
      },
    },
  });
  const module = new SourceTextModule(source, { context });
  await module.link(() => { throw new Error("Unexpected runtime import"); });
  await module.evaluate();
  const handlers = {};
  module.namespace.default({
    on: (event, handler) => { handlers[event] = handler; },
    getSessionName: () => name,
    setSessionName: (value) => { name = value; },
  });
  const ctx = {
    model,
    modelRegistry: {
      complete: (model, context, options) => {
        calls++;
        completionModel = model;
        completionOptions = options;
        signal = options.signal;
        return complete ? complete(model, context, options) : completion;
      },
    },
    sessionManager: { getSessionId: () => sessionId },
  };
  handlers.session_start({}, ctx);
  return {
    handlers, ctx,
    expire() { deadline.abort(); },
    get name() { return name; },
    get signal() { return signal; },
    get calls() { return calls; },
    get completionModel() { return completionModel; },
    get completionOptions() { return completionOptions; },
    rename(value) { name = value; },
    switchSession() { sessionId = "second"; name = undefined; handlers.session_start({}, ctx); },
    finish(response = { stopReason: "stop", content: [{ type: "text", text: "Short summary" }] }) { finish(response); },
  };
}

const input = { text: "/skill:any explain something" };

test("input returns before summary completion and later applies the summary", async () => {
  const app = await setup();
  let returned = false;
  const result = Promise.resolve(app.handlers.input(input, app.ctx)).then(() => { returned = true; });
  await flush();
  const returnedBeforeCompletion = returned;
  app.finish();
  await result;
  await flush();
  assert.equal(returnedBeforeCompletion, true);
  assert.equal(app.name, "[any] Short summary");
});

test("shutdown cancels work and prevents late rename", async () => {
  const app = await setup();
  const result = app.handlers.input(input, app.ctx);
  await flush();
  app.handlers.session_shutdown?.({}, app.ctx);
  app.finish();
  await result;
  await flush();
  assert.equal(app.signal?.aborted, true);
  assert.equal(app.name, "[any] explain something");
});

test("manual rename survives late completion", async () => {
  const app = await setup();
  const result = app.handlers.input(input, app.ctx);
  await flush();
  app.rename("My title");
  app.finish();
  await result;
  await flush();
  assert.equal(app.name, "My title");
});

test("replacement session cannot be renamed by old work", async () => {
  const app = await setup();
  const result = app.handlers.input(input, app.ctx);
  await flush();
  app.switchSession();
  app.finish();
  await result;
  await flush();
  assert.equal(app.name, undefined);
});

test("timeout cancels completion and discards a late response", async () => {
  const app = await setup();
  app.handlers.input(input, app.ctx);
  await flush();
  app.expire();
  assert.equal(app.signal.aborted, true);
  app.finish();
  await flush();
  assert.equal(app.name, "[any] explain something");
});

test("registry completion errors stay in the background", async () => {
  const app = await setup({ complete: async () => { throw new Error("Auth unavailable"); } });
  await app.handlers.input(input, app.ctx);
  await flush();
  assert.equal(app.calls, 1);
  assert.equal(app.name, "[any] explain something");
});

test("uses the registry to complete with the current model", async () => {
  const app = await setup();
  app.handlers.input(input, app.ctx);
  await flush();
  app.finish();
  await flush();
  assert.equal(app.completionModel, app.ctx.model);
});

test("no current model keeps the temporary title without a completion", async () => {
  const app = await setup({ model: null });
  app.handlers.input(input, app.ctx);
  app.finish();
  await flush();
  assert.equal(app.calls, 0);
  assert.equal(app.name, "[any] explain something");
});


test("manual name before first skill input is preserved", async () => {
  const app = await setup();
  app.rename("My title");
  app.handlers.input(input, app.ctx);
  const immediateName = app.name;
  app.finish();
  await flush();
  assert.equal(immediateName, "My title");
  assert.equal(app.name, "My title");
  assert.equal(app.calls, 0);
});

test("summary request has a small token limit", async () => {
  const app = await setup();
  app.handlers.input(input, app.ctx);
  app.finish();
  await flush();
  assert.equal(app.completionOptions.maxTokens, 64);
});

test("generated title normalizes whitespace and caps total length", async () => {
  const app = await setup();
  app.handlers.input(input, app.ctx);
  app.finish({ stopReason: "stop", content: [{ type: "text", text: "  First\n\t second   " + "word ".repeat(30) }] });
  await flush();
  assert.equal(app.name, ("[any] First second " + "word ".repeat(30)).slice(0, 80).trim());
  assert.ok(app.name.length <= 80);
});

for (const stopReason of ["error", "aborted", "length", "toolUse"]) {
  test(`${stopReason} response keeps the temporary title even with text`, async () => {
    const app = await setup();
    app.handlers.input(input, app.ctx);
    app.finish({ stopReason, content: [{ type: "text", text: "Partial summary" }] });
    await flush();
    assert.equal(app.name, "[any] explain something");
  });
}

test("empty or non-text output keeps the temporary title", async () => {
  const app = await setup();
  app.handlers.input(input, app.ctx);
  app.finish({ stopReason: "stop", content: [{ type: "thinking", thinking: "Internal" }, { type: "text", text: " \n\t " }] });
  await flush();
  assert.equal(app.name, "[any] explain something");
});

test("ordinary input generates a title without a skill prefix only once", async () => {
  const app = await setup();
  app.handlers.input({ text: "  Help debug login failures  " }, app.ctx);
  assert.equal(app.name, "Help debug login failures");
  app.handlers.input({ text: "Another request" }, app.ctx);
  assert.equal(app.calls, 1);
  app.finish();
  await flush();
  assert.equal(app.name, "Short summary");
  app.handlers.input({ text: "A later request" }, app.ctx);
  assert.equal(app.calls, 1);
});

test("blank input leaves the session available for titling", async () => {
  const app = await setup();
  app.handlers.input({ text: " \n\t " }, app.ctx);
  assert.equal(app.name, undefined);
  assert.equal(app.calls, 0);
  app.handlers.input({ text: "Explain something" }, app.ctx);
  app.finish();
  await flush();
  assert.equal(app.name, "Short summary");
});

test("skill without a request keeps its prefix without a completion", async () => {
  const app = await setup();
  app.handlers.input({ text: "/skill:review" }, app.ctx);
  assert.equal(app.name, "[review]");
  assert.equal(app.calls, 0);
});
