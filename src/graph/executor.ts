import { alwaysOnSkills, resolveSkill } from '../adapter';
import { WorkflowHost } from '../ports';
import { Routing } from '../routing';
import { ProjectLibrary, Workflow } from '../types';
import { compileWorkflow } from './compiler';
import { WorkflowContext } from './context';
import { eventBase, GraphWorkflowEvent } from './events';
import { GraphScheduler } from './scheduler';
import { ApplyLock, runSkillNode } from './skill-runtime';
import {
  GraphIR,
  JoinNode,
  LoopNode,
  newRunId,
  nodeById,
  NodeError,
  NodeExecution,
  NodeOutput,
  SkillNode,
} from './types';

const DEFAULT_MAX_LOOP = 5;
const DEFAULT_CONCURRENCY = 4;

export interface GraphApprovalRequest {
  nodeId: string;
  title: string;
  preview: string;
}

export interface GraphExecutorHandlers {
  emit: (event: GraphWorkflowEvent) => void;
  requestApproval?: (req: GraphApprovalRequest) => Promise<boolean>;
  isCancelled?: () => boolean;
}

export interface GraphRunOptions {
  getRouting: () => Routing;
  library: ProjectLibrary;
}

/**
 * Drives the scheduler + skill runtime. Must not import UI / workflow-panel types.
 */
export class GraphExecutor {
  private abortController?: AbortController;
  private applyLock = new ApplyLock();

  constructor(
    private host: WorkflowHost,
    private log: (msg: string) => void = () => {},
  ) {}

  abort(): void {
    this.abortController?.abort();
  }

  async run(
    workflow: Workflow,
    handlers: GraphExecutorHandlers,
    options: GraphRunOptions,
  ): Promise<NodeExecution[]> {
    const workflowRunId = newRunId('wr');
    this.abortController = new AbortController();
    const emit = (event: Omit<GraphWorkflowEvent, 'workflowRunId' | 'timestamp'> & Record<string, unknown>) => {
      handlers.emit({ ...eventBase(workflowRunId), ...event } as GraphWorkflowEvent);
    };

    emit({ type: 'workflow.started', workflowName: workflow.name });

    const routing = options.getRouting();
    const ctx = new WorkflowContext({
      workflowRunId,
      workflowName: workflow.name,
      offlineMode: routing.offlineMode,
      model: routing.model,
    });
    ctx.setAlwaysOn(alwaysOnSkills(options.library));

    const graph = compileWorkflow(workflow);
    try {
      await this.runGraph(graph, ctx, handlers, options, emit, workflow.autoApply === true);
      const failed = [...this.lastExecutions.values()].find((e) => e.status === 'failed');
      if (failed?.error) {
        emit({ type: 'workflow.failed', error: failed.error });
      } else {
        emit({ type: 'workflow.completed' });
      }
      return [...this.lastExecutions.values()];
    } catch (err) {
      const error: NodeError = { message: err instanceof Error ? err.message : String(err) };
      emit({ type: 'workflow.failed', error });
      throw err;
    }
  }

  private lastExecutions = new Map<string, NodeExecution>();

  private async runGraph(
    graph: GraphIR,
    ctx: WorkflowContext,
    handlers: GraphExecutorHandlers,
    options: GraphRunOptions,
    emit: (event: Omit<GraphWorkflowEvent, 'workflowRunId' | 'timestamp'> & Record<string, unknown>) => void,
    autoApply: boolean,
  ): Promise<GraphScheduler> {
    const scheduler = new GraphScheduler(graph);
    this.lastExecutions = scheduler.executions;
    const limit = new ConcurrencyLimit(DEFAULT_CONCURRENCY);

    const cancelled = () =>
      !!handlers.isCancelled?.() || !!this.abortController?.signal.aborted;

    while (!scheduler.isSettled()) {
      if (cancelled()) {
        for (const exec of scheduler.executions.values()) {
          if (exec.status === 'pending' || exec.status === 'ready' || exec.status === 'running') {
            scheduler.cancel(exec.nodeId);
            emit({ type: 'node.cancelled', nodeId: exec.nodeId, nodeRunId: exec.nodeRunId });
          }
        }
        break;
      }

      scheduler.promoteReady();
      const ready = scheduler.ready();
      if (ready.length === 0) {
        if (scheduler.hasInFlight()) {
          await delay(25);
          continue;
        }
        for (const blocked of scheduler.cancelBlocked()) {
          emit({ type: 'node.cancelled', nodeId: blocked.nodeId, nodeRunId: blocked.nodeRunId });
        }
        if (!scheduler.isSettled()) break;
        continue;
      }

      await Promise.all(
        ready.map((exec) =>
          this.dispatchNode(graph, exec.nodeId, scheduler, ctx, handlers, options, emit, autoApply, limit, cancelled),
        ),
      );

      for (const blocked of scheduler.cancelBlocked()) {
        emit({ type: 'node.cancelled', nodeId: blocked.nodeId, nodeRunId: blocked.nodeRunId });
      }
    }

    return scheduler;
  }

  private async dispatchNode(
    graph: GraphIR,
    nodeId: string,
    scheduler: GraphScheduler,
    ctx: WorkflowContext,
    handlers: GraphExecutorHandlers,
    options: GraphRunOptions,
    emit: (event: Omit<GraphWorkflowEvent, 'workflowRunId' | 'timestamp'> & Record<string, unknown>) => void,
    autoApply: boolean,
    limit: ConcurrencyLimit,
    cancelled: () => boolean,
  ): Promise<void> {
    const node = nodeById(graph, nodeId);
    const exec = scheduler.get(nodeId);
    if (!node || !exec || exec.status !== 'ready') return;

    if (node.kind === 'join') {
      this.finishJoin(node, scheduler, ctx, emit);
      return;
    }

    if (node.kind === 'loop') {
      await this.runLoop(node, scheduler, ctx, handlers, options, emit, autoApply, cancelled);
      return;
    }

    await limit.run(() =>
      this.runSkill(node, scheduler, ctx, handlers, options, emit, autoApply, cancelled),
    );
  }

  private finishJoin(
    node: JoinNode,
    scheduler: GraphScheduler,
    ctx: WorkflowContext,
    emit: (event: Omit<GraphWorkflowEvent, 'workflowRunId' | 'timestamp'> & Record<string, unknown>) => void,
  ): void {
    const started = scheduler.start(node.id);
    emit({ type: 'node.started', nodeId: node.id, nodeRunId: started.nodeRunId, title: node.title });

    const branches: Record<string, NodeOutput> = {};
    const errors: string[] = [];
    let anyFailed = false;
    for (const branchId of node.branchIds) {
      const branch = scheduler.get(branchId);
      if (branch?.output) branches[branchId] = branch.output;
      if (branch?.status === 'failed' || branch?.status === 'cancelled') {
        anyFailed = true;
        if (branch.error) errors.push(`${branchId}: ${branch.error.message}`);
      }
    }

    const output: NodeOutput = {
      text: Object.entries(branches)
        .map(([id, out]) => `### ${id}\n${out.text}`)
        .join('\n\n'),
      branches,
      errors: errors.length ? errors : undefined,
    };
    ctx.setOutput(node.id, output);

    if (anyFailed && node.onError === 'fail') {
      scheduler.fail(node.id, { message: errors.join('; ') || 'A parallel branch failed' });
      emit({
        type: 'node.failed',
        nodeId: node.id,
        nodeRunId: started.nodeRunId,
        error: { message: errors.join('; ') || 'A parallel branch failed' },
      });
      return;
    }

    scheduler.complete(node.id, output);
    emit({ type: 'join.completed', nodeId: node.id, nodeRunId: started.nodeRunId });
    emit({ type: 'node.completed', nodeId: node.id, nodeRunId: started.nodeRunId, outputText: output.text });
  }

  private async runLoop(
    node: LoopNode,
    scheduler: GraphScheduler,
    ctx: WorkflowContext,
    handlers: GraphExecutorHandlers,
    options: GraphRunOptions,
    emit: (event: Omit<GraphWorkflowEvent, 'workflowRunId' | 'timestamp'> & Record<string, unknown>) => void,
    autoApply: boolean,
    cancelled: () => boolean,
  ): Promise<void> {
    const started = scheduler.start(node.id);
    emit({ type: 'node.started', nodeId: node.id, nodeRunId: started.nodeRunId, title: node.title });

    const loop = node.loop;
    const maxIterations = Math.max(
      1,
      loop.maxIterations || (loop.kind === 'count' ? loop.count || 1 : DEFAULT_MAX_LOOP),
    );
    let iterations = 0;
    let lastOutput = '';

    try {
      for (let i = 0; i < maxIterations; i++) {
        if (cancelled()) break;
        iterations = i + 1;
        emit({
          type: 'loop.iteration',
          nodeId: node.id,
          nodeRunId: started.nodeRunId,
          iteration: iterations,
        });
        const bodyScheduler = await this.runGraph(
          node.body,
          ctx,
          handlers,
          options,
          emit,
          autoApply,
        );
        this.lastExecutions = scheduler.executions;

        const failed = [...bodyScheduler.executions.values()].find((e) => e.status === 'failed');
        if (failed) {
          if (node.onError === 'fail') {
            throw new Error(failed.error?.message || `Loop body failed at ${failed.nodeId}`);
          }
        }

        const exits = node.body.nodes.filter(
          (n) => !node.body.edges.some((e) => e.from === n.id),
        );
        const lastExit = exits[exits.length - 1];
        lastOutput = (lastExit && ctx.getOutput(lastExit.id)?.text) || ctx.lastText();

        if (loop.kind === 'until') {
          const ok = await this.evaluateUntil(loop.untilCondition || '', lastOutput, options.getRouting());
          emit({
            type: 'log',
            message: `Loop "${node.id}" iteration ${iterations}: condition ${ok ? 'met' : 'not met'}`,
          });
          if (ok) break;
        }
      }

      const output: NodeOutput = { text: `Ran ${iterations} iteration(s)` };
      ctx.setOutput(node.id, output);
      scheduler.complete(node.id, output);
      emit({ type: 'node.completed', nodeId: node.id, nodeRunId: started.nodeRunId, outputText: output.text });
    } catch (err) {
      const error: NodeError = { message: err instanceof Error ? err.message : String(err) };
      scheduler.fail(node.id, error);
      emit({ type: 'node.failed', nodeId: node.id, nodeRunId: started.nodeRunId, error });
    }
  }

  private async runSkill(
    node: SkillNode,
    scheduler: GraphScheduler,
    ctx: WorkflowContext,
    handlers: GraphExecutorHandlers,
    options: GraphRunOptions,
    emit: (event: Omit<GraphWorkflowEvent, 'workflowRunId' | 'timestamp'> & Record<string, unknown>) => void,
    autoApply: boolean,
    cancelled: () => boolean,
  ): Promise<void> {
    const started = scheduler.start(node.id);
    emit({ type: 'node.started', nodeId: node.id, nodeRunId: started.nodeRunId, title: node.title });

    try {
      if (node.injectOnly) {
        const skill = resolveSkill(options.library, node.ref);
        if (!skill) throw new Error(`Skill "${node.ref}" not found`);
        const text = ctx.interpolate(skill.body, node.inputs || {});
        const output: NodeOutput = { text };
        ctx.setOutput(node.id, output);
        scheduler.complete(node.id, output);
        emit({ type: 'node.completed', nodeId: node.id, nodeRunId: started.nodeRunId, outputText: text });
        return;
      }

      const output = await runSkillNode({
        host: this.host,
        library: options.library,
        ctx,
        node,
        autoApply,
        getRouting: options.getRouting,
        signal: this.abortController?.signal,
        applyLock: this.applyLock,
        log: (message) => emit({ type: 'log', message: `Step "${node.id}": ${message}` }),
        handlers: {
          onToken: (token) =>
            emit({ type: 'node.token', nodeId: node.id, nodeRunId: started.nodeRunId, token }),
          onThinking: (token) =>
            emit({ type: 'node.thinking', nodeId: node.id, nodeRunId: started.nodeRunId, token }),
          onTool: (phase, toolCallId, tool, detail) => {
            if (phase === 'requested') {
              scheduler.waitForTool(node.id);
              emit({
                type: 'node.toolRequested',
                nodeId: node.id,
                nodeRunId: started.nodeRunId,
                toolCallId,
                tool,
                detail,
              });
            } else {
              scheduler.resumeRunning(node.id);
              emit({
                type: 'node.toolCompleted',
                nodeId: node.id,
                nodeRunId: started.nodeRunId,
                toolCallId,
                tool,
                detail,
              });
            }
          },
          onWaitingForApproval: () => {
            scheduler.waitForApproval(node.id);
            emit({ type: 'node.waitingForApproval', nodeId: node.id, nodeRunId: started.nodeRunId });
          },
          onResumed: () => scheduler.resumeRunning(node.id),
          requestApproval: handlers.requestApproval
            ? (preview) =>
                handlers.requestApproval!({ nodeId: node.id, title: node.title, preview })
            : undefined,
          isCancelled: cancelled,
        },
      });

      ctx.setOutput(node.id, output);
      if (output.errors?.includes('Skipped (not approved)')) {
        scheduler.fail(node.id, { message: 'Skipped (not approved)' });
        emit({
          type: 'node.failed',
          nodeId: node.id,
          nodeRunId: started.nodeRunId,
          error: { message: 'Skipped (not approved)' },
        });
        return;
      }
      scheduler.complete(node.id, output);
      emit({ type: 'node.completed', nodeId: node.id, nodeRunId: started.nodeRunId, outputText: output.text });
    } catch (err) {
      const error: NodeError = { message: err instanceof Error ? err.message : String(err) };
      scheduler.fail(node.id, error);
      emit({ type: 'node.failed', nodeId: node.id, nodeRunId: started.nodeRunId, error });
    }
  }

  private async evaluateUntil(condition: string, lastOutput: string, routing: Routing): Promise<boolean> {
    if (!condition.trim()) return true;
    try {
      const turn = await this.host.chat({
        system: 'You are a strict evaluator. Answer with only YES or NO.',
        user: `Condition: ${condition}\n\nLatest step output:\n${lastOutput.slice(0, 4000)}\n\nIs the condition satisfied? Answer YES or NO only.`,
        mode: 'ask',
        model: routing.model,
        offlineMode: routing.offlineMode,
        signal: this.abortController?.signal,
      });
      return /\byes\b/i.test(turn.raw.trim().slice(0, 10));
    } catch {
      return true;
    }
  }
}

class ConcurrencyLimit {
  private active = 0;
  private waiters: Array<() => void> = [];

  constructor(private max: number) {}

  async run<T>(fn: () => Promise<T>): Promise<T> {
    if (this.active >= this.max) {
      await new Promise<void>((resolve) => this.waiters.push(resolve));
    }
    this.active++;
    try {
      return await fn();
    } finally {
      this.active--;
      this.waiters.shift()?.();
    }
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
