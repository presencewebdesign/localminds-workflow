# @localminds/workflow

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

**Skills describe capability. Graphs describe execution. The host provides intelligence and tools.**

Host-agnostic agent workflow engine for the [LocalMinds](https://localminds.io) ecosystem — the same role [MindGraph](https://www.npmjs.com/package/@localminds/mindgraph) plays for memory.

```text
Skill / Parallel / Loop  →  compile  →  Graph IR  →  executor  →  WorkflowHost
```

The package never imports VS Code, Ollama, or Serper. Your app implements `WorkflowHost`.

```bash
npm install @localminds/workflow
```

## Quick start

```ts
import { compileWorkflow, GraphExecutor, type WorkflowHost } from '@localminds/workflow';

const host: WorkflowHost = {
  // chat, gatherFiles, webSearch, applyOperations, runCommand, remember, …
};

const executor = new GraphExecutor(host);
await executor.run(workflow, { emit: console.log }, {
  library,
  getRouting: () => ({ offlineMode: true, model: 'gemma4:e4b' }),
});
```

## What lives here

| Module | Role |
|---|---|
| `Skill` / adapter | One capability primitive; leftover agents/prompts/instructions map in |
| Block tree → Graph IR | Compiler generates `JoinNode`; UI never sees join |
| Scheduler | State machine: pending → ready → running → completed / failed |
| Executor | Parallel fan-out/fan-in, loops, cancellation, run/node/tool IDs |
| `WorkflowHost` | Injected model + tools + files + memory |

## What stays in the host

LocalMinds (or your CLI / CI runner) owns:

- Model routing (local vs cloud)
- File apply + terminal
- Web search
- Memory (e.g. MindGraph)
- Persistence (`.localminds/` or your own store)
- UI

## Status

`0.1.0` — extracted from LocalMinds. Consume via `file:../localminds-workflow` until published to npm.
