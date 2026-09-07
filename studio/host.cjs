/**
 * Studio preview host. Never applies file operations or runs shell commands.
 * Uses Ollama when it is reachable; otherwise a deterministic mock.
 */
const fs = require('fs');
const path = require('path');

const IGNORE = new Set(['node_modules', '.git', 'dist', 'coverage', '.localminds', '.cursor']);
const MAX_FILE = 4000;
const MAX_FILES = 8;

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function streamText(text, onToken, ms = 12) {
  const chunks = String(text).split(/(\s+)/);
  for (const chunk of chunks) {
    onToken?.(chunk);
    await delay(ms);
  }
}

function parseChatResult(raw, mode) {
  if (mode !== 'agent') return { raw };
  const trimmed = String(raw || '').trim();
  const start = trimmed.indexOf('{');
  const end = trimmed.lastIndexOf('}');
  if (start < 0 || end <= start) return { raw };
  try {
    const json = JSON.parse(trimmed.slice(start, end + 1));
    if (!json || typeof json !== 'object') return { raw };
    return {
      raw,
      response: {
        summary: json.summary || '',
        operations: Array.isArray(json.operations) ? json.operations : [],
        run_commands: json.run_commands,
        request_files: json.request_files,
        web_searches: json.web_searches,
        remember: json.remember,
      },
    };
  } catch (err) {
    return { raw, parseError: err instanceof Error ? err.message : String(err) };
  }
}

async function detectOllama() {
  try {
    const res = await fetch('http://127.0.0.1:11434/api/tags', {
      signal: AbortSignal.timeout(500),
    });
    if (!res.ok) return null;
    const data = await res.json();
    const models = (data.models || []).map((m) => m.name).filter(Boolean);
    const preferred = process.env.LOCALMINDS_MODEL;
    const model = (preferred && models.includes(preferred) ? preferred : null)
      || preferred
      || models[0]
      || 'llama3.2';
    return { models, model };
  } catch {
    return null;
  }
}

async function detectStudioHost(forceMock) {
  if (forceMock || process.env.LOCALMINDS_STUDIO_MOCK === '1') {
    return { kind: 'mock', model: 'studio-mock', models: [] };
  }
  const ollama = await detectOllama();
  if (ollama) return { kind: 'ollama', model: ollama.model, models: ollama.models };
  return { kind: 'mock', model: 'studio-mock', models: [] };
}

function skillNameFromSystem(system) {
  const match = String(system || '').match(/## Active Skill: ([^\n]+)/);
  return (match && match[1].trim()) || 'Skill';
}

function mockAskReply(system, user) {
  const name = skillNameFromSystem(system);
  const excerpt = String(user || '').replace(/\s+/g, ' ').trim().slice(0, 280);
  return [
    `[mock] ${name}`,
    excerpt ? `Input: ${excerpt}` : 'No extra input.',
    'Studio preview host — start Ollama on 127.0.0.1:11434 to run with a real model. File operations are never applied from Studio.',
  ].join('\n');
}

function withinRoot(root, rel) {
  const full = path.resolve(root, rel);
  const base = path.resolve(root);
  return full === base || full.startsWith(base + path.sep) ? full : null;
}

function readRepoFile(root, rel, max = MAX_FILE) {
  const full = withinRoot(root, rel);
  if (!full || !fs.existsSync(full) || !fs.statSync(full).isFile()) return null;
  return { path: rel.replace(/\\/g, '/'), content: fs.readFileSync(full, 'utf8').slice(0, max) };
}

function globToRegExp(pattern) {
  const escaped = String(pattern)
    .replace(/\\/g, '/')
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*\*/g, '::DS::')
    .replace(/\*/g, '[^/]*')
    .replace(/::DS::/g, '.*');
  return new RegExp(`^${escaped}$`);
}

function walkFiles(root, dir, out) {
  if (out.length >= 400) return;
  let entries = [];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (entry.name.startsWith('.') && entry.name !== '.gitignore') continue;
    if (IGNORE.has(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walkFiles(root, full, out);
    } else if (entry.isFile()) {
      out.push(path.relative(root, full).replace(/\\/g, '/'));
    }
    if (out.length >= 400) return;
  }
}

async function chatWithOllama(req, model) {
  const res = await fetch('http://127.0.0.1:11434/api/chat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model,
      stream: true,
      messages: [
        { role: 'system', content: req.system || '' },
        { role: 'user', content: req.user || '' },
      ],
    }),
    signal: req.signal,
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Ollama request failed: ${res.status} ${text.slice(0, 200)}`);
  }

  let raw = '';
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop() || '';
    for (const line of lines) {
      if (!line.trim()) continue;
      let chunk;
      try {
        chunk = JSON.parse(line);
      } catch {
        continue;
      }
      const token = chunk.message && chunk.message.content;
      if (token) {
        raw += token;
        req.onToken?.(token);
      }
    }
  }
  return parseChatResult(raw, req.mode);
}

function createStudioHost({ root, kind, model }) {
  const useMock = kind !== 'ollama';

  return {
    kind,
    model,

    async chat(req) {
      if (!useMock) {
        return chatWithOllama(req, req.model || model);
      }
      if (req.mode === 'ask' || req.mode === 'plan') {
        const text = mockAskReply(req.system, req.user);
        await streamText(text, req.onToken);
        return { raw: text };
      }
      const name = skillNameFromSystem(req.system);
      const user = String(req.user || '');
      if (user.includes('<web_search_results') || user.includes('<file_request_feedback')) {
        const summary = `[mock] ${name} finished after tools. File operations were not applied.`;
        await streamText(summary, req.onToken);
        return {
          raw: JSON.stringify({ summary, operations: [] }),
          response: { summary, operations: [] },
        };
      }
      if (/\bweb_search\b/i.test(req.system || '') && !user.includes('<web_search_results')) {
        await delay(80);
        return {
          raw: '{"summary":"Need sources","operations":[],"web_searches":[{"query":"supporting evidence","reason":"Studio mock web tool"}]}',
          response: {
            summary: 'Need sources',
            operations: [],
            web_searches: [{ query: 'supporting evidence', reason: 'Studio mock web tool' }],
          },
        };
      }
      if (/\brequest_files\b/i.test(req.system || '') && !user.includes('<file_request_feedback')) {
        await delay(80);
        return {
          raw: '{"summary":"Need files","operations":[],"request_files":{"patterns":["package.json","README.md"],"reason":"Studio mock file tool"}}',
          response: {
            summary: 'Need files',
            operations: [],
            request_files: { patterns: ['package.json', 'README.md'], reason: 'Studio mock file tool' },
          },
        };
      }
      const summary = `[mock] ${name} completed without applying files.`;
      await streamText(summary, req.onToken);
      return {
        raw: JSON.stringify({ summary, operations: [] }),
        response: { summary, operations: [] },
      };
    },

    async gatherFiles() {
      const files = ['package.json', 'README.md', 'README']
        .map((rel) => readRepoFile(root, rel))
        .filter(Boolean);
      return files.slice(0, 4);
    },

    async findFiles(patterns, exclude) {
      const all = [];
      walkFiles(root, root, all);
      const matched = [];
      for (const pattern of patterns || []) {
        const re = globToRegExp(pattern);
        for (const rel of all) {
          if (exclude && exclude.has(rel)) continue;
          if (!re.test(rel) && path.basename(rel) !== pattern) continue;
          const file = readRepoFile(root, rel);
          if (file) matched.push(file);
          if (matched.length >= MAX_FILES) return matched;
        }
      }
      return matched;
    },

    async webSearch(query) {
      if (!useMock) {
        return 'Web search is not available in Studio. Use LocalMinds or a custom host for live search.';
      }
      return `Results for "${query}":\n1. (mock) Studio does not call the public web.\n2. Start LocalMinds for a full host with search.`;
    },

    canWebSearch(offlineMode) {
      return useMock && !offlineMode;
    },

    async applyOperations() {
      return {
        applied: [],
        errors: [],
        warnings: ['Studio run does not apply file operations'],
      };
    },

    async runCommand(command) {
      return `(studio) command not executed: ${command}`;
    },

    async remember() {},

    agentSystemPrompt() {
      return 'You are running inside the @localminds/workflow Studio preview. Return structured JSON for agent mode. Do not claim that files were written.';
    },

    buildSkillSystemPrompt(skill) {
      return `## Active Skill: ${skill.name}\n\n${skill.body}`;
    },

    buildAgentUserPrompt(request, files, extras) {
      const parts = [`<user_request>\n${request}\n</user_request>`];
      for (const file of files || []) {
        parts.push(`<file path="${file.path}">\n${file.content}\n</file>`);
      }
      if (extras?.webSearchResults) {
        parts.push(`<web_search_results>\n${extras.webSearchResults}\n</web_search_results>`);
      }
      if (extras?.requestFilesFeedback) {
        parts.push(`<file_request_feedback>\n${extras.requestFilesFeedback}\n</file_request_feedback>`);
      }
      return parts.join('\n\n');
    },

    buildDiffPreview() {
      return '(Studio never applies file edits)';
    },

    applyToolPolicy(response) {
      return { response, removed: [] };
    },

    buildToolRestrictionNote() {
      return '';
    },

    documentationNote() {
      return '';
    },

    planResearchNote() {
      return '';
    },
  };
}

module.exports = { createStudioHost, detectStudioHost };
