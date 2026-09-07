# @localminds/workflow

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

Host-agnostic workflow execution for agent applications — use it with
[LocalMinds](https://localminds.io) or your own Node.js host.

## What it is

`@localminds/workflow` is a TypeScript/Node.js engine for describing reusable
skills and running them as workflows. It compiles workflow steps into a graph,
executes sequential, parallel, and looping steps, and emits lifecycle events.

```text
skills and workflow steps → graph compiler → graph executor → host-provided tools
```

The engine owns orchestration. Your application or LocalMinds owns the model
provider, filesystem, terminal, web search, memory, persistence, and UI.

## Choose your setup

### Recommended: LocalMinds

[LocalMinds](https://localminds.io) provides the `WorkflowHost`, local and cloud
model routing, tools, approvals, and workflow UI.

1. Install the LocalMinds VS Code extension.
2. Choose a local or cloud model in LocalMinds settings.
3. Open the Command Palette and run **Project Workflows**.

No manual host implementation is required.

### Author workflows with Studio

Studio is a standalone browser CMS for creating skills and workflows without
writing TypeScript. It saves committed workflow JSON under `.localminds/`.

From another repository:

```bash
npm install @localminds/workflow
npx localminds-workflow --root .
```

Then open [http://127.0.0.1:4174](http://127.0.0.1:4174).

### Embed the engine in your application

Install the package, define a `ProjectLibrary` and `Workflow`, and implement
the `WorkflowHost` boundary. See the [custom host guide](docs/custom-host.md)
for model routing, Ollama, OpenRouter, approvals, and host requirements.

### Try the included demo

From a checkout of this repository:

```bash
npm install
npm run demo
```

Open [http://127.0.0.1:4173](http://127.0.0.1:4173). The demo uses mock
services only; it does not call a real model or modify files.

## Installation

Node.js 18 or newer is required.

```bash
npm install @localminds/workflow
```

For local development before publishing:

```bash
npm install ../localminds-workflow
```

## Minimal usage

### 1. Define a project library

A library contains the reusable entities referenced by workflow steps:

```ts
import type { ProjectLibrary } from '@localminds/workflow';

const library: ProjectLibrary = {
  instructions: [],
  agents: [],
  prompts: [],
  skills: [
    {
      kind: 'skill',
      slug: 'summarize',
      name: 'Summarize',
      body: 'Summarize the supplied project context in five concise bullet points.',
      mode: 'ask',
      activation: { mode: 'on-demand' },
    },
  ],
  workflows: [],
};
```

### 2. Define a workflow

```ts
import type { Workflow } from '@localminds/workflow';

const workflow: Workflow = {
  id: 'project-summary',
  slug: 'project-summary',
  name: 'Project summary',
  steps: [
    { id: 'summary', type: 'skill', ref: 'summarize' },
  ],
};
```

Use `type: 'parallel'` or `type: 'loop'` with nested `steps` for fan-out or
repeated work.

### 3. Compile or execute

Use `compileWorkflow` when you only need the graph:

```ts
import { compileWorkflow } from '@localminds/workflow';

const graph = compileWorkflow(workflow);
console.log(graph.nodes, graph.edges);
```

To execute, provide a `WorkflowHost` implementation. `createWorkflowHost()` is
an application-specific placeholder; the package does not provide that factory.

```ts
import {
  GraphExecutor,
  createRoutingSession,
  type GraphWorkflowEvent,
  type WorkflowHost,
} from '@localminds/workflow';

const host: WorkflowHost = createWorkflowHost();
const routing = createRoutingSession({
  offlineMode: true,
  localModel: 'gemma4:e4b',
});

const executor = new GraphExecutor(host);
await executor.run(
  workflow,
  {
    emit(event: GraphWorkflowEvent) {
      console.log(event.type, event);
    },
    requestApproval: async ({ title, preview }) => {
      // Demo default: reject changes until the host has a confirmation UI.
      console.log(`Approval required for ${title}\n${preview}`);
      return false;
    },
  },
  { library, getRouting: () => routing.get() },
);
```

> **Safety:** Never auto-approve file changes or terminal commands in
> production. Show the preview in a confirmation dialog and return the user's
> decision. Only set `workflow.autoApply` to `true` when those operations are
> intentionally trusted.

Cancel an active run with `executor.abort()`.

## Models and providers

The engine is model-provider agnostic. It does not ship a provider SDK or read
API keys. LocalMinds handles this integration for you. Custom hosts can connect
`host.chat` to Ollama, OpenRouter, OpenAI, Anthropic, or another gateway.

See the [custom host guide](docs/custom-host.md) for provider examples. Keep
secrets in the host environment or a secret manager, never in committed
`.localminds/` JSON.

## API and development

Important exports include `compileWorkflow`, `GraphExecutor`, `GraphScheduler`,
`WorkflowContext`, `createRoutingSession`, `Workflow`, `ProjectLibrary`,
`WorkflowHost`, and graph/event types.

- [API reference](docs/api.md)
- [Custom host and model guide](docs/custom-host.md)
- [Development, Studio, and demo guide](docs/development.md)

## License

MIT
