import {
  GraphIR,
  NodeError,
  NodeExecution,
  NodeOutput,
  incoming,
  newRunId,
  nodeById,
} from './types';

/**
 * State machine over one Graph IR. Status transitions only — no model calls.
 * pending → ready → running → (waiting_for_tool | waiting_for_approval) → running
 *   → completed | failed | cancelled
 */
export class GraphScheduler {
  readonly executions = new Map<string, NodeExecution>();

  constructor(private readonly graph: GraphIR) {
    for (const node of graph.nodes) {
      this.executions.set(node.id, {
        nodeId: node.id,
        nodeRunId: newRunId('nr'),
        status: 'pending',
      });
    }
  }

  get(nodeId: string): NodeExecution | undefined {
    return this.executions.get(nodeId);
  }

  promoteReady(): NodeExecution[] {
    const newly: NodeExecution[] = [];
    for (const node of this.graph.nodes) {
      const exec = this.executions.get(node.id);
      if (!exec || exec.status !== 'pending') continue;
      const preds = incoming(this.graph, node.id);
      const predsReady = preds.every((edge) => {
        const pred = this.executions.get(edge.from);
        if (!pred) return false;
        if (pred.status === 'completed') return true;
        if (node.kind === 'join' && (pred.status === 'failed' || pred.status === 'cancelled')) {
          return true;
        }
        return false;
      });
      if (!predsReady) continue;
      exec.status = 'ready';
      newly.push(exec);
    }
    return newly;
  }

  start(nodeId: string): NodeExecution {
    const exec = this.require(nodeId);
    exec.status = 'running';
    exec.startedAt = Date.now();
    return exec;
  }

  waitForTool(nodeId: string): void {
    this.require(nodeId).status = 'waiting_for_tool';
  }

  waitForApproval(nodeId: string): void {
    this.require(nodeId).status = 'waiting_for_approval';
  }

  resumeRunning(nodeId: string): void {
    this.require(nodeId).status = 'running';
  }

  complete(nodeId: string, output: NodeOutput): NodeExecution {
    const exec = this.require(nodeId);
    exec.status = 'completed';
    exec.completedAt = Date.now();
    exec.output = output;
    return exec;
  }

  fail(nodeId: string, error: NodeError): NodeExecution {
    const exec = this.require(nodeId);
    exec.status = 'failed';
    exec.completedAt = Date.now();
    exec.error = error;
    return exec;
  }

  cancel(nodeId: string): NodeExecution {
    const exec = this.require(nodeId);
    exec.status = 'cancelled';
    exec.completedAt = Date.now();
    return exec;
  }

  /** Cancel pending/ready nodes whose predecessors already failed or cancelled. */
  cancelBlocked(): NodeExecution[] {
    const cancelled: NodeExecution[] = [];
    for (const node of this.graph.nodes) {
      const exec = this.executions.get(node.id);
      if (!exec || (exec.status !== 'pending' && exec.status !== 'ready')) continue;
      const preds = incoming(this.graph, node.id);
      const blocked = preds.some((edge) => {
        const pred = this.executions.get(edge.from);
        return pred?.status === 'failed' || pred?.status === 'cancelled';
      });
      if (blocked && node.kind !== 'join') {
        this.cancel(node.id);
        cancelled.push(exec);
      }
    }
    return cancelled;
  }

  isSettled(): boolean {
    return [...this.executions.values()].every((e) =>
      e.status === 'completed' || e.status === 'failed' || e.status === 'cancelled',
    );
  }

  hasInFlight(): boolean {
    return [...this.executions.values()].some((e) =>
      e.status === 'running' || e.status === 'waiting_for_tool' || e.status === 'waiting_for_approval',
    );
  }

  ready(): NodeExecution[] {
    return [...this.executions.values()].filter((e) => e.status === 'ready');
  }

  private require(nodeId: string): NodeExecution {
    const exec = this.executions.get(nodeId);
    if (!exec) throw new Error(`Unknown node ${nodeId}`);
    const node = nodeById(this.graph, nodeId);
    if (!node) throw new Error(`Unknown node ${nodeId}`);
    return exec;
  }
}
