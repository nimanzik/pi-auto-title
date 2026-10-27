# pi-auto-title

A Pi extension that names a session from its first request. It sets a temporary
title immediately, then generates a short title in the background. Skill requests
keep their `[skill-name]` prefix. Existing or manually edited titles are preserved.

Load it with:

```sh
pi -e ./auto-title.ts
```

## Model selection

By default, title generation follows the current session model. To use a different
model without changing the model answering your requests:

```text
/auto-title model                      # show the effective model
/auto-title model <provider> <model>   # validate and save a model pin
/auto-title model reset                # follow the session model again
```

The pinned model must exist in Pi's model registry and have credentials configured.
New pins that fail either check are rejected without changing the saved pin.

The pin applies across projects and sessions using the same agent directory.
It is stored in `<agent-dir>/auto-title.json`, usually
`~/.pi/agent/auto-title.json`. Pi's `PI_CODING_AGENT_DIR` setting is respected.
You can also edit the file directly:

```json
{
  "provider": "your-provider",
  "model": "your-model-id"
}
```

Configuration is read for each title request and model-status command. Changes
affect future title requests, not a request already running or an already named
session. Reset deletes the configuration file.

If the pinned model is unavailable or fails, the extension warns and tries the
session model once, unless it is the same model. Invalid configuration also warns
and uses the session model, without overwriting the file. Fallback can send the
request to a different provider, with that provider's costs and data policies.
Warnings appear through Pi's notification UI when supported.

Each model attempt has a 15-second timeout, allowing up to 30 seconds with fallback.
The conversation is not blocked. If generation fails, the temporary title remains.
Switching sessions or shutting down cancels pending title generation.

## Tests

```sh
npm test
```
