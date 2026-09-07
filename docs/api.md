# API reference

The package exports the workflow compiler, runtime, routing helpers, and public
TypeScript types from `@localminds/workflow`.

## Compiler and runtime

- `compileWorkflow` — converts a `Workflow` into `GraphIR`.
- `GraphExecutor` — executes a workflow and emits lifecycle events.
- `GraphScheduler` — manages graph node state transitions.
- `WorkflowContext` — stores outputs and interpolation state during a run.

## Entity helpers

- `adaptEntityToSkill` — adapts an instruction, agent, prompt, or skill to the
  common skill runtime.
- `resolveSkill` — finds a reusable entity in a `ProjectLibrary`.
- `alwaysOnSkills` — returns skills configured for always-on injection.

## Routing

- `createRoutingSession` — manages the current local/cloud routing choice.
- `Routing` and `RoutingSession` — routing state types.

Routing selects a model id and offline flag. The host remains responsible for
calling the selected model provider. See the
[custom host guide](custom-host.md).

## Data and event types

The main exported types are:

- `Workflow`
- `WorkflowStep`
- `ProjectLibrary`
- `Instruction`
- `Agent`
- `Skill`
- `PromptTemplate`
- `WorkflowHost`
- `GraphIR`
- `GraphNode`
- `GraphEdge`
- `GraphWorkflowEvent`
- `NodeExecution`

Additional supporting types are exported for host requests and results, graph
nodes, loop configuration, agent tools, approval handling, and workflow events.

## Constants

- `SCHEMA_VERSION` — current project data schema version.
- `AGENT_TOOLS` — supported agent capability names.
