import { resolveSkill } from '../adapter';
import { WorkflowHost, HostAgentResponse, HostFile } from '../ports';
import { ProjectLibrary, Skill } from '../types';
import { Routing } from '../routing';
import { WorkflowContext } from './context';
import { NodeOutput, newRunId, SkillNode } from './types';

const MAX_TOOL_ROUNDS = 6;

export class ApplyLock {
  private tail = Promise.resolve();

  run<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.tail.then(fn, fn);
    this.tail = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  }
}

export interface SkillRuntimeHandlers {
  onToken?: (token: string) => void;
  onThinking?: (token: string) => void;
  onTool?: (phase: 'requested' | 'completed', toolCallId: string, tool: string, detail?: string) => void;
  onWaitingForApproval?: () => void;
  onResumed?: () => void;
  requestApproval?: (preview: string) => Promise<boolean>;
  isCancelled?: () => boolean;
}

export interface SkillRuntimeOptions {
  host: WorkflowHost;
  library: ProjectLibrary;
  ctx: WorkflowContext;
  node: SkillNode;
  autoApply: boolean;
  getRouting: () => Routing;
  signal?: AbortSignal;
  applyLock: ApplyLock;
  handlers: SkillRuntimeHandlers;
  log: (msg: string) => void;
}

export async function runSkillNode(opts: SkillRuntimeOptions): Promise<NodeOutput> {
  const skill = resolveSkill(opts.library, opts.node.ref);
  if (!skill) {
    throw new Error(`Skill "${opts.node.ref}" not found`);
  }

  if (opts.node.injectOnly) {
    const body = opts.ctx.interpolate(skill.body, opts.node.inputs || {});
    return { text: body };
  }

  const locals = { ...(opts.node.inputs || {}) };
  const routing = opts.getRouting();
  const mode = skill.mode || 'agent';

  if (mode === 'ask' || mode === 'plan') {
    return runTextSkill(opts, skill, locals, routing);
  }

  return runAgentSkill(opts, skill, locals, routing);
}

function composeSystem(base: string, ctx: WorkflowContext, extra = ''): string {
  const always = ctx.alwaysOnText();
  const parts = [base];
  if (always) {
    parts.push(`---\n## Project skills (injected into every node)\n${always}`);
  }
  if (extra) parts.push(extra);
  return parts.join('\n\n');
}

async function runTextSkill(
  opts: SkillRuntimeOptions,
  skill: Skill,
  locals: Record<string, string>,
  routing: Routing,
): Promise<NodeOutput> {
  let body = opts.ctx.interpolate(skill.body, locals);
  if (skill.mode === 'plan' && skill.saveToResearch) {
    body = `${body}\n\n${opts.host.planResearchNote()}`;
  }
  const extra = opts.node.input ? `\n\n${opts.ctx.interpolate(opts.node.input, locals)}` : '';
  const request = skill.arguments?.length
    ? extra.trim() || opts.ctx.interpolate('Proceed.', locals)
    : opts.ctx.interpolate(opts.node.input || body, locals) || body;
  const userPrompt = skill.arguments?.length ? body + extra : request;

  const turn = await opts.host.chat({
    system: composeSystem(body, opts.ctx),
    user: userPrompt,
    mode: skill.mode === 'plan' ? 'plan' : 'ask',
    model: skill.model || routing.model,
    offlineMode: routing.offlineMode,
    signal: opts.signal,
    onToken: opts.handlers.onToken,
    onThinking: opts.handlers.onThinking,
  });

  if (skill.mode === 'plan' && skill.saveToResearch && turn.raw.trim()) {
    await opts.host.saveResearch?.({
      stepId: opts.node.id,
      skillSlug: skill.slug,
      skillName: skill.name,
      output: turn.raw,
      workflowName: opts.ctx.metadata.workflowName,
    });
  }

  return { text: turn.raw };
}

async function runAgentSkill(
  opts: SkillRuntimeOptions,
  skill: Skill,
  locals: Record<string, string>,
  routing: Routing,
): Promise<NodeOutput> {
  const request = opts.ctx.interpolate(opts.node.input || 'Apply this skill.', locals);
  const restriction = opts.host.buildToolRestrictionNote(skill.tools);
  const docsNote = opts.host.documentationNote(request);
  const skillSystem = opts.host.buildSkillSystemPrompt(skill);
  const system = composeSystem(
    `${skillSystem}${restriction ? `\n\n${restriction}` : ''}${docsNote}`,
    opts.ctx,
  );

  let files = await opts.host.gatherFiles(request);
  const seenPaths = new Set(files.map((f) => f.path));
  let extras: { webSearchResults?: string; requestFilesFeedback?: string } = {};
  let lastText = '';
  let applied: string[] = [];
  const errors: string[] = [];

  for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
    if (opts.handlers.isCancelled?.() || opts.signal?.aborted) {
      throw new Error('Cancelled');
    }

    const userPrompt = opts.host.buildAgentUserPrompt(request, files, extras);
    extras = {};

    const turn = await opts.host.chat({
      system,
      user: userPrompt,
      mode: 'agent',
      model: skill.model || opts.getRouting().model,
      offlineMode: opts.getRouting().offlineMode,
      signal: opts.signal,
      onToken: opts.handlers.onToken,
      onThinking: opts.handlers.onThinking,
    });

    lastText = turn.raw;
    if (turn.parseError || !turn.response) {
      return { text: turn.raw, applied, errors: errors.length ? errors : undefined };
    }

    const policy = opts.host.applyToolPolicy(turn.response, skill.tools);
    if (policy.removed.length) {
      opts.log(`Blocked by tool restrictions — ${policy.removed.join(', ')}.`);
    }
    const response = policy.response;

    if (response.remember?.length) {
      const toolCallId = newRunId('tc');
      opts.handlers.onTool?.('requested', toolCallId, 'remember');
      await opts.host.remember(response.remember, opts.ctx.metadata.workflowRunId);
      opts.handlers.onTool?.('completed', toolCallId, 'remember', `${response.remember.length} note(s)`);
    }

    const wantsWeb = !!response.web_searches?.length;
    const wantsFiles = !!response.request_files;
    const wantsEdits = response.operations.length > 0 || !!response.run_commands?.length;

    if (wantsWeb) {
      extras.webSearchResults = await runWebSearches(opts, response, skill);
      continue;
    }

    if (wantsFiles) {
      const extraFiles = await runFileRequest(opts, response, seenPaths);
      files = [...files, ...extraFiles.files];
      extras.requestFilesFeedback = extraFiles.feedback;
      continue;
    }

    if (wantsEdits) {
      const applyResult = await applyEditsAndCommands(opts, response);
      applied = applied.concat(applyResult.applied);
      if (applyResult.errors.length) errors.push(...applyResult.errors);
      lastText = response.summary || lastText;
      if (applyResult.commandNarratives.length) {
        extras.requestFilesFeedback = [
          'Terminal results from the approved commands:',
          ...applyResult.commandNarratives,
          'Continue only if more work remains. Otherwise return an empty operations array and a summary.',
        ].join('\n');
        continue;
      }
      return {
        text: lastText,
        applied,
        errors: errors.length ? errors : undefined,
      };
    }

    return {
      text: response.summary || lastText,
      applied,
      errors: errors.length ? errors : undefined,
    };
  }

  return { text: lastText, applied, errors: errors.length ? errors : undefined };
}

async function runWebSearches(
  opts: SkillRuntimeOptions,
  response: HostAgentResponse,
  skill: Skill,
): Promise<string> {
  const routing = opts.getRouting();
  const allowed = !skill.tools || skill.tools.includes('web');
  if (!allowed || !opts.host.canWebSearch(routing.offlineMode)) {
    opts.log('Web search skipped (offline, no key, or tool disabled).');
    return 'Web search is unavailable for this node (offline, missing key, or tool disabled).';
  }

  const blocks: string[] = [];
  for (const search of response.web_searches || []) {
    const toolCallId = newRunId('tc');
    opts.handlers.onTool?.('requested', toolCallId, 'web', search.query);
    try {
      const block = await opts.host.webSearch(search.query);
      blocks.push(block);
      opts.handlers.onTool?.('completed', toolCallId, 'web', search.query);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      blocks.push(`Search for "${search.query}" failed: ${msg}`);
      opts.handlers.onTool?.('completed', toolCallId, 'web', msg);
    }
  }
  return blocks.join('\n\n---\n\n');
}

async function runFileRequest(
  opts: SkillRuntimeOptions,
  response: HostAgentResponse,
  seenPaths: Set<string>,
): Promise<{ files: HostFile[]; feedback: string }> {
  const req = response.request_files;
  if (!req) return { files: [], feedback: '' };
  const toolCallId = newRunId('tc');
  opts.handlers.onTool?.('requested', toolCallId, 'request_files', req.patterns.join(', '));
  const files = await opts.host.findFiles(req.patterns, seenPaths);
  for (const file of files) seenPaths.add(file.path);
  const names = files.map((f) => f.path);
  opts.handlers.onTool?.('completed', toolCallId, 'request_files', names.join(', ') || 'none');
  if (names.length === 0) {
    return {
      files,
      feedback: `request_files matched no new files for: ${req.patterns.join(', ')}. Use paths from the repo map.`,
    };
  }
  return {
    files,
    feedback: `request_files added: ${names.join(', ')}. These are now in context — use them.`,
  };
}

async function applyEditsAndCommands(
  opts: SkillRuntimeOptions,
  response: HostAgentResponse,
): Promise<{ applied: string[]; errors: string[]; commandNarratives: string[] }> {
  const preview = opts.host.buildDiffPreview(response.operations, response.run_commands);
  let approved = opts.autoApply;
  if (!approved && opts.handlers.requestApproval && (response.operations.length > 0 || response.run_commands?.length)) {
    opts.handlers.onWaitingForApproval?.();
    approved = await opts.handlers.requestApproval(preview);
    opts.handlers.onResumed?.();
  }
  if (!approved) {
    return { applied: [], errors: ['Skipped (not approved)'], commandNarratives: [] };
  }

  const applyResult = await opts.applyLock.run(async () => {
    if (response.operations.length === 0) {
      return { applied: [] as string[], errors: [] as string[], warnings: [] as string[] };
    }
    return opts.host.applyOperations(response.operations);
  });

  const commandNarratives: string[] = [];
  for (const cmd of response.run_commands || []) {
    const toolCallId = newRunId('tc');
    opts.handlers.onTool?.('requested', toolCallId, 'terminal', cmd.command);
    try {
      const output = await opts.host.runCommand(cmd.command);
      commandNarratives.push(`$ ${cmd.command}\nSucceeded.\n${output.slice(0, 3000)}`);
      opts.handlers.onTool?.('completed', toolCallId, 'terminal', 'ok');
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      commandNarratives.push(`$ ${cmd.command}\nFAILED.\n${msg.slice(0, 3000)}`);
      opts.handlers.onTool?.('completed', toolCallId, 'terminal', msg);
    }
  }

  return {
    applied: applyResult.applied,
    errors: applyResult.errors,
    commandNarratives,
  };
}
