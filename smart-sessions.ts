import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const skillPattern = /^\/skill:(\S+)\s*([\s\S]*)/;

const SUMMARY_PROMPT =
  "Write a short title (5-8 words) for this request. Output only the title, no quotes, no trailing period.";

export default function (pi: ExtensionAPI) {
  let named = false;
  let pending: AbortController | undefined;

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
    if (!match) return;

    const skillName = match[1];
    const userPrompt = match[2].trim();
    named = true;

    if (!userPrompt) {
      pi.setSessionName(`[${skillName}]`);
      return;
    }

    const temporaryName = `[${skillName}] ${userPrompt.slice(0, 60)}`;
    pi.setSessionName(temporaryName);

    const sessionId = ctx.sessionManager.getSessionId();
    const task = new AbortController();
    pending = task;
    const signal = AbortSignal.any([task.signal, AbortSignal.timeout(15_000)]);

    // Pi awaits input handlers, so do not return this promise.
    void (async () => {
      try {
        const model = ctx.model;
        if (!model || signal.aborted) return;

        const response = await ctx.modelRegistry.complete(
          model,
          {
            systemPrompt: SUMMARY_PROMPT,
            messages: [{ role: "user", content: [{ type: "text", text: userPrompt }], timestamp: Date.now() }],
          },
          { signal, maxTokens: 64 },
        );
        if (response.stopReason !== "stop") return;

        const summary = response.content
          .filter((c): c is { type: "text"; text: string } => c.type === "text")
          .map((c) => c.text)
          .join("")
          .replace(/\s+/g, " ")
          .trim();

        if (summary && !signal.aborted && pending === task &&
            ctx.sessionManager.getSessionId() === sessionId && pi.getSessionName() === temporaryName) {
          pi.setSessionName(`[${skillName}] ${summary}`.slice(0, 80).trim());
        }
      } catch {
        // Keep the temporary or manually edited name on failure.
      } finally {
        if (pending === task) pending = undefined;
      }
    })();
  });
}
