# @localminds/workflow

[![License: MIT](https://img.shields.io/badge/License: MIT-blue.svg)](LICENSE)

Host-agnostic workflow execution for agent applications.

## Introduction

`@localminds/workflow` is a small TypeScript/Node.js engine for describing reusable
skills and running them as workflows. It is designed for LocalMinds, but it can
also be embedded in a CLI, web server, desktop app, CI job, or another Node.js
application.

The package separates three concerns:

```text
skills and workflow steps → graph compiler → graph executor → host-provided tools
```

The engine owns workflow orchestration. Your application owns the model provider,
filesystem, terminal, web search, memory, persistence, and user interface.

## What it does

- Compiles sequential, parallel, and looping workflow steps into Graph IR.
- Executes independent parallel branches and joins their results.
- Supports count-based and condition-based loops with iteration limits.
- Resolves skills, agents, prompts, and instructions through one adapter.
- Streams workflow, node, token, tool, approval, and failure events.
- Supports cancellation and approval before file or terminal operations.
- Keeps model and tool integrations host-injected through `WorkflowHost`.
- Runs in offline or online routing modes without importing a specific provider.

The engine does not include a model runtime, filesystem implementation,
terminal runner, web-search service, or persistence layer. Those stay
host-injected. For teams that do not want to build an authoring UI, the
package also ships a standalone browser CMS that writes workflow JSON.

## Installation

Install the published package:

```bash
npm install @localminds/workflow
```

For local development before publishing:

```bash
npm install ../localminds-workflow
```

Node.js 18 or newer is required.

## How to use it

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

Agents, prompts, and instructions can also be referenced by workflow steps. The
adapter maps them to the common skill runtime.

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

Parallel and loop steps can contain nested `steps`:

```ts
const workflow: Workflow = {
  id: 'research',
  slug: 'research',
  name: 'Research',
  steps: [
    {
      id: 'sources',
      type: 'parallel',
      steps: [
        { id: 'docs', type: 'skill', ref: 'summarize' },
        { id: 'notes', type: 'skill', ref: 'summarize' },
      ],
    },
    {
      id: 'refine',
      type: 'loop',
      loop: { kind: 'count', count: 2 },
      steps: [{ id: 'iteration', type: 'skill', ref: 'summarize' }],
    },
  ],
};
```

### 3. Implement the host boundary

The engine calls the `WorkflowHost` supplied by your application. The host
connects the workflow to your model provider, files, tools, and memory:

```ts
import type { WorkflowHost } from '@localminds/workflow';

// Implement this interface in the application that embeds the package.
const host: WorkflowHost = createWorkflowHost();
```

`createWorkflowHost` above represents an application-specific factory; the
package does not provide one. Implement the `WorkflowHost` interface directly or
adapt your existing application services to it.

### 4. Compile or execute the workflow

Use `compileWorkflow` when you only need the graph:

```ts
import { compileWorkflow } from '@localminds/workflow';

const graph = compileWorkflow(workflow);
console.log(graph.nodes);
console.log(graph.edges);
```

Use `GraphExecutor` to run it:

```ts
import {
  GraphExecutor,
  createRoutingSession,
  type GraphWorkflowEvent,
} from '@localminds/workflow';

const routing = createRoutingSession({
  offlineMode: true,
  localModel: 'gemma4:e4b',
});

const executor = new GraphExecutor(host, console.log);

const executions = await executor.run(
  workflow,
  {
    emit(event: GraphWorkflowEvent) {
      // Render these events in a CLI, browser UI, or desktop panel.
      console.log(event.type, event);
    },
    requestApproval: async ({ title, preview }) => {
      // Replace with a real confirmation dialog in the host application.
      console.log(`Approval required for ${title}\n${preview}`);
      return true;
    },
  },
  {
    library,
    getRouting: () => routing.get(),
  },
);

console.log(executions);
```

To cancel an active run, call:

```ts
executor.abort();
```

## Public API

Important exports include:

- `compileWorkflow` — converts a `Workflow` to `GraphIR`.
- `GraphExecutor` — executes a workflow and emits lifecycle events.
- `GraphScheduler` — manages node state transitions.
- `adaptEntityToSkill`, `resolveSkill`, `alwaysOnSkills` — entity compatibility helpers.
- `WorkflowContext` — stores outputs and interpolation state during a run.
- `createRoutingSession` — manages local/cloud model routing.
- `Workflow`, `ProjectLibrary`, `WorkflowHost`, and graph/event types.

## How to run the package

The package is a library, so it does not start a server or browser page by
itself. Run these commands from the repository when developing it:

```bash
npm install
npm run build
npm test
```

Additional development command:

```bash
npm run watch
```

`npm run build` writes compiled JavaScript and type declarations to `dist/`.
`npm test` builds first and then runs the compiled Node.js test files.

## Workflow CMS

If you do not want to hard-code workflows in TypeScript, run the standalone
CMS in any repo. It authors the same `ProjectLibrary` / `Workflow` JSON the
engine already compiles. It does not change the engine; it only reads and
writes `.localminds/` and calls `compileWorkflow` to validate.

From this package:

```bash
npm run studio
```

From another repo after installing the package:

```bash
npx localminds-workflow
npx localminds-workflow --root /path/to/repo
```

Then open [http://127.0.0.1:4174](http://127.0.0.1:4174). Create skills and
workflows, nest parallel / loop steps, and save. Files are written to:

```text
.localminds/library.json
.localminds/workflows/<slug>.json
```

Load those JSON files in your application and pass them to `compileWorkflow`
or `GraphExecutor` as usual.

## Live browser demo

This repository includes a mock host and a small browser UI that exercise the
real compiler and executor. It runs the sample graph:

```text
plan → parallel web + repo → join → review
```

Start it with:

```bash
npm run demo
```

Then open [http://127.0.0.1:4173](http://127.0.0.1:4173). Click **Run graph** to
watch node status changes and the event stream. Toggle **Offline** to skip the
mock web-search tool.

The demo uses mock services only; it does not call a real model, modify files,
run terminal commands, or access the public web.

## License

MIT
