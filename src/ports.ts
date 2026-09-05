import { AgentTool } from './types';

export interface HostFile {
  path: string;
  content: string;
  isActive?: boolean;
  isPinned?: boolean;
  language?: string;
}

export interface HostFileOperation {
  type: 'create' | 'update' | 'delete';
  path: string;
  content?: string;
  edits?: Array<{ old_string: string; new_string: string }>;
  reason?: string;
}

export interface HostRunCommand {
  command: string;
  reason?: string;
}

export interface HostWebSearch {
  query: string;
  reason?: string;
}

export interface HostMemoryNote {
  category: string;
  title: string;
  content: string;
}

export interface HostAgentResponse {
  summary: string;
  operations: HostFileOperation[];
  run_commands?: HostRunCommand[];
  request_files?: { patterns: string[]; reason?: string };
  web_searches?: HostWebSearch[];
  remember?: HostMemoryNote[];
}

export interface HostChatRequest {
  system: string;
  user: string;
  mode: 'ask' | 'plan' | 'agent';
  model?: string;
  offlineMode: boolean;
  signal?: AbortSignal;
  onToken?: (token: string) => void;
  onThinking?: (token: string) => void;
}

export interface HostChatResult {
  raw: string;
  response?: HostAgentResponse;
  parseError?: string;
}

export interface HostApplyResult {
  applied: string[];
  errors: string[];
  warnings: string[];
}

export interface HostPromptExtras {
  webSearchResults?: string;
  requestFilesFeedback?: string;
}

export interface HostResearchRequest {
  stepId: string;
  skillSlug: string;
  skillName: string;
  output: string;
  workflowName: string;
}

/**
 * Host-supplied I/O. The package never imports vscode, Ollama, or Serper.
 * LocalMinds (or any other app) implements this.
 */
export interface WorkflowHost {
  chat(req: HostChatRequest): Promise<HostChatResult>;
  gatherFiles(query: string): Promise<HostFile[]>;
  findFiles(patterns: string[], exclude: Set<string>): Promise<HostFile[]>;
  webSearch(query: string): Promise<string>;
  canWebSearch(offlineMode: boolean): boolean;
  applyOperations(ops: HostFileOperation[]): Promise<HostApplyResult>;
  runCommand(command: string): Promise<string>;
  remember(notes: HostMemoryNote[], runId: string): Promise<void>;
  saveResearch?(req: HostResearchRequest): Promise<void>;
  agentSystemPrompt(): string;
  buildSkillSystemPrompt(skill: { name: string; body: string }): string;
  buildAgentUserPrompt(request: string, files: HostFile[], extras?: HostPromptExtras): string;
  buildDiffPreview(ops: HostFileOperation[], commands?: HostRunCommand[]): string;
  applyToolPolicy(
    response: HostAgentResponse,
    tools?: AgentTool[],
  ): { response: HostAgentResponse; removed: string[] };
  buildToolRestrictionNote(tools?: AgentTool[]): string;
  documentationNote(request: string): string;
  planResearchNote(): string;
}
