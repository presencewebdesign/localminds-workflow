import { Workflow, WorkflowStep } from '../types';
import { GraphEdge, GraphIR, GraphNode, JoinNode, LoopNode, SkillNode } from './types';

/**
 * Compile a persisted block tree into Graph IR.
 * Parallel groups become sibling skill/loop nodes plus a generated JoinNode.
 * The UI never sees join.
 */
export function compileWorkflow(workflow: Workflow): GraphIR {
  return compileSteps(workflow.steps || []);
}

function compileSteps(steps: WorkflowStep[]): GraphIR {
  const nodes: GraphNode[] = [];
  const edges: GraphEdge[] = [];
  let prevIds: string[] = [];

  const linkFromPrev = (targetId: string) => {
    if (prevIds.length === 0) return;
    for (const from of prevIds) {
      edges.push({ from, to: targetId });
    }
  };

  for (const step of steps) {
    if (step.type === 'loop') {
      const body = compileSteps(step.steps || []);
      const node: LoopNode = {
        kind: 'loop',
        id: step.id,
        title: loopTitle(step),
        loop: step.loop || { kind: 'count', count: 1 },
        body,
        onError: step.onError || 'fail',
      };
      nodes.push(node);
      linkFromPrev(node.id);
      prevIds = [node.id];
      continue;
    }

    if (step.type === 'parallel') {
      const children = step.steps || [];
      const branchIds: string[] = [];
      for (const child of children) {
        const childGraph = compileSteps([child]);
        nodes.push(...childGraph.nodes);
        edges.push(...childGraph.edges);
        const entries = childGraph.nodes
          .map((n) => n.id)
          .filter((id) => !childGraph.edges.some((e) => e.to === id));
        const exits = childGraph.nodes
          .map((n) => n.id)
          .filter((id) => !childGraph.edges.some((e) => e.from === id));
        for (const entry of entries) linkFromPrev(entry);
        branchIds.push(...(exits.length ? exits : entries));
      }
      const join: JoinNode = {
        kind: 'join',
        id: `${step.id}__join`,
        title: `Join: ${step.id}`,
        branchIds,
        onError: step.onError || 'fail',
      };
      nodes.push(join);
      for (const branchId of branchIds) {
        edges.push({ from: branchId, to: join.id });
      }
      prevIds = [join.id];
      continue;
    }

    const node: SkillNode = {
      kind: 'skill',
      id: step.id,
      ref: step.ref || '',
      title: `${capitalize(step.type)}: ${step.ref || step.id}`,
      input: step.input,
      inputs: step.inputs,
      injectOnly: step.type === 'instruction',
    };
    nodes.push(node);
    linkFromPrev(node.id);
    prevIds = [node.id];
  }

  return { nodes, edges };
}

function loopTitle(step: WorkflowStep): string {
  const loop = step.loop;
  return loop?.kind === 'until'
    ? `Loop until: ${loop.untilCondition || 'condition'}`
    : `Loop ${loop?.count ?? 1}x`;
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}
