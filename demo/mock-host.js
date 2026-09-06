function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function streamText(text, onToken, ms = 16) {
  const chunks = text.split(/(\s+)/);
  for (const chunk of chunks) {
    onToken?.(chunk);
    await delay(ms);
  }
}

function createMockHost() {
  return {
    async chat(req) {
      const system = req.system || '';
      const user = req.user || '';

      if (req.mode === 'ask' || req.mode === 'plan') {
        const text = askReply(system, user);
        await streamText(text, req.onToken);
        return { raw: text };
      }

      if (system.includes('Web research') && !user.includes('<web_search_results')) {
        await delay(180);
        return {
          raw: '{"summary":"Need sources","operations":[],"web_searches":[{"query":"local-first agent workflow graph fan-out","reason":"Find comparable engines"}]}',
          response: {
            summary: 'Need sources',
            operations: [],
            web_searches: [
              { query: 'local-first agent workflow graph fan-out', reason: 'Find comparable engines' },
            ],
          },
        };
      }

      if (system.includes('Inspect repo') && !user.includes('<file_request_feedback')) {
        await delay(220);
        return {
          raw: '{"summary":"Need package files","operations":[],"request_files":{"patterns":["package.json","src/index.ts"],"reason":"Confirm public API"}}',
          response: {
            summary: 'Need package files',
            operations: [],
            request_files: { patterns: ['package.json', 'src/index.ts'], reason: 'Confirm public API' },
          },
        };
      }

      const summary = agentSummary(system, user);
      await streamText(summary, req.onToken, 12);
      return {
        raw: JSON.stringify({ summary, operations: [] }),
        response: { summary, operations: [] },
      };
    },

    async gatherFiles() {
      await delay(40);
      return [
        { path: 'src/index.ts', content: 'export { GraphExecutor, compileWorkflow } from "./graph";', isActive: true },
        { path: 'package.json', content: '{ "name": "@localminds/workflow" }' },
      ];
    },

    async findFiles(patterns) {
      await delay(90);
      return patterns.map((path) => ({
        path,
        content: path.endsWith('package.json')
          ? '{ "name": "@localminds/workflow", "version": "0.1.0" }'
          : 'export { GraphExecutor } from "./graph/executor";',
      }));
    },

    async webSearch(query) {
      await delay(160);
      return `Results for "${query}":\n1. LangGraph fan-out/fan-in — parallel nodes join via reducers\n2. Anthropic graph engineering — many agents scheduled as a DAG`;
    },

    canWebSearch(offlineMode) {
      return !offlineMode;
    },

    async applyOperations() {
      return { applied: [], errors: [], warnings: [] };
    },

    async runCommand(command) {
      await delay(50);
      return `$ ${command}\n(demo host — command not executed)`;
    },

    async remember() {},

    agentSystemPrompt() {
      return 'You are a demo agent. Return structured operations when asked.';
    },

    buildSkillSystemPrompt(skill) {
      return `## Active Skill: ${skill.name}\n\n${skill.body}`;
    },

    buildAgentUserPrompt(request, files, extras) {
      const parts = [`<user_request>\n${request}\n</user_request>`];
      for (const file of files) {
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
      return '(no file edits in this demo)';
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

function askReply(system, user) {
  if (system.includes('Active Skill: Plan') || user.includes('evaluate @localminds/workflow')) {
    return [
      '1. Confirm the Graph IR compiles a parallel group into sibling nodes plus a generated join.',
      '2. Prove both branches run concurrently and the join receives structured outputs.',
      '3. Show that tools (web search, request_files) execute through the host port.',
      '4. Keep routing (offline/online) outside the package — the host decides where intelligence runs.',
    ].join('\n');
  }
  return [
    'Verdict: the engine is doing real graph work.',
    'Web branch brought external comparisons; repo branch confirmed the public API.',
    'Join output is structured by node id, not concatenated leftovers.',
    'Next: publish @localminds/workflow and keep LocalMinds as the first host.',
  ].join('\n');
}

function agentSummary(system) {
  if (system.includes('Web research')) {
    return 'Web: comparable systems use DAG scheduling with explicit fan-in. Graph engineering is the term of art.';
  }
  if (system.includes('Inspect repo')) {
    return 'Repo: package.json names @localminds/workflow; src/index.ts exports GraphExecutor and compileWorkflow.';
  }
  return 'Done.';
}

module.exports = { createMockHost };
