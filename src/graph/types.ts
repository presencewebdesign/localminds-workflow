import { LoopConfig, StepOnError } from '../types';

export type NodeStatus =
  | 'pending'
  | 'ready'
  | 'running'
  | 'waiting_for_tool'
  | 'waiting_for_approval'
  | 'completed'
  | 'failed'
  | 'cancelled';

export interface NodeError {
  message: string;
}

export interface NodeOutput {
  text: string;
  applied?: string[];
  errors?: string[];
  branches?: Record<string, NodeOutput>;
}

export interface NodeExecution {
  nodeId: string;
  nodeRunId: string;
  status: NodeStatus;
  startedAt?: number;
  completedAt?: number;
  output?: NodeOutput;
  error?: NodeError;
}

export interface SkillNode {
  kind: 'skill';
  id: string;
  ref: string;
  title: string;
  input?: string;
  inputs?: Record<string, string>;
  /** Instruction steps: inject body into context, do not call a model. */
  injectOnly?: boolean;
}

export interface LoopNode {
  kind: 'loop';
  id: string;
  title: string;
  loop: LoopConfig;
  body: GraphIR;
  onError: StepOnError;
}

export interface JoinNode {
  kind: 'join';
  id: string;
  title: string;
  branchIds: string[];
  onError: StepOnError;
}

export type GraphNode = SkillNode | LoopNode | JoinNode;

export interface GraphEdge {
  from: string;
  to: string;
}

export interface GraphIR {
  nodes: GraphNode[];
  edges: GraphEdge[];
}

export function newRunId(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

export function nodeById(graph: GraphIR, id: string): GraphNode | undefined {
  return graph.nodes.find((n) => n.id === id);
}

export function incoming(graph: GraphIR, id: string): GraphEdge[] {
  return graph.edges.filter((e) => e.to === id);
}

export function outgoing(graph: GraphIR, id: string): GraphEdge[] {
  return graph.edges.filter((e) => e.from === id);
}

export function entryNodeIds(graph: GraphIR): string[] {
  const targets = new Set(graph.edges.map((e) => e.to));
  return graph.nodes.map((n) => n.id).filter((id) => !targets.has(id));
}
