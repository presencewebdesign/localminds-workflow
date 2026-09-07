# Custom host and model providers

Use this guide when embedding `@localminds/workflow` in your own CLI, web
server, desktop app, CI job, or Node.js service. If you use
[LocalMinds](https://localminds.io), the host and model integration are already
provided and this guide is not required.

## Implement `WorkflowHost`

The engine is deliberately host-agnostic. Your application supplies a
`WorkflowHost` implementation for:

- `chat` — send model requests and return `HostChatResult`.
- `gatherFiles` and `findFiles` — provide repository context.
- `webSearch` and `canWebSearch` — provide optional web search.
- `applyOperations` and `runCommand` — apply approved changes and run commands.
- `remember` and optional `saveResearch` — persist workflow memory.
- Prompt and policy helpers such as `agentSystemPrompt`,
  `buildSkillSystemPrompt`, `buildAgentUserPrompt`, `buildDiffPreview`,
  `applyToolPolicy`, and `buildToolRestrictionNote`.
- Documentation and planning helpers: `documentationNote` and
  `planResearchNote`.

The complete interface is exported as `WorkflowHost` and is defined in
[`src/ports.ts`](../src/ports.ts). LocalMinds implements this boundary for you.
Even a text-only `ask` or `plan` skill still needs a complete host object when
using the TypeScript API.

## Route local and cloud models

`createRoutingSession` only chooses a model id and an offline flag. It does not
call a provider and never reads API keys:

```ts
import { createRoutingSession } from '@localminds/workflow';

const routing = createRoutingSession({
  offlineMode: process.env.WORKFLOW_OFFLINE === '1',
  localModel: 'gemma4:e4b',
  cloudModel: 'openai/gpt-4o-mini',
});
```

A skill or agent `model` field overrides the session choice. Keep provider
secrets in the host environment or a secret manager, never in committed
`.localminds/` JSON.

## Local models with Ollama

Install [Ollama](https://ollama.com), pull a model, and keep
`offlineMode: true`:

```bash
ollama pull gemma4:e4b
```

Forward the request to Ollama from `host.chat`:

```ts
import type { HostChatRequest, HostChatResult } from '@localminds/workflow';

async function chatWithOllama(req: HostChatRequest): Promise<HostChatResult> {
  const res = await fetch('http://127.0.0.1:11434/api/chat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: req.model,
      stream: false,
      messages: [
        { role: 'system', content: req.system },
        { role: 'user', content: req.user },
      ],
    }),
    signal: req.signal,
  });

  if (!res.ok) {
    throw new Error(`Ollama request failed: ${res.status} ${res.statusText}`);
  }

  const data = await res.json();
  return { raw: data.message?.content ?? '' };
}
```

Any OpenAI-compatible local server works the same way: point `host.chat` at
that server's base URL. A typical local Ollama installation does not require an
API key.

## Cloud models with OpenRouter

Create an API key with your provider. For OpenRouter, use
[openrouter.ai/keys](https://openrouter.ai/keys), then export the key in the
host process:

```bash
export OPENROUTER_API_KEY=sk-or-...
```

Set `offlineMode: false` and choose a provider model id:

```ts
import type { HostChatRequest, HostChatResult } from '@localminds/workflow';

async function chatWithOpenRouter(req: HostChatRequest): Promise<HostChatResult> {
  const key = process.env.OPENROUTER_API_KEY;
  if (!key) {
    throw new Error('Set OPENROUTER_API_KEY in the host environment.');
  }

  const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${key}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: req.model,
      messages: [
        { role: 'system', content: req.system },
        { role: 'user', content: req.user },
      ],
    }),
    signal: req.signal,
  });

  if (!res.ok) {
    throw new Error(`OpenRouter request failed: ${res.status} ${res.statusText}`);
  }

  const data = await res.json();
  return { raw: data.choices?.[0]?.message?.content ?? '' };
}
```

A typical host switches on the routing flag:

```ts
async chat(req: HostChatRequest): Promise<HostChatResult> {
  return req.offlineMode
    ? chatWithOllama(req)
    : chatWithOpenRouter(req);
}
```

OpenAI, Anthropic, Azure, Google, and other gateways follow the same pattern:
read their key from the environment and implement `chat`.

## Approvals and automatic changes

The executor can request approval before applying file operations or running
terminal commands. Always show the generated preview to the user:

```ts
requestApproval: async ({ title, preview }) => {
  return confirmationDialog({
    title,
    message: preview,
  });
}
```

Never return `true` unconditionally in production. Setting
`workflow.autoApply = true` bypasses manual approval and should only be used
when the host intentionally trusts the workflow and its tools.

## Studio and secrets

Studio authors and validates workflow JSON, and can preview-run skills through
`GraphExecutor`. It does not collect API keys. If Ollama is running locally,
Studio uses it; otherwise it uses a mock host. File operations are never
applied from Studio. Put cloud keys in [LocalMinds](https://localminds.io)
settings or in the host application that constructs `WorkflowHost`.
