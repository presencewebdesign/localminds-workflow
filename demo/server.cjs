#!/usr/bin/env node
const http = require('http');
const fs = require('fs');
const path = require('path');
const { GraphExecutor, compileWorkflow } = require('../dist');
const { library, workflow } = require('./sample');
const { createMockHost } = require('./mock-host');

const PORT = Number(process.env.PORT || 4173);
const PUBLIC = path.join(__dirname, 'public');

function send(res, status, body, headers = {}) {
  const payload = typeof body === 'string' ? body : JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': typeof body === 'string' ? 'text/html; charset=utf-8' : 'application/json',
    ...headers,
  });
  res.end(payload);
}

function serveStatic(req, res) {
  const url = new URL(req.url, `http://127.0.0.1:${PORT}`);
  const file = url.pathname === '/' ? '/index.html' : url.pathname;
  const full = path.normalize(path.join(PUBLIC, file));
  if (!full.startsWith(PUBLIC)) {
    send(res, 403, 'Forbidden');
    return true;
  }
  if (!fs.existsSync(full) || fs.statSync(full).isDirectory()) return false;
  const ext = path.extname(full);
  const types = { '.html': 'text/html; charset=utf-8', '.css': 'text/css', '.js': 'text/javascript' };
  res.writeHead(200, { 'Content-Type': types[ext] || 'application/octet-stream' });
  fs.createReadStream(full).pipe(res);
  return true;
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://127.0.0.1:${PORT}`);

  if (req.method === 'GET' && url.pathname === '/api/graph') {
    const ir = compileWorkflow(workflow);
    send(res, 200, { workflow, library, ir });
    return;
  }

  if (req.method === 'GET' && url.pathname === '/api/run') {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    });
    if (typeof res.flushHeaders === 'function') res.flushHeaders();
    res.write('retry: 3600000\n\n');
    const write = (event) => {
      res.write(`data: ${JSON.stringify(event)}\n\n`);
    };

    const offline = url.searchParams.get('offline') === '1';
    const host = createMockHost();
    const executor = new GraphExecutor(host, (msg) => write({ type: 'log', message: msg, timestamp: Date.now() }));

    req.on('close', () => executor.abort());

    try {
      await executor.run(
        workflow,
        { emit: write },
        {
          library,
          getRouting: () => ({
            offlineMode: offline,
            model: offline ? 'mock-local' : 'mock-cloud',
          }),
        },
      );
    } catch (err) {
      write({
        type: 'workflow.failed',
        error: { message: err instanceof Error ? err.message : String(err) },
        timestamp: Date.now(),
      });
    }
    res.end();
    return;
  }

  if (serveStatic(req, res)) return;
  send(res, 404, 'Not found');
});

server.listen(PORT, () => {
  console.log(`@localminds/workflow demo → http://127.0.0.1:${PORT}`);
});
