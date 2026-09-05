import { NodeError } from './types';

/** Immutable envelope. Consumers reconstruct a run from the stream alone. */
export interface WorkflowEventBase {
  workflowRunId: string;
  timestamp: number;
}

export type GraphWorkflowEvent =
  | (WorkflowEventBase & { type: 'workflow.started'; workflowName: string })
  | (WorkflowEventBase & { type: 'node.started'; nodeId: string; nodeRunId: string; title: string })
  | (WorkflowEventBase & { type: 'node.token'; nodeId: string; nodeRunId: string; token: string })
  | (WorkflowEventBase & { type: 'node.thinking'; nodeId: string; nodeRunId: string; token: string })
  | (WorkflowEventBase & {
      type: 'node.toolRequested';
      nodeId: string;
      nodeRunId: string;
      toolCallId: string;
      tool: string;
      detail?: string;
    })
  | (WorkflowEventBase & {
      type: 'node.toolCompleted';
      nodeId: string;
      nodeRunId: string;
      toolCallId: string;
      tool: string;
      detail?: string;
    })
  | (WorkflowEventBase & { type: 'node.waitingForApproval'; nodeId: string; nodeRunId: string })
  | (WorkflowEventBase & {
      type: 'node.completed';
      nodeId: string;
      nodeRunId: string;
      outputText: string;
    })
  | (WorkflowEventBase & {
      type: 'node.failed';
      nodeId: string;
      nodeRunId: string;
      error: NodeError;
    })
  | (WorkflowEventBase & { type: 'node.cancelled'; nodeId: string; nodeRunId: string })
  | (WorkflowEventBase & { type: 'join.completed'; nodeId: string; nodeRunId: string })
  | (WorkflowEventBase & {
      type: 'loop.iteration';
      nodeId: string;
      nodeRunId: string;
      iteration: number;
    })
  | (WorkflowEventBase & { type: 'workflow.completed' })
  | (WorkflowEventBase & { type: 'workflow.failed'; error: NodeError })
  | (WorkflowEventBase & { type: 'log'; message: string });

export function eventBase(workflowRunId: string): WorkflowEventBase {
  return { workflowRunId, timestamp: Date.now() };
}
