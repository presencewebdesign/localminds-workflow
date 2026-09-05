import { Skill } from '../types';
import { NodeOutput } from './types';

export interface RunMetadata {
  workflowRunId: string;
  workflowName: string;
  offlineMode: boolean;
  model?: string;
}

/**
 * Structured run context. Templates are reserved namespaces only:
 * {{inputs.*}} {{nodes.<id>.output}} {{steps.<id>.output}}
 * {{join.output}} {{join.branches.<id>}} {{workflow.*}} {{last}}
 */
export class WorkflowContext {
  readonly inputs: Record<string, unknown> = {};
  readonly outputs = new Map<string, NodeOutput>();
  readonly metadata: RunMetadata;
  private lastId = '';
  private join: NodeOutput | undefined;
  private alwaysOn: Skill[] = [];

  constructor(metadata: RunMetadata) {
    this.metadata = metadata;
  }

  setAlwaysOn(skills: Skill[]): void {
    this.alwaysOn = skills;
  }

  alwaysOnText(): string {
    return this.alwaysOn
      .map((s) => `### ${s.name}\n${(s.body || '').trim()}`)
      .filter((s) => s.trim())
      .join('\n\n');
  }

  setOutput(nodeId: string, output: NodeOutput): void {
    this.outputs.set(nodeId, output);
    this.lastId = nodeId;
    if (output.branches) this.join = output;
  }

  getOutput(nodeId: string): NodeOutput | undefined {
    return this.outputs.get(nodeId);
  }

  lastText(): string {
    if (!this.lastId) return '';
    return this.outputs.get(this.lastId)?.text || '';
  }

  interpolate(template: string, locals: Record<string, string> = {}): string {
    if (!template) return '';
    return template.replace(/\{\{\s*([^}]+?)\s*\}\}/g, (match, exprRaw: string) => {
      const expr = exprRaw.trim();

      if (expr === 'last') return this.lastText();

      const nodeMatch = expr.match(/^(?:nodes|steps)\.([A-Za-z0-9_-]+)\.output$/);
      if (nodeMatch) {
        const out = this.outputs.get(nodeMatch[1]);
        return out ? out.text : match;
      }

      if (expr === 'join.output') {
        return this.join?.text ?? match;
      }

      const branchMatch = expr.match(/^join\.branches\.([A-Za-z0-9_-]+)$/);
      if (branchMatch) {
        const branch = this.join?.branches?.[branchMatch[1]];
        return branch ? branch.text : match;
      }

      const workflowMatch = expr.match(/^workflow\.(runId|name|model|offlineMode)$/);
      if (workflowMatch) {
        const key = workflowMatch[1];
        if (key === 'runId') return this.metadata.workflowRunId;
        if (key === 'name') return this.metadata.workflowName;
        if (key === 'model') return this.metadata.model || '';
        if (key === 'offlineMode') return this.metadata.offlineMode ? 'true' : 'false';
      }

      const inputMatch = expr.match(/^inputs\.([A-Za-z0-9_-]+)$/);
      if (inputMatch) {
        const value = locals[inputMatch[1]] ?? this.inputs[inputMatch[1]];
        return value === undefined || value === null ? match : String(value);
      }

      if (Object.prototype.hasOwnProperty.call(locals, expr)) {
        return locals[expr];
      }

      return match;
    });
  }
}
