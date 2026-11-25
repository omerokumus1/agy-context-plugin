#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { buildDemoState } from './lib/demo.mjs';
import {
  discoverLanguageServer,
  fetchAllTrajectories,
  fetchGeneratorMetadata,
  fetchTrajectorySteps,
  getModelCatalog,
  resolveModelSlug,
} from './lib/rpc.mjs';
import { listLocalDbConversations, readConversationFromSqlite } from './lib/sqlite-fallback.mjs';
import { buildContextTelemetry } from './lib/telemetry.mjs';

// Silence Node ExperimentalWarning from node:sqlite fallback
const origEmitWarning = process.emitWarning.bind(process);
process.emitWarning = (warning, ...args) => {
  const name = warning && typeof warning === 'object' ? warning.name : undefined;
  const type = typeof args[0] === 'string' ? args[0] : args[0]?.type;
  if (name === 'ExperimentalWarning' || type === 'ExperimentalWarning') return;
  return origEmitWarning(warning, ...args);
};

const __dirname = dirname(fileURLToPath(import.meta.url));
const UI_PATH = join(__dirname, 'ui.html');

function readPluginVersion() {
  const candidates = [
    resolve(__dirname, '..', '..', 'plugin.json'),
    resolve(__dirname, 'package.json'),
  ];
  for (const p of candidates) {
    if (!existsSync(p)) continue;
    try {
      const parsed = JSON.parse(readFileSync(p, 'utf8').replace(/^\uFEFF/, ''));
      if (parsed.version) return String(parsed.version);
    } catch {
      // ignore
    }
  }
  return '1.0.0';
}

function normalizeUriPath(uri) {
  if (!uri) return '';
  let s = String(uri).trim();
  const remote = s.match(/^vscode-remote:\/\/[^/]+(\/.*)/i);
  if (remote) s = remote[1];
  s = s.replace(/^file:\/\/localhost\//i, '/').replace(/^file:\/\/\//i, '/').replace(/^file:\/\//i, '');
  try { s = decodeURIComponent(s); } catch { /* keep */ }
  s = s.replace(/\\/g, '/').replace(/^\/+([A-Za-z]:)/, '$1').replace(/\/+$/, '');
  return (process.platform === 'darwin' || process.platform === 'win32') ? s.toLowerCase() : s;
}

export function createContextService(options = {}) {
  const dataDir = options.dataDir || process.env.ANTIGRAVITY_EXECUTABLE_DATA_DIR || join(__dirname, '.data');
  const prefsPath = join(dataDir, 'prefs.json');
  const demoMode = Boolean(options.demo || process.env.ANTIGRAVITY_DEMO === '1');
  const customDbDirs = options.dbDirs || null;
  const version = options.version || readPluginVersion();

  let prefs = { overrideLimit: 0 };
  try {
    if (existsSync(prefsPath)) {
      const saved = JSON.parse(readFileSync(prefsPath, 'utf8'));
      if (saved && typeof saved === 'object') {
        prefs.overrideLimit = Number(saved.overrideLimit) || 0;
      }
    }
  } catch {
    // ignore corrupt prefs
  }

  function savePrefs() {
    try {
      mkdirSync(dataDir, { recursive: true });
      writeFileSync(prefsPath, JSON.stringify(prefs, null, 2) + '\n', 'utf8');
    } catch {
      // ignore write failures
    }
  }

  function updatePreferences(patch = {}) {
    if (Object.prototype.hasOwnProperty.call(patch, 'overrideLimit')) {
      const v = Number(patch.overrideLimit);
      prefs.overrideLimit = Number.isFinite(v) && v >= 0 ? Math.round(v) : 0;
    }
    savePrefs();
    return { ok: true, prefs };
  }

  async function getSnapshot({ conversationId = '', workspace = '', etag = '' } = {}) {
    if (demoMode) {
      const demo = buildDemoState(prefs.overrideLimit);
      demo.telemetry.source = 'demo';
      const hashBasis = JSON.stringify({ t: demo.telemetry.context, l: prefs.overrideLimit, c: demo.conversations.length });
      const nextEtag = createHash('sha1').update(hashBasis).digest('hex').slice(0, 12);
      if (etag && etag === nextEtag) return { unchanged: true, etag: nextEtag };
      return { unchanged: false, etag: nextEtag, snapshot: demo.telemetry, conversations: demo.conversations };
    }

    const ls = await discoverLanguageServer();
    let trajectories = [];
    let modelCatalog = {};
    if (ls) {
      try {
        [trajectories, modelCatalog] = await Promise.all([
          fetchAllTrajectories(ls),
          getModelCatalog(ls),
        ]);
      } catch {
        trajectories = [];
      }
    }

    // Merge local SQLite conversations as offline fallback
    const localDbs = listLocalDbConversations(customDbDirs);
    const knownIds = new Set(trajectories.map((t) => t.cascadeId));
    for (const dbItem of localDbs) {
      if (!knownIds.has(dbItem.cascadeId)) {
        trajectories.push({
          cascadeId: dbItem.cascadeId,
          summary: `Session ${dbItem.cascadeId.slice(0, 8)}`,
          stepCount: 0,
          status: 'OFFLINE',
          lastModifiedTime: dbItem.lastModifiedTime,
          createdTime: '',
          requestedModel: '',
          generatorModel: '',
          workspaceUris: [],
          dbPath: dbItem.dbPath,
        });
      }
    }

    if (trajectories.length === 0) {
      return {
        unchanged: false,
        etag: 'empty',
        snapshot: { error: 'no-conversation', message: 'No Antigravity conversations found yet.' },
        conversations: [],
      };
    }

    // Pick target conversation: explicit id -> matching workspace main agent -> most recent main agent
    let target = conversationId
      ? trajectories.find((t) => t.cascadeId === conversationId)
      : null;

    if (!target) {
      const nonSubagents = trajectories.filter((t) => !t.parentCascadeId && !/subagent/i.test(t.trajectoryType || ''));
      const pool = nonSubagents.length > 0 ? nonSubagents : trajectories;
      const normWs = normalizeUriPath(workspace);
      if (normWs) {
        target = pool.find((t) => (t.workspaceUris || []).some((u) => normalizeUriPath(u) === normWs));
      }
      if (!target) target = pool[0];
    }

    let genMetadata = [];
    let steps = [];
    let source = 'rpc';

    if (ls && target && !target.dbPath) {
      [genMetadata, steps] = await Promise.all([
        fetchGeneratorMetadata(ls, target.cascadeId),
        fetchTrajectorySteps(ls, target.cascadeId, target.stepCount),
      ]);
    }

    // Fallback to SQLite .db if RPC unavailable or returned nothing
    if (genMetadata.length === 0) {
      const localMatch = localDbs.find((d) => d.cascadeId === target.cascadeId);
      if (localMatch) {
        const parsed = await readConversationFromSqlite(localMatch.dbPath);
        if (parsed) {
          genMetadata = parsed.genMetadata;
          steps = parsed.steps;
          source = 'sqlite';
        }
      }
    }

    const telemetry = buildContextTelemetry({
      trajectory: target,
      genMetadata,
      steps,
      modelCatalog,
      overrideLimit: prefs.overrideLimit,
    });
    telemetry.source = source;

    const conversations = trajectories.slice(0, 25).map((t) => ({
      cascadeId: t.cascadeId,
      title: t.summary || t.cascadeId.slice(0, 8),
      model: resolveModelSlug(t.requestedModel || t.generatorModel || 'unknown'),
      status: t.status,
      lastModifiedTime: t.lastModifiedTime,
    }));

    const hashBasis = JSON.stringify({
      id: target.cascadeId,
      used: telemetry.context.usedTokens,
      turns: telemetry.metrics.turnCount,
      tools: telemetry.metrics.toolCount,
      limit: telemetry.context.limitTokens,
      status: target.status,
    });
    const nextEtag = createHash('sha1').update(hashBasis).digest('hex').slice(0, 12);

    if (etag && etag === nextEtag) {
      return { unchanged: true, etag: nextEtag };
    }

    return {
      unchanged: false,
      etag: nextEtag,
      snapshot: telemetry,
      conversations,
    };
  }

  function renderHtml() {
    return readFileSync(UI_PATH, 'utf8');
  }

  function getHealth() {
    return {
      ok: true,
      name: 'agy-context-plugin',
      version,
      demoMode,
    };
  }

  return {
    getHealth,
    getSnapshot,
    updatePreferences,
    renderHtml,
  };
}

function readJsonBody(req, maxBytes = 64 * 1024) {
  return new Promise((resolveBody, reject) => {
    const chunks = [];
    let total = 0;
    req.on('data', (chunk) => {
      total += chunk.length;
      if (total > maxBytes) {
        reject(new Error('Body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8').trim();
      if (!raw) return resolveBody({});
      try {
        resolveBody(JSON.parse(raw));
      } catch (err) {
        reject(err);
      }
    });
    req.on('error', reject);
  });
}

export async function startStandaloneServer(service, { port = 17840, host = '127.0.0.1' } = {}) {
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url || '/', `http://${host}`);
    try {
      if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/full')) {
        const html = service.renderHtml();
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
        res.end(html);
        return;
      }
      if (req.method === 'GET' && url.pathname === '/preload.js') {
        res.writeHead(200, { 'Content-Type': 'application/javascript; charset=utf-8' });
        res.end('/* standalone mode */');
        return;
      }
      if (req.method === 'GET' && url.pathname === '/api/health') {
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify(service.getHealth()));
        return;
      }
      if (req.method === 'GET' && url.pathname === '/api/snapshot') {
        const result = await service.getSnapshot({
          conversationId: url.searchParams.get('conversationId') || '',
          workspace: url.searchParams.get('workspace') || '',
          etag: url.searchParams.get('etag') || '',
        });
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
        res.end(JSON.stringify(result));
        return;
      }
      if (req.method === 'POST' && url.pathname === '/api/preferences') {
        const body = await readJsonBody(req);
        const result = service.updatePreferences(body);
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify(result));
        return;
      }
      res.writeHead(404, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: 'Not found' }));
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: err instanceof Error ? err.message : String(err) }));
    }
  });

  await new Promise((resolveListen, rejectListen) => {
    server.once('error', rejectListen);
    server.listen(port, host, resolveListen);
  });

  const addr = server.address();
  const actualPort = typeof addr === 'object' && addr ? addr.port : port;
  return {
    server,
    port: actualPort,
    url: `http://${host}:${actualPort}`,
    close: () => new Promise((r) => server.close(r)),
  };
}

async function startSidecarMode(service) {
  const { SidecarApp, Response } = await import('sidecar_sdk');
  const app = new SidecarApp();

  app.page('/', () => new Response(service.renderHtml(), {
    contentType: 'text/html; charset=utf-8',
    status: 200,
  }));

  app.page('/full', () => new Response(service.renderHtml(), {
    contentType: 'text/html; charset=utf-8',
    status: 200,
  }));

  app.api('/api/health', () => service.getHealth(), 'GET');

  app.api('/api/snapshot', async (data) => {
    const result = await service.getSnapshot({
      conversationId: data?.conversationId || '',
      workspace: data?.workspace || '',
      etag: data?.etag || '',
    });
    return new Response(JSON.stringify(result), {
      contentType: 'application/json; charset=utf-8',
      status: 200,
    });
  }, 'GET');

  app.api('/api/preferences', async (data) => {
    const result = service.updatePreferences(data || {});
    return new Response(JSON.stringify(result), {
      contentType: 'application/json; charset=utf-8',
      status: 200,
    });
  }, 'POST');

  const shutdown = async () => {
    try { await app.close(); } catch { /* ignore */ }
    process.exit(0);
  };
  process.once('SIGINT', () => void shutdown());
  process.once('SIGTERM', () => void shutdown());

  await app.run();
}

function parseArgs(argv) {
  let standalone = false;
  let demo = false;
  let port = 17840;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--standalone') standalone = true;
    else if (a === '--demo') demo = true;
    else if (a === '--port' && i + 1 < argv.length) {
      port = Number(argv[++i]) || port;
      standalone = true;
    } else if (a.startsWith('--port=')) {
      port = Number(a.slice('--port='.length)) || port;
      standalone = true;
    }
  }
  return { standalone, demo, port };
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const args = parseArgs(process.argv.slice(2));
  const service = createContextService({ demo: args.demo });
  const inSidecarEnv = Boolean(process.env.ANTIGRAVITY_SIDECAR_WEB_PORT);

  if (!args.standalone && inSidecarEnv) {
    startSidecarMode(service).catch((err) => {
      console.error('[context_window] sidecar startup error:', err);
      process.exit(1);
    });
  } else {
    startStandaloneServer(service, { port: args.port }).then((srv) => {
      console.log(`[context_window] listening at ${srv.url}${args.demo ? ' (demo mode)' : ''}`);
    }).catch((err) => {
      console.error('[context_window] standalone startup error:', err);
      process.exit(1);
    });
  }
}
