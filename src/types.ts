/**
 * Per-project workflow subsystem types.
 *
 * Entities (Instruction, Agent, Skill, Prompt) are the reusable building blocks
 * a project defines. A Workflow chains them into ordered steps that the engine
 * executes, with optional loops and step-to-step output passing.
 *
 * All of this is persisted under `.localminds/` at the workspace root so it is
 * committed with the repo and shared with the team.
 */

export type EntityKind = 'instruction' | 'agent' | 'skill' | 'prompt';

export const SCHEMA_VERSION = 1;

export interface BaseEntity {
  /** Filename without extension; stable id within its kind. */
  slug: string;
  name: string;
  description?: string;
  /** Optional user brief for AI-assisted prompt generation (not injected at runtime). */
  brief?: string;
  /** Markdown body (the actual instruction / prompt / system prompt text). */
  body: string;
}

/** How an instruction is brought into context during a workflow run. */
export type InstructionScope = 'always' | 'glob' | 'manual';

export interface Instruction extends BaseEntity {
  kind: 'instruction';
  scope: InstructionScope;
  /** Glob patterns this instruction applies to when scope === 'glob'. */
  globs?: string[];
}

/** Whether an agent produces answers (ask), file operations (agent), or a plan. */
export type AgentMode = 'ask' | 'agent' | 'plan';

/**
 * Capabilities an agent is allowed to use during an agent-mode turn.
 * `edit` = create/update/delete files, `terminal` = run commands,
 * `search` = request additional files, `memory` = persist repo memory,
 * `web` = search the web via Serper (only usable when a Serper key is set).
 */
export type AgentTool = 'edit' | 'terminal' | 'search' | 'memory' | 'web';

/** All known tools, in display order. */
export const AGENT_TOOLS: AgentTool[] = ['edit', 'terminal', 'search', 'memory', 'web'];

export interface Agent extends BaseEntity {
  kind: 'agent';
  mode: AgentMode;
  /** Optional per-agent model override (OpenRouter or Ollama model id). */
  model?: string;
  /**
   * When mode === 'plan', automatically persist step output to
   * `.localminds/research/{slug}-evidence-{date}.md` after each run.
   */
  saveToResearch?: boolean;
  /**
   * Allow-list of capabilities. When undefined, all tools are permitted
   * (backward compatible with agents authored before tool scoping existed).
   */
  tools?: AgentTool[];
}

/** How a skill enters a workflow run. `apply` is a v1 alias for this. */
export type SkillActivationMode = 'on-demand' | 'always' | 'glob';

export interface SkillActivation {
  mode: SkillActivationMode;
  /** Glob patterns when mode === 'glob'. */
  globs?: string[];
}

/**
 * Reusable capability. Agents, prompts, and instructions adapt into this shape.
 * `always` injects the body into every applicable workflow node — it does not
 * auto-invoke the skill from ambient chat.
 */
export interface Skill extends BaseEntity {
  kind: 'skill';
  mode?: AgentMode;
  tools?: AgentTool[];
  model?: string;
  activation?: SkillActivation;
  arguments?: PromptArgument[];
  saveToResearch?: boolean;
}

/** A research artifact persisted under `.localminds/research/`. */
export interface ResearchEntry {
  slug: string;
  name: string;
  description?: string;
  /** Agent slug that produced this entry. */
  agentSlug?: string;
  body: string;
}

export interface PromptArgument {
  name: string;
  description?: string;
  required?: boolean;
}

export interface PromptTemplate extends BaseEntity {
  kind: 'prompt';
  arguments?: PromptArgument[];
}

export type AnyEntity = Instruction | Agent | Skill | PromptTemplate;

export type WorkflowStepType = 'instruction' | 'agent' | 'skill' | 'prompt' | 'loop' | 'parallel';

export type StepOnError = 'fail' | 'continue';

export type LoopKind = 'count' | 'until';

export interface LoopConfig {
  kind: LoopKind;
  /** Number of iterations when kind === 'count'. */
  count?: number;
  /** Natural-language condition checked after each iteration when kind === 'until'. */
  untilCondition?: string;
  /** Hard cap on iterations regardless of kind (safety guard). */
  maxIterations?: number;
}

export interface WorkflowStep {
  /** Unique id within the workflow; used for output interpolation. */
  id: string;
  type: WorkflowStepType;
  /** Slug of the referenced entity. Required for non-loop steps. */
  ref?: string;
  /** Optional templated input / extra instructions for this step. */
  input?: string;
  /** Values for a prompt entity's arguments. */
  inputs?: Record<string, string>;
  /** Loop configuration when type === 'loop'. */
  loop?: LoopConfig;
  /** Nested steps executed inside a loop or parallel group. */
  steps?: WorkflowStep[];
  /** Parallel/loop failure policy. Default is fail (join/loop stops). */
  onError?: StepOnError;
}

export interface Workflow {
  /** Stable id (mirrors slug). */
  id: string;
  slug: string;
  name: string;
  description?: string;
  steps: WorkflowStep[];
  /** When true, agent/skill file operations are applied without manual approval. */
  autoApply?: boolean;
}

export interface ProjectConfig {
  schemaVersion: number;
  name?: string;
  createdAt: number;
}

/** Result of executing a single workflow step. */
export interface StepResult {
  stepId: string;
  type: WorkflowStepType;
  ref?: string;
  /** Captured text output (model response or instruction body). */
  output: string;
  /** Files applied for agent/skill steps. */
  applied?: string[];
  /** Errors encountered (apply failures, parse errors, etc.). */
  errors?: string[];
  /** For loop steps: results per iteration. */
  iterations?: StepResult[][];
}

/** Snapshot of everything defined in a project. */
export interface ProjectLibrary {
  instructions: Instruction[];
  agents: Agent[];
  skills: Skill[];
  prompts: PromptTemplate[];
  workflows: Workflow[];
}
