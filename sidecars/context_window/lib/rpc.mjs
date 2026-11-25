import { execFile } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

const MODEL_LIMIT_FALLBACKS = {
  'gemini-4-neon': 1_000_000,
  'gemini-4-neon-high': 1_000_000,
  'gemini-4-neon-low': 1_000_000,
  'gemini-4-argon': 1_000_000,
  'gemini-3.5-pro': 1_000_000,
  'gemini-3.5-flash': 1_000_000,
  'gemini-3.1-pro': 1_000_000,
  'gemini-3.1-flash': 1_000_000,
  'gemini-3-pro': 1_000_000,
  'gemini-3-flash': 1_000_000,
  'gemini-2.5-pro': 1_000_000,
  'gemini-2.5-flash': 1_000_000,
  'claude-opus-4-6': 200_000,
  'claude-sonnet-4-6': 200_000,
  'claude-opus-5': 256_000,
  'claude-sonnet-5': 256_000,
};

const PLACEHOLDER_MODEL_MAP = {
  MODEL_PLACEHOLDER_M16: 'gemini-3.1-pro-high',
  MODEL_PLACEHOLDER_M37: 'gemini-3.1-pro-high',
  MODEL_PLACEHOLDER_M36: 'gemini-3.1-pro-low',
  MODEL_PLACEHOLDER_M18: 'gemini-3-flash',
  MODEL_PLACEHOLDER_M84: 'gemini-3.5-flash-high',
  MODEL_PLACEHOLDER_M35: 'claude-sonnet-4-6',
  MODEL_PLACEHOLDER_M26: 'claude-opus-4-6-thinking',
};

let cachedLs = null;
let cachedCatalog = { fetchedAt: 0, models: {} };
const CATALOG_TTL_MS = 5 * 60 * 1000;

export function getGeminiDir() {
  return process.env.ANTIGRAVITY_GEMINI_DIR || join(homedir(), '.gemini');
}

function parseLsFromHubFiles() {
  const daemonDirs = [
    join(getGeminiDir(), 'antigravity', 'daemon'),
    join(getGeminiDir(), 'antigravity-ide', 'daemon'),
  ];
  for (const dir of daemonDirs) {
    if (!existsSync(dir)) continue;
    try {
      const files = readdirSync(dir)
        .filter((f) => /^hub_.*\.json$/i.test(f))
        .sort()
        .reverse();
      for (const file of files) {
        try {
          const data = JSON.parse(readFileSync(join(dir, file), 'utf8'));
          const port = data.httpsPort || data.port || data.extensionServerPort;
          const csrf = data.csrfToken || data.csrf_token;
          if (port && csrf) {
            const proto = data.httpsPort ? 'https' : 'http';
            return { address: `${proto}://127.0.0.1:${port}`, csrfToken: String(csrf) };
          }
        } catch {
          // ignore malformed hub file
        }
      }
    } catch {
      // ignore unreadable daemon dir
    }
  }
  return null;
}

async function parseLsFromProcesses() {
  if (process.platform === 'win32') return null;
  try {
    const { stdout } = await execFileAsync('ps', ['-eo', 'args'], { timeout: 2500, maxBuffer: 2 * 1024 * 1024 });
    const lines = stdout.split('\n');
    const candidates = [];
    for (const line of lines) {
      if (!/language_server/i.test(line)) continue;
      const portMatch = line.match(/--https_server_port(?:=|\s+)(\d+)/) || line.match(/--extension_server_port(?:=|\s+)(\d+)/);
      const csrfMatch = line.match(/--csrf_token(?:=|\s+)([^\s]+)/) || line.match(/--extension_server_csrf_token(?:=|\s+)([^\s]+)/);
      if (!portMatch || !csrfMatch) continue;
      const isApp = /--app_data_dir(?:=|\s+)antigravity(?:\s|$)/.test(line) || /--subclient_type(?:=|\s+)hub/.test(line);
      const proto = /--https_server_port/.test(line) ? 'https' : 'http';
      candidates.push({
        priority: isApp ? 0 : 1,
        address: `${proto}://127.0.0.1:${portMatch[1]}`,
        csrfToken: csrfMatch[1],
      });
    }
    candidates.sort((a, b) => a.priority - b.priority);
    return candidates[0] || null;
  } catch {
    return null;
  }
}

export async function discoverLanguageServer(forceRefresh = false) {
  const envAddr = (process.env.ANTIGRAVITY_LS_ADDRESS || '').trim();
  const envCsrf = (process.env.ANTIGRAVITY_CSRF_TOKEN || '').trim();
  if (envAddr && envCsrf) {
    return {
      address: envAddr.startsWith('http') ? envAddr : `https://${envAddr}`,
      csrfToken: envCsrf,
      source: 'env',
    };
  }
  if (!forceRefresh && cachedLs) return cachedLs;
  const hub = parseLsFromHubFiles();
  if (hub) {
    cachedLs = { ...hub, source: 'hub' };
    return cachedLs;
  }
  const proc = await parseLsFromProcesses();
  if (proc) {
    cachedLs = { address: proc.address, csrfToken: proc.csrfToken, source: 'ps' };
    return cachedLs;
  }
  return null;
}

export function rpcCall(ls, method, body = {}, timeoutMs = 8000) {
  if (!ls || !ls.address || !ls.csrfToken) {
    return Promise.reject(new Error('Language server not discovered'));
  }
  const base = new URL(ls.address.startsWith('http') ? ls.address : `https://${ls.address}`);
  const payload = JSON.stringify(body);
  const transport = base.protocol === 'http:' ? http : https;

  return new Promise((resolve, reject) => {
    const req = transport.request(
      {
        hostname: base.hostname,
        port: base.port,
        path: `/exa.language_server_pb.LanguageServerService/${method}`,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Connect-Protocol-Version': '1',
          'x-codeium-csrf-token': ls.csrfToken,
          'Content-Length': Buffer.byteLength(payload),
        },
        timeout: timeoutMs,
        rejectUnauthorized: false,
      },
      (res) => {
        const chunks = [];
        let totalBytes = 0;
        const maxBytes = 16 * 1024 * 1024;
        res.on('data', (chunk) => {
          totalBytes += chunk.length;
          if (totalBytes <= maxBytes) chunks.push(chunk);
        });
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          if (res.statusCode < 200 || res.statusCode >= 300) {
            reject(new Error(`${method}: HTTP ${res.statusCode}`));
            return;
          }
          try {
            resolve(JSON.parse(text));
          } catch (err) {
            reject(new Error(`${method}: invalid JSON (${err.message})`));
          }
        });
      }
    );
    req.on('timeout', () => req.destroy(new Error(`${method}: timeout`)));
    req.on('error', reject);
    req.end(payload);
  });
}

export async function getModelCatalog(ls, force = false) {
  if (!force && Date.now() - cachedCatalog.fetchedAt < CATALOG_TTL_MS && Object.keys(cachedCatalog.models).length > 0) {
    return cachedCatalog.models;
  }
  if (!ls) return cachedCatalog.models;
  try {
    const resp = await rpcCall(ls, 'GetAvailableModels', {
      metadata: { ideName: 'antigravity', extensionName: 'antigravity' },
    }, 5000);
    const rawModels = resp?.response?.models || resp?.models || {};
    const parsed = {};
    for (const [id, info] of Object.entries(rawModels)) {
      if (!info || typeof info !== 'object') continue;
      parsed[id] = {
        id,
        displayName: String(info.displayName || id),
        maxTokens: Number(info.maxTokens) || 0,
      };
    }
    if (Object.keys(parsed).length > 0) {
      cachedCatalog = { fetchedAt: Date.now(), models: parsed };
    }
  } catch {
    // ignore catalog fetch errors and use cached/fallback limits
  }
  return cachedCatalog.models;
}

export function resolveModelName(rawModel, catalog = {}) {
  if (!rawModel) return 'unknown';
  const mapped = PLACEHOLDER_MODEL_MAP[rawModel] || rawModel;
  const catEntry = catalog[rawModel] || catalog[mapped];
  if (catEntry && catEntry.displayName) {
    // Keep crisp readable slug or displayName
    return catEntry.displayName;
  }
  return mapped;
}

export function resolveModelSlug(rawModel) {
  if (!rawModel) return 'unknown';
  return PLACEHOLDER_MODEL_MAP[rawModel] || rawModel;
}

export function resolveContextLimit(rawModel, catalog = {}) {
  if (!rawModel) return 1_000_000;
  const mapped = PLACEHOLDER_MODEL_MAP[rawModel] || rawModel;
  const catEntry = catalog[rawModel] || catalog[mapped];
  if (catEntry && catEntry.maxTokens > 0) return catEntry.maxTokens;
  const lower = String(mapped).toLowerCase();
  for (const [prefix, limit] of Object.entries(MODEL_LIMIT_FALLBACKS)) {
    if (lower.includes(prefix)) return limit;
  }
  if (lower.includes('claude')) return 200_000;
  return 1_000_000;
}

export async function fetchAllTrajectories(ls) {
  const resp = await rpcCall(ls, 'GetAllCascadeTrajectories', {
    metadata: { ideName: 'antigravity', extensionName: 'antigravity' },
  }, 8000);
  const summaries = resp?.trajectorySummaries || {};
  const list = [];
  for (const [cascadeId, data] of Object.entries(summaries)) {
    if (!data || typeof data !== 'object') continue;
    let requestedModel = '';
    let generatorModel = '';
    for (const latest of [data.latestTaskBoundaryStep, data.latestNotifyUserStep]) {
      const meta = latest?.step?.metadata;
      if (meta) {
        if (meta.generatorModel) generatorModel = String(meta.generatorModel);
        if (meta.requestedModel?.model) requestedModel = String(meta.requestedModel.model);
      }
    }
    const workspaces = Array.isArray(data.workspaces) ? data.workspaces : [];
    const workspaceUris = workspaces.map((w) => w?.workspaceFolderAbsoluteUri).filter(Boolean);
    list.push({
      cascadeId,
      trajectoryId: String(data.trajectoryId || ''),
      summary: String(data.summary || cascadeId.slice(0, 8)),
      stepCount: Number(data.stepCount) || 0,
      status: String(data.status || 'IDLE'),
      lastModifiedTime: String(data.lastModifiedTime || ''),
      createdTime: String(data.createdTime || ''),
      requestedModel: requestedModel || generatorModel,
      generatorModel,
      workspaceUris,
      trajectoryType: typeof data.trajectoryType === 'string' ? data.trajectoryType : '',
      parentCascadeId: typeof data.parentCascadeId === 'string' ? data.parentCascadeId : '',
    });
  }
  list.sort((a, b) => String(b.lastModifiedTime).localeCompare(String(a.lastModifiedTime)));
  return list;
}

export async function fetchGeneratorMetadata(ls, cascadeId) {
  try {
    const resp = await rpcCall(ls, 'GetCascadeTrajectoryGeneratorMetadata', { cascadeId }, 12000);
    return Array.isArray(resp?.generatorMetadata) ? resp.generatorMetadata : [];
  } catch {
    return [];
  }
}

export async function fetchTrajectorySteps(ls, cascadeId, stepCount = 0) {
  const batchSize = 200;
  const maxSteps = Math.max(stepCount, batchSize);
  const allSteps = [];
  try {
    const first = await rpcCall(ls, 'GetCascadeTrajectorySteps', {
      cascadeId,
      startIndex: 0,
      endIndex: batchSize,
      stepOffset: 0,
    }, 15000);
    const firstSteps = Array.isArray(first?.steps) ? first.steps : [];
    allSteps.push(...firstSteps);
    if (firstSteps.length >= stepCount || firstSteps.length > batchSize || firstSteps.length < batchSize) {
      return allSteps;
    }
    for (let start = batchSize; start < maxSteps; start += batchSize) {
      const resp = await rpcCall(ls, 'GetCascadeTrajectorySteps', {
        cascadeId,
        startIndex: start,
        endIndex: start + batchSize,
        stepOffset: start,
      }, 15000);
      const batch = Array.isArray(resp?.steps) ? resp.steps : [];
      if (batch.length === 0) break;
      allSteps.push(...batch);
      if (batch.length < batchSize) break;
    }
    return allSteps;
  } catch {
    return allSteps;
  }
}
