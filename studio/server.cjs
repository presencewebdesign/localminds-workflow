#!/usr/bin/env node
/**
 * Standalone workflow CMS. Writes ProjectLibrary JSON under <repo>/.localminds
 * and validates with compileWorkflow from @localminds/workflow.
 * Run uses GraphExecutor with a Studio preview host (Ollama or mock).
 * File operations are never applied. Does not change the engine.
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { createStudioHost, detectStudioHost } = require('./host.cjs');

const PKG_ROOT = path.join(__dirname, '..');
const PUBLIC = path.join(__dirname, 'public');
const EXAMPLE = path.join(__dirname, 'example.json');

const args = parseArgs(process.argv.slice(2));
if (args.help) {
  printHelp();
  process.exit(0);
}

const PORT = args.port || Number(process.env.PORT || 4174);
const HOST = args.host || '127.0.0.1';
const ROOT = path.resolve(args.root || process.env.LOCALMINDS_ROOT || process.cwd());

function parseArgs(argv) {
  const out = { help: false, open: true, mock: false };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--help' || a === '-h') out.help = true;
    else if (a === '--no-open') out.open = false;
    else if (a === '--mock') out.mock = true;
    else if (a === '--port' || a === '-p') out.port = Number(argv[++i]);
    else if (a === '--host') out.host = argv[++i];
    else if (a === '--root' || a === '-r') out.root = argv[++i];
    else if (a.startsWith('--port=')) out.port = Number(a.slice(7));
    else if (a.startsWith('--root=')) out.root = a.slice(7);
  }
  return out;
}

function printHelp() {
  console.log(`Usage: localminds-workflow [options]

Standalone CMS for authoring @localminds/workflow JSON in any repo.
Writes .localminds/library.json and .localminds/workflows/<slug>.json.

Options:
  --root, -r <dir>   Repo root (default: cwd)
  --port, -p <n>     Port (default: 4174)
  --host <addr>      Bind address (default: 127.0.0.1)
  --mock             Force the mock preview host (skip Ollama)
  --no-open          Do not open a browser
  --help             Show this help
`);
}

function loadEngine() {
  const localDist = path.join(PKG_ROOT, 'dist', 'index.js');
  if (fs.existsSync(localDist)) return require(localDist);
  try {
    return require('@localminds/workflow');
  } catch {
    throw new Error(
      'Cannot load @localminds/workflow. Run npm run build in this package, or install it in the target repo.',
    );
  }
}

function emptyLibrary() {
  return { instructions: [], agents: [], skills: [], prompts: [], workflows: [] };
}

function mindDir() {
  return path.join(ROOT, '.localminds');
}

function libraryPath() {
  return path.join(mindDir(), 'library.json');
}

function workflowsDir() {
  return path.join(mindDir(), 'workflows');
}

function safeSlug(value) {
  const slug = String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '');
  if (!slug || slug === '.' || slug === '..') {
    throw new Error('Invalid slug');
  }
  return slug;
}

function normalizeLibrary(raw) {
  const src = raw && typeof raw === 'object' ? raw : {};
  return {
    instructions: Array.isArray(src.instructions) ? src.instructions : [],
    agents: Array.isArray(src.agents) ? src.agents : [],
    skills: Array.isArray(src.skills) ? src.skills : [],
    prompts: Array.isArray(src.prompts) ? src.prompts : [],
    workflows: Array.isArray(src.workflows) ? src.workflows : [],
  };
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function readLibrary() {
  const libFile = libraryPath();
  const wfDir = workflowsDir();
  const library = fs.existsSync(libFile)
    ? normalizeLibrary(readJson(libFile))
    : emptyLibrary();

  if (!fs.existsSync(wfDir)) return library;

  const bySlug = new Map(library.workflows.map((w) => [w.slug, w]));
  for (const name of fs.readdirSync(wfDir)) {
    if (!name.endsWith('.json')) continue;
    const workflow = readJson(path.join(wfDir, name));
    if (workflow && workflow.slug) bySlug.set(workflow.slug, workflow);
  }
  library.workflows = [...bySlug.values()];
  return library;
}

function writeLibrary(library) {
  const normalized = normalizeLibrary(library);
  const dir = mindDir();
  const wfDir = workflowsDir();
  fs.mkdirSync(wfDir, { recursive: true });

  const entities = {
    instructions: normalized.instructions,
    agents: normalized.agents,
    skills: normalized.skills,
    prompts: normalized.prompts,
  };
  fs.writeFileSync(libraryPath(), `${JSON.stringify(entities, null, 2)}\n`);

  const keep = new Set();
  for (const workflow of normalized.workflows) {
    const slug = safeSlug(workflow.slug || workflow.id);
    workflow.slug = slug;
    workflow.id = workflow.id || slug;
    keep.add(`${slug}.json`);
    fs.writeFileSync(path.join(wfDir, `${slug}.json`), `${JSON.stringify(workflow, null, 2)}\n`);
  }

  for (const name of fs.readdirSync(wfDir)) {
    if (name.endsWith('.json') && !keep.has(name)) {
      fs.unlinkSync(path.join(wfDir, name));
    }
  }
  return readLibrary();
}

function send(res, status, body, headers = {}) {
  const json = typeof body !== 'string';
  const payload = json ? JSON.stringify(body) : body;
  res.writeHead(status, {
    'Content-Type': json ? 'application/json; charset=utf-8' : 'text/html; charset=utf-8',
    ...headers,
  });
  res.end(payload);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw) {
        resolve(null);
        return;
      }
      try {
        resolve(JSON.parse(raw));
      } catch (err) {
        reject(err);
      }
    });
    req.on('error', reject);
  });
}

function serveStatic(req, res) {
  const url = new URL(req.url, `http://${HOST}:${PORT}`);
  const file = url.pathname === '/' ? '/index.html' : url.pathname;
  const full = path.normalize(path.join(PUBLIC, file));
  if (!full.startsWith(PUBLIC)) {
    send(res, 403, 'Forbidden');
    return true;
  }
  if (!fs.existsSync(full) || fs.statSync(full).isDirectory()) return false;
  const ext = path.extname(full);
  const types = {
    '.html': 'text/html; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
  };
  res.writeHead(200, { 'Content-Type': types[ext] || 'application/octet-stream' });
  fs.createReadStream(full).pipe(res);
  return true;
}

function projectPayload() {
  const exists = fs.existsSync(libraryPath()) || fs.existsSync(workflowsDir());
  return {
    root: ROOT,
    dir: mindDir(),
    exists,
    library: exists ? readLibrary() : emptyLibrary(),
  };
}

function findEntity(library, slug) {
  for (const key of ['skills', 'agents', 'prompts', 'instructions']) {
    const item = (library[key] || []).find((entity) => entity.slug === slug);
    if (item) return item;
  }
  return null;
}

function runnableWorkflow(library, kind, slug, input) {
  if (kind === 'workflow') {
    const workflow = (library.workflows || []).find((item) => item.slug === slug);
    if (!workflow) throw new Error(`Workflow "${slug}" not found`);
    return { ...workflow, autoApply: false };
  }
  const entity = findEntity(library, slug);
  if (!entity) throw new Error(`${kind} "${slug}" not found`);
  const stepType = entity.kind === 'instruction' || entity.kind === 'prompt' || entity.kind === 'agent'
    ? entity.kind
    : 'skill';
  return {
    id: `studio-run-${entity.slug}`,
    slug: `studio-run-${entity.slug}`,
    name: entity.name || entity.slug,
    autoApply: false,
    steps: [
      {
        id: entity.slug,
        type: stepType,
        ref: entity.slug,
        input: input || '',
      },
    ],
  };
}

function writeSse(res, event) {
  res.write(`data: ${JSON.stringify(event)}\n\n`);
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${HOST}:${PORT}`);

  try {
    if (req.method === 'GET' && url.pathname === '/api/project') {
      send(res, 200, projectPayload());
      return;
    }

    if (req.method === 'PUT' && url.pathname === '/api/project') {
      const body = await readBody(req);
      const saved = writeLibrary(body && body.library ? body.library : body);
      send(res, 200, { root: ROOT, dir: mindDir(), exists: true, library: saved });
      return;
    }

    if (req.method === 'POST' && url.pathname === '/api/compile') {
      const body = await readBody(req);
      const workflow = body && body.workflow ? body.workflow : body;
      const { compileWorkflow } = loadEngine();
      const ir = compileWorkflow(workflow);
      send(res, 200, { ok: true, ir });
      return;
    }

    if (req.method === 'GET' && url.pathname === '/api/example') {
      send(res, 200, readJson(EXAMPLE));
      return;
    }

    if (req.method === 'GET' && url.pathname === '/api/host') {
      const info = await detectStudioHost(args.mock || url.searchParams.get('mock') === '1');
      send(res, 200, { ok: true, ...info });
      return;
    }

    if (req.method === 'POST' && url.pathname === '/api/run') {
      const body = (await readBody(req)) || {};
      const library = normalizeLibrary(body.library || readLibrary());
      const kind = body.kind || 'skill';
      const slug = body.slug;
      if (!slug) throw new Error('Missing slug');
      const workflow = runnableWorkflow(library, kind, slug, body.input);
      const info = await detectStudioHost(args.mock || body.mock === true);
      const { GraphExecutor } = loadEngine();
      const host = createStudioHost({ root: ROOT, kind: info.kind, model: info.model });

      res.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
      });
      if (typeof res.flushHeaders === 'function') res.flushHeaders();
      writeSse(res, { type: 'run.meta', host: info.kind, model: info.model, workflowName: workflow.name });

      const executor = new GraphExecutor(host, (message) => {
        writeSse(res, { type: 'log', message, timestamp: Date.now() });
      });
      req.on('close', () => executor.abort());

      try {
        await executor.run(
          workflow,
          { emit: (event) => writeSse(res, event) },
          {
            library,
            getRouting: () => ({
              offlineMode: info.kind === 'mock' || body.offline === true,
              model: info.model,
            }),
          },
        );
      } catch (err) {
        writeSse(res, {
          type: 'workflow.failed',
          error: { message: err instanceof Error ? err.message : String(err) },
          timestamp: Date.now(),
        });
      }
      res.end();
      return;
    }

    if (serveStatic(req, res)) return;
    send(res, 404, { error: 'Not found' });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (res.headersSent) {
      writeSse(res, { type: 'workflow.failed', error: { message }, timestamp: Date.now() });
      res.end();
      return;
    }
    send(res, 400, { ok: false, error: message });
  }
});

server.listen(PORT, HOST, () => {
  const url = `http://${HOST}:${PORT}`;
  console.log(`@localminds/workflow CMS`);
  console.log(`  repo     ${ROOT}`);
  console.log(`  library  ${mindDir()}`);
  console.log(`  open     ${url}`);
  if (args.open) openBrowser(url);
});

function openBrowser(url) {
  const cmd = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'cmd' : 'xdg-open';
  const argv = process.platform === 'win32' ? ['/c', 'start', '', url] : [url];
  try {
    spawn(cmd, argv, { detached: true, stdio: 'ignore' }).unref();
  } catch {
    // ignore — the URL is printed above
  }
}
