import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { getAgentDir, type ExtensionAPI } from "@earendil-works/pi-coding-agent";

const skillPattern = /^\/skill:(\S+)\s*([\s\S]*)/;

const SUMMARY_PROMPT =
  "Write a short title (5-8 words) for this request. Output only the title, no quotes, no trailing period.";

type ModelPin = { provider: string; model: string };

function readPin(path: string): ModelPin | undefined {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  const pin = JSON.parse(text);
  if (!pin || typeof pin.provider !== "string" || !pin.provider.trim() ||
      typeof pin.model !== "string" || !pin.model.trim()) {
    throw new Error(`Invalid model pin in ${path}: expected provider and model strings`);
  }
  return { provider: pin.provider.trim(), model: pin.model.trim() };
}

export default function (pi: ExtensionAPI) {
  let named = false;
  let pending: AbortController | undefined;
  const configPath = join(getAgentDir(), "auto-title.json");

  pi.registerCommand("auto-title", {
    description: "Show, pin, or reset the title-generation model",
    handler: async (args, ctx) => {
      const parts = args.trim().split(/\s+/);
      try {
        if (parts.length === 1 && parts[0] === "model") {
          let pin: ModelPin | undefined;
          try {
            pin = readPin(configPath);
          } catch {
            ctx.ui.notify(`Auto-title: cannot read ${configPath}; using the session model`, "warning");
          }
          const model = pin ? ctx.modelRegistry.find(pin.provider, pin.model) : ctx.model;
          const available = model && ctx.modelRegistry.hasConfiguredAuth(model);
          ctx.ui.notify(pin
            ? `Auto-title pinned: ${pin.provider}/${pin.model}${available ? "" : `; unavailable, session model: ${ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : "none"}`}`
            : `Auto-title follows session model: ${model ? `${model.provider}/${model.id}` : "none"}`, "info");
        } else if (parts.length === 2 && parts[0] === "model" && parts[1] === "reset") {
          rmSync(configPath, { force: true });
          ctx.ui.notify("Auto-title now follows the session model", "info");
        } else if (parts.length === 3 && parts[0] === "model") {
          const [, provider, id] = parts;
          const model = ctx.modelRegistry.find(provider, id);
          if (!model) throw new Error(`Unknown model: ${provider}/${id}`);
          if (!ctx.modelRegistry.hasConfiguredAuth(model)) throw new Error(`No credentials configured for ${provider}/${id}`);
          mkdirSync(getAgentDir(), { recursive: true });
          const temporaryPath = `${configPath}.${randomUUID()}.tmp`;
          try {
            writeFileSync(temporaryPath, JSON.stringify({ provider, model: id }, null, 2) + "\n", { flag: "wx" });
            renameSync(temporaryPath, configPath);
          } finally {
            rmSync(temporaryPath, { force: true });
          }
          ctx.ui.notify(`Auto-title pinned to ${provider}/${id}`, "info");
        } else {
          ctx.ui.notify("Usage: /auto-title model [<provider> <model> | reset]", "info");
        }
      } catch (error) {
        ctx.ui.notify(`Auto-title: ${error instanceof Error ? error.message : String(error)}`, "error");
      }
    },
  });

  pi.on("session_start", () => {
    pending?.abort();
    pending = undefined;
    named = !!pi.getSessionName();
  });

  pi.on("session_shutdown", () => {
    pending?.abort();
    pending = undefined;
  });

  pi.on("input", (event, ctx) => {
    if (named || pi.getSessionName()) return;

    const match = event.text.match(skillPattern);
    const prefix = match ? `[${match[1]}] ` : "";
    const userPrompt = (match ? match[2] : event.text).trim();

    if (!userPrompt && !match) return;
    named = true;

    if (!userPrompt) {
      pi.setSessionName(prefix.trim());
      return;
    }

    const temporaryName = `${prefix}${userPrompt.slice(0, 60)}`;
    pi.setSessionName(temporaryName);

    const sessionId = ctx.sessionManager.getSessionId();
    const task = new AbortController();
    pending = task;

    // Pi awaits input handlers, so do not return this promise.
    void (async () => {
      try {
        let pin: ModelPin | undefined;
        try {
          pin = readPin(configPath);
        } catch {
          ctx.ui.notify(`Auto-title: cannot read ${configPath}; using the session model`, "warning");
        }
        const sessionModel = ctx.model;
        const models = pin ? [ctx.modelRegistry.find(pin.provider, pin.model)] : [];
        if (!pin || sessionModel?.provider !== pin.provider || sessionModel?.id !== pin.model) {
          models.push(sessionModel);
        }
        for (const [index, model] of models.entries()) {
          if (task.signal.aborted) return;
          const signal = AbortSignal.any([task.signal, AbortSignal.timeout(15_000)]);
          let onAbort: (() => void) | undefined;
          try {
            if (!model) throw new Error("Model unavailable");
            signal.throwIfAborted();
            const response = await Promise.race([
              ctx.modelRegistry.complete(
                model,
                {
                  systemPrompt: SUMMARY_PROMPT,
                  messages: [{ role: "user", content: [{ type: "text", text: userPrompt }], timestamp: Date.now() }],
                },
                { signal, maxTokens: 64 },
              ),
              new Promise<never>((_, reject) => {
                onAbort = () => reject(signal.reason);
                signal.addEventListener("abort", onAbort, { once: true });
                if (signal.aborted) onAbort();
              }),
            ]);
            signal.throwIfAborted();
            if (response.stopReason !== "stop") throw new Error("Title generation failed");
            const summary = response.content
              .filter((c): c is { type: "text"; text: string } => c.type === "text")
              .map((c) => c.text)
              .join("")
              .replace(/\s+/g, " ")
              .trim();
            if (!summary) throw new Error("Empty title");

            if (pending === task && ctx.sessionManager.getSessionId() === sessionId &&
                pi.getSessionName() === temporaryName) {
              pi.setSessionName(`${prefix}${summary}`.slice(0, 80).trim());
            }
            return;
          } catch {
            if (task.signal.aborted) return;
            if (pin && index === 0) {
              ctx.ui.notify(`Auto-title: pinned model ${pin.provider}/${pin.model} failed; ${models.length > 1 && sessionModel ? "trying the session model" : "keeping the temporary title"}`, "warning");
            }
          } finally {
            if (onAbort) signal.removeEventListener("abort", onAbort);
          }
        }
      } catch {
        // Keep the temporary or manually edited name on failure.
      } finally {
        if (pending === task) pending = undefined;
      }
    })();
  });
}
