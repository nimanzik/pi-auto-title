import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stripTypeScriptTypes } from "node:module";
import { after, test } from "node:test";
import { createContext, SourceTextModule, SyntheticModule } from "node:vm";

const source = stripTypeScriptTypes(await readFile(new URL("./auto-title.ts", import.meta.url), "utf8"));
const flush = () => new Promise((resolve) => setImmediate(resolve));

const directories = [];
after(() => directories.forEach((directory) => rmSync(directory, { recursive: true, force: true })));

async function setup({ complete, model = { provider: "session", id: "current-model" },
  registryModel = { provider: "other", id: "small" }, auth = true, pin, configText, directory } = {}) {
  directory ??= mkdtempSync(join(tmpdir(), "pi-auto-title-"));
  directories.push(directory);
  const configPath = join(directory, "auto-title.json");
  if (configText !== undefined) writeFileSync(configPath, configText);
  else if (pin) writeFileSync(configPath, JSON.stringify(pin));
  const notifications = [];
  const attempts = [];
  const deadlines = [];
  let finish;
  let signal;
  let calls = 0;
  let completionModel;
  let completionOptions;
  let name;
  let sessionId = "first";
  const completion = new Promise((resolve) => { finish = resolve; });
  const context = createContext({
    AbortController,
    AbortSignal: {
      any: (signals) => AbortSignal.any(signals),
      timeout: (milliseconds) => {
        assert.equal(milliseconds, 15_000);
        const deadline = new AbortController();
        deadlines.push(deadline);
        return deadline.signal;
      },
    },
  });
  const module = new SourceTextModule(source, { context });
  await module.link(async (specifier) => {
    const exports = specifier === "@earendil-works/pi-coding-agent"
      ? { getAgentDir: () => directory }
      : await import(specifier);
    return new SyntheticModule(Object.keys(exports), function () {
      for (const [key, value] of Object.entries(exports)) this.setExport(key, value);
    }, { context });
  });
  await module.evaluate();
  const handlers = {};
  const commands = {};
  module.namespace.default({
    on: (event, handler) => { handlers[event] = handler; },
    registerCommand: (command, definition) => { commands[command] = definition.handler; },
    getSessionName: () => name,
    setSessionName: (value) => { name = value; },
  });
  const ctx = {
    model,
    modelRegistry: {
      find: (provider, id) => registryModel?.provider === provider && registryModel?.id === id ? registryModel : undefined,
      hasConfiguredAuth: () => auth,
      complete: (model, context, options) => {
        calls++;
        attempts.push({ model, options });
        completionModel = model;
        completionOptions = options;
        signal = options.signal;
        return complete ? complete(model, context, options) : completion;
      },
    },
    sessionManager: { getSessionId: () => sessionId },
    ui: { notify: (text, level) => notifications.push({ text, level }) },
  };
  handlers.session_start({}, ctx);
  return {
    handlers, ctx, notifications, attempts, configPath, directory,
    command(args) { return commands["auto-title"](args, ctx); },
    expire(index = 0) { deadlines[index].abort(); },
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

const pin = { provider: "other", model: "small" };
const summary = { stopReason: "stop", content: [{ type: "text", text: "Pinned summary" }] };

test("model command shows the session model without starting title generation", async () => {
  const app = await setup();
  await app.command("model");
  assert.match(app.notifications.at(-1).text, /follows session model: session\/current-model/);
  assert.equal(app.name, undefined);
  assert.equal(app.calls, 0);
});

test("pin persists across extension instances and does not change the session model", async () => {
  const first = await setup();
  await first.command("model other small");
  assert.deepEqual(JSON.parse(readFileSync(first.configPath, "utf8")), pin);
  const app = await setup({ directory: first.directory });
  await app.command("model");
  assert.match(app.notifications.at(-1).text, /pinned: other\/small/);
  app.handlers.input(input, app.ctx);
  assert.equal(app.completionModel.id, "small");
  assert.equal(app.ctx.model.id, "current-model");
  app.finish(summary);
  await flush();
  assert.equal(app.name, "[any] Pinned summary");
});

test("reset removes the pin and follows subsequent session model changes", async () => {
  const app = await setup({ pin });
  await app.command("model reset");
  await app.command("model reset");
  assert.equal(existsSync(app.configPath), false);
  app.ctx.model = { provider: "session", id: "changed" };
  app.handlers.input(input, app.ctx);
  assert.equal(app.completionModel.id, "changed");
  app.finish();
  await flush();
});

for (const options of [{ registryModel: null }, { auth: false }]) {
  test(`invalid pin command preserves existing config: ${JSON.stringify(options)}`, async () => {
    const app = await setup({ ...options, pin });
    const original = readFileSync(app.configPath, "utf8");
    await app.command("model other small");
    assert.equal(app.notifications.at(-1).level, "error");
    assert.equal(readFileSync(app.configPath, "utf8"), original);
  });
}

test("invalid command arguments leave configuration untouched", async () => {
  const app = await setup({ pin });
  for (const args of ["", "model other", "model other small extra", "other"]) {
    await app.command(args);
    assert.match(app.notifications.at(-1).text, /Usage:/);
    assert.deepEqual(JSON.parse(readFileSync(app.configPath, "utf8")), pin);
  }
});

test("write failure is reported without losing the old pin", async () => {
  const app = await setup({ pin });
  // A directory at the config path cannot be replaced by a file.
  rmSync(app.configPath);
  mkdirSync(app.configPath);
  await app.command("model other small");
  assert.equal(app.notifications.at(-1).level, "error");
  assert.deepEqual(readdirSync(app.directory), ["auto-title.json"]);
});

for (const configText of ["{broken", "null", "{}", '{"provider":3,"model":"small"}', '{"provider":"other","model":" "}']) {
  test(`invalid manual config warns and uses session model: ${configText}`, async () => {
    const app = await setup({ configText });
    app.handlers.input(input, app.ctx);
    assert.equal(app.completionModel, app.ctx.model);
    assert.equal(app.notifications[0].level, "warning");
    app.finish();
    await flush();
    assert.equal(app.name, "[any] Short summary");
    assert.equal(readFileSync(app.configPath, "utf8"), configText);
  });
}

test("missing pinned model warns and falls back to session model", async () => {
  const app = await setup({ pin, registryModel: null });
  app.handlers.input(input, app.ctx);
  app.finish();
  await flush();
  assert.equal(app.calls, 1);
  assert.equal(app.completionModel, app.ctx.model);
  assert.match(app.notifications[0].text, /trying the session model/);
  assert.equal(app.name, "[any] Short summary");
});

for (const failure of ["throw", "error", "empty"]) {
  test(`pinned model ${failure} falls back once`, async () => {
    const app = await setup({ pin, complete: async (model) => {
      if (model.provider === "session") return summary;
      if (failure === "throw") throw new Error("Missing credentials");
      return { stopReason: failure === "error" ? "error" : "stop", content: [] };
    } });
    app.handlers.input(input, app.ctx);
    await flush();
    assert.equal(app.calls, 2);
    assert.equal(app.notifications.length, 1);
    assert.equal(app.name, "[any] Pinned summary");
  });
}

test("pinned timeout starts a fresh fallback deadline and ignores late pinned output", async () => {
  let resolvePinned;
  const pinnedResult = new Promise((resolve) => { resolvePinned = resolve; });
  const app = await setup({ pin, complete: (model) => model.provider === "other" ? pinnedResult : Promise.resolve(summary) });
  app.handlers.input(input, app.ctx);
  app.expire();
  await flush();
  assert.equal(app.calls, 2);
  assert.equal(app.attempts[0].options.signal.aborted, true);
  assert.equal(app.attempts[1].options.signal.aborted, false);
  assert.equal(app.name, "[any] Pinned summary");
  resolvePinned({ stopReason: "stop", content: [{ type: "text", text: "Late" }] });
  await flush();
  assert.equal(app.name, "[any] Pinned summary");
});

test("both timeouts retain the temporary title", async () => {
  const app = await setup({ pin });
  app.handlers.input(input, app.ctx);
  app.expire();
  await flush();
  app.expire(1);
  await flush();
  app.finish();
  await flush();
  assert.equal(app.calls, 2);
  assert.equal(app.name, "[any] explain something");
});

test("does not retry a pin identical to the session model", async () => {
  const app = await setup({ pin, model: { provider: "other", id: "small" }, complete: async () => { throw new Error("Failed"); } });
  app.handlers.input(input, app.ctx);
  await flush();
  assert.equal(app.calls, 1);
  assert.match(app.notifications[0].text, /keeping the temporary title/);
});

test("pin works without a session model", async () => {
  const app = await setup({ pin, model: null });
  app.handlers.input(input, app.ctx);
  app.finish(summary);
  await flush();
  assert.equal(app.name, "[any] Pinned summary");
});

for (const cancel of ["session_shutdown", "session_start"]) {
  test(`${cancel} prevents pinned fallback`, async () => {
    const app = await setup({ pin });
    app.handlers.input(input, app.ctx);
    app.handlers[cancel]({}, app.ctx);
    await flush();
    assert.equal(app.calls, 1);
    assert.equal(app.notifications.length, 0);
  });
}

test("manual rename survives fallback completion", async () => {
  const app = await setup({ pin });
  app.handlers.input(input, app.ctx);
  app.expire();
  await flush();
  app.rename("Manual");
  app.finish(summary);
  await flush();
  assert.equal(app.name, "Manual");
});

test("unavailable pin status identifies the effective session model", async () => {
  const app = await setup({ pin, registryModel: null });
  await app.command("model");
  assert.match(app.notifications.at(-1).text, /pinned: other\/small; unavailable, session model: session\/current-model/);
});

test("both model failures keep the temporary title", async () => {
  const app = await setup({ pin, complete: async () => { throw new Error("Failed"); } });
  app.handlers.input(input, app.ctx);
  await flush();
  assert.equal(app.calls, 2);
  assert.equal(app.name, "[any] explain something");
});

test("invalid pin status warns and reports the effective session model", async () => {
  const app = await setup({ configText: "{broken" });
  await app.command("model");
  assert.equal(app.notifications[0].level, "warning");
  assert.match(app.notifications.at(-1).text, /follows session model: session\/current-model/);
  assert.equal(app.notifications.at(-1).level, "info");
  assert.equal(readFileSync(app.configPath, "utf8"), "{broken");
  assert.equal(app.calls, 0);
});
