import { existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { getGeminiDir } from './rpc.mjs';

let sqliteModulePromise = null;

async function getSqlite() {
  if (!sqliteModulePromise) {
    sqliteModulePromise = import('node:sqlite').catch(() => null);
  }
  return sqliteModulePromise;
}

// --- Minimal zero-dependency protobuf wire decoder ---

function readVarint(buf, pos) {
  let val = 0n;
  let shift = 0n;
  while (pos < buf.length) {
    const b = buf[pos++];
    val |= BigInt(b & 0x7f) << shift;
    if ((b & 0x80) === 0) return [val, pos];
    shift += 7n;
    if (shift > 70n) break;
  }
  throw new Error('Truncated varint');
}

export function decodePbMessage(buf) {
  const fields = new Map();
  if (!buf || buf.length === 0) return fields;
  let pos = 0;
  while (pos < buf.length) {
    try {
      const [tag, nextPos] = readVarint(buf, pos);
      pos = nextPos;
      const fn = Number(tag >> 3n);
      const wt = Number(tag & 7n);
      let val;
      if (wt === 0) {
        [val, pos] = readVarint(buf, pos);
      } else if (wt === 2) {
        const [lenBig, lenPos] = readVarint(buf, pos);
        const len = Number(lenBig);
        pos = lenPos;
        if (len < 0 || pos + len > buf.length) break;
        val = buf.subarray(pos, pos + len);
        pos += len;
      } else if (wt === 1) {
        if (pos + 8 > buf.length) break;
        val = buf.subarray(pos, pos + 8);
        pos += 8;
      } else if (wt === 5) {
        if (pos + 4 > buf.length) break;
        val = buf.subarray(pos, pos + 4);
        pos += 4;
      } else {
        break;
      }
      if (!fields.has(fn)) fields.set(fn, []);
      fields.get(fn).push(val);
    } catch {
      break;
    }
  }
  return fields;
}

function pbInt(fields, fn, fallback = 0) {
  const arr = fields.get(fn);
  if (!arr || arr.length === 0) return fallback;
  const v = arr[arr.length - 1];
  return typeof v === 'bigint' ? Number(v) : fallback;
}

function pbStr(fields, fn, fallback = '') {
  const arr = fields.get(fn);
  if (!arr || arr.length === 0) return fallback;
  const v = arr[arr.length - 1];
  return Buffer.isBuffer(v) ? v.toString('utf8') : fallback;
}

function pbStrList(fields, fn) {
  const arr = fields.get(fn);
  if (!arr || arr.length === 0) return [];
  return arr.filter((v) => Buffer.isBuffer(v)).map((v) => v.toString('utf8'));
}

function cleanPromptForTitle(rawText, maxLen = 64) {
  if (!rawText || typeof rawText !== 'string') return '';
  let text = rawText
    .replace(/<\/?[A-Z_]+>/g, ' ')
    .replace(/\\([\\ ])/g, '$1')
    .replace(/\s+/g, ' ')
    .trim();
  if (!text) return '';
  if (text.length <= maxLen) return text;
  const slice = text.slice(0, maxLen - 1);
  const lastSpace = slice.lastIndexOf(' ');
  const cut = lastSpace >= Math.floor(maxLen * 0.5) ? slice.slice(0, lastSpace) : slice;
  return `${cut.trimEnd()}…`;
}

function extractWorkspaceUrisFromDb(db) {
  const uris = [];
  try {
    const rows = db.prepare('SELECT data FROM trajectory_metadata_blob').all();
    for (const row of rows) {
      const buf = toBuffer(row.data);
      if (!buf) continue;
      const fields = decodePbMessage(buf);
      for (const candidate of [...pbStrList(fields, 7), ...pbStrList(fields, 1)]) {
        const trimmed = candidate.trim();
        if (/^(file|vscode-remote):\/\//i.test(trimmed) && !uris.includes(trimmed)) {
          uris.push(trimmed);
        }
      }
    }
  } catch {
    // ignore missing or malformed trajectory_metadata_blob
  }
  return uris;
}

function extractPromptTitleFromPayload(payloadBuf) {
  const buf = toBuffer(payloadBuf);
  if (!buf) return '';
  const fields = decodePbMessage(buf);

  // UserInput step (step_type 14 -> field 19)
  const userInput = pbMsg(fields, 19);
  if (userInput) {
    const direct = cleanPromptForTitle(pbStr(userInput, 2));
    if (direct) return direct;
    const chunks = userInput.get(3) || [];
    const combined = chunks
      .map((item) => (Buffer.isBuffer(item) ? pbStr(decodePbMessage(item), 1) : ''))
      .filter(Boolean)
      .join(' ');
    const fromChunks = cleanPromptForTitle(combined);
    if (fromChunks) return fromChunks;
  }

  // Subagent / AgentMessage step (step_type 101 -> field 114 -> field 4 -> field 4)
  const agentMsg = pbMsg(fields, 114);
  if (agentMsg) {
    const inner = pbMsg(agentMsg, 4);
    const body = cleanPromptForTitle(inner ? pbStr(inner, 4) : pbStr(agentMsg, 1));
    if (body) return body;
  }

  return '';
}

function buildFallbackTitle(promptTitle, workspaceUris, cascadeId) {
  if (promptTitle) return promptTitle;
  const firstUri = workspaceUris?.[0] || '';
  if (firstUri) {
    try {
      const clean = decodeURIComponent(firstUri).replace(/\/+$/, '');
      const base = clean.slice(clean.lastIndexOf('/') + 1);
      if (base) return `${base} (${cascadeId.slice(0, 8)})`;
    } catch {
      // ignore URI decode issues
    }
  }
  return cascadeId ? `Session ${cascadeId.slice(0, 8)}` : 'Active Session';
}

function pbMsg(fields, fn) {
  const arr = fields.get(fn);
  if (!arr || arr.length === 0) return null;
  const v = arr[arr.length - 1];
  return Buffer.isBuffer(v) ? decodePbMessage(v) : null;
}

function pbPackedVarints(fields, fn) {
  const arr = fields.get(fn);
  if (!arr || arr.length === 0) return [];
  const out = [];
  for (const v of arr) {
    if (typeof v === 'bigint') {
      out.push(Number(v));
    } else if (Buffer.isBuffer(v)) {
      let pos = 0;
      while (pos < v.length) {
        try {
          const [n, next] = readVarint(v, pos);
          out.push(Number(n));
          pos = next;
        } catch {
          break;
        }
      }
    }
  }
  return out;
}

function pbTimestampIso(fields, fn) {
  const ts = pbMsg(fields, fn);
  if (!ts) return '';
  const seconds = pbInt(ts, 1, 0);
  if (!seconds) return '';
  const nanos = pbInt(ts, 2, 0);
  return new Date(seconds * 1000 + Math.floor(nanos / 1e6)).toISOString();
}

export function getConversationDirs(customDirs) {
  if (Array.isArray(customDirs) && customDirs.length > 0) return customDirs;
  const gdir = getGeminiDir();
  return [
    join(gdir, 'antigravity', 'conversations'),
    join(gdir, 'antigravity-ide', 'conversations'),
    join(gdir, 'antigravity-cli', 'conversations'),
  ];
}

export function listLocalDbConversations(customDirs) {
  const seen = new Map();
  for (const dir of getConversationDirs(customDirs)) {
    if (!existsSync(dir)) continue;
    let files = [];
    try {
      files = readdirSync(dir);
    } catch {
      continue;
    }
    for (const file of files) {
      if (!file.endsWith('.db')) continue;
      const cascadeId = file.slice(0, -3);
      const dbPath = join(dir, file);
      try {
        const st = statSync(dbPath);
        if (!st.isFile()) continue;
        const existing = seen.get(cascadeId);
        if (!existing || st.mtimeMs > existing.mtimeMs) {
          seen.set(cascadeId, {
            cascadeId,
            dbPath,
            mtimeMs: st.mtimeMs,
            lastModifiedTime: new Date(st.mtimeMs).toISOString(),
          });
        }
      } catch {
        // ignore stat errors
      }
    }
  }
  return [...seen.values()].sort((a, b) => b.mtimeMs - a.mtimeMs);
}

function toBuffer(v) {
  if (!v) return null;
  if (Buffer.isBuffer(v)) return v;
  if (v instanceof Uint8Array) return Buffer.from(v.buffer, v.byteOffset, v.byteLength);
  return null;
}

export async function readConversationFromSqlite(dbPath) {
  const sqlite = await getSqlite();
  if (!sqlite || !existsSync(dbPath)) return null;

  let db;
  try {
    db = new sqlite.DatabaseSync(dbPath, { readOnly: true });
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table'")
      .all()
      .map((r) => r.name);

    const genMetadata = [];
    const steps = [];
    const workspaceUris = tables.includes('trajectory_metadata_blob') ? extractWorkspaceUrisFromDb(db) : [];
    let promptTitle = '';

    if (tables.includes('steps')) {
      const cols = db.prepare('PRAGMA table_info(steps)').all().map((c) => c.name);
      const orderCol = cols.includes('idx') ? 'idx' : 'rowid';
      const rows = db.prepare(`SELECT * FROM steps ORDER BY ${orderCol} ASC`).all();
      for (const row of rows) {
        const idx = typeof row.idx === 'number' ? row.idx : steps.length;
        const stepType = row.step_type ?? row.type ?? 0;
        const status = row.status ?? 0;
        if (!promptTitle && row.step_payload && (stepType === 14 || stepType === 101 || idx === 0)) {
          promptTitle = extractPromptTitleFromPayload(row.step_payload);
        }
        const mdBuf = toBuffer(row.metadata);
        const mdFields = mdBuf ? decodePbMessage(mdBuf) : new Map();

        const tcMsg = pbMsg(mdFields, 4);
        const toolCall = tcMsg
          ? {
              id: pbStr(tcMsg, 1),
              name: pbStr(tcMsg, 2),
              argumentsJson: pbStr(tcMsg, 3),
            }
          : undefined;

        const createdAt = pbTimestampIso(mdFields, 1);
        const generatorModel = pbStr(mdFields, 17) || pbStr(mdFields, 2);
        const toolCallOutputTokens = pbInt(mdFields, 23, 0);

        steps.push({
          idx,
          type: typeof stepType === 'number' ? `STEP_TYPE_${stepType}` : String(stepType),
          numericType: typeof stepType === 'number' ? stepType : undefined,
          status: String(status),
          metadata: {
            createdAt,
            generatorModel,
            toolCallOutputTokens,
            ...(toolCall ? { toolCall } : {}),
          },
        });
      }
    }

    if (tables.includes('gen_metadata')) {
      const rows = db.prepare('SELECT rowid, * FROM gen_metadata ORDER BY rowid ASC').all();
      for (const row of rows) {
        const dataBuf = toBuffer(row.data);
        if (!dataBuf) continue;
        const root = decodePbMessage(dataBuf);
        const chatModelMsg = pbMsg(root, 1);
        const stepIndices = pbPackedVarints(root, 2);
        if (!chatModelMsg) continue;

        const usageMsg = pbMsg(chatModelMsg, 4);
        const startMetaMsg = pbMsg(chatModelMsg, 9);
        const createdAt = startMetaMsg ? pbTimestampIso(startMetaMsg, 4) : '';
        const startStepIndex = startMetaMsg ? pbInt(startMetaMsg, 1, 0) : 0;

        let model = pbStr(chatModelMsg, 19);
        const displayName = pbStr(chatModelMsg, 21);
        // Field 20: repeated key/value entries for model_enum
        const kvArr = chatModelMsg.get(20) || [];
        for (const item of kvArr) {
          if (!Buffer.isBuffer(item)) continue;
          const kv = decodePbMessage(item);
          if (pbStr(kv, 1) === 'model_enum' && pbStr(kv, 2)) {
            model = pbStr(kv, 2);
          }
        }

        const usage = usageMsg
          ? {
              model: pbStr(usageMsg, 1) || model,
              inputTokens: pbInt(usageMsg, 2, 0),
              outputTokens: pbInt(usageMsg, 3, 0),
              cacheCreationTokens: pbInt(usageMsg, 4, 0),
              cacheReadTokens: pbInt(usageMsg, 5, 0),
              thinkingOutputTokens: pbInt(usageMsg, 9, 0),
              responseOutputTokens: pbInt(usageMsg, 10, 0),
            }
          : null;

        genMetadata.push({
          stepIndices,
          chatModel: {
            model,
            modelDisplayName: displayName,
            usage,
            chatStartMetadata: {
              createdAt,
              startStepIndex,
            },
          },
        });
      }
    }

    const latestCm = [...genMetadata].reverse().find((g) => g.chatModel?.modelDisplayName || g.chatModel?.model)?.chatModel;
    const cascadeId = dbPath.split('/').pop().replace(/\.db$/i, '');
    return {
      genMetadata,
      steps,
      workspaceUris,
      title: buildFallbackTitle(promptTitle, workspaceUris, cascadeId),
      model: latestCm?.usage?.model || latestCm?.model || '',
      modelDisplayName: latestCm?.modelDisplayName || '',
    };
  } catch {
    return null;
  } finally {
    try {
      db?.close();
    } catch {
      // ignore close error
    }
  }
}

export async function readConversationSummaryFromSqlite(dbPath, cascadeId = '') {
  const sqlite = await getSqlite();
  if (!sqlite || !existsSync(dbPath)) return null;

  let db;
  try {
    db = new sqlite.DatabaseSync(dbPath, { readOnly: true });
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table'")
      .all()
      .map((r) => r.name);

    const workspaceUris = tables.includes('trajectory_metadata_blob') ? extractWorkspaceUrisFromDb(db) : [];
    let promptTitle = '';

    if (tables.includes('steps')) {
      const cols = db.prepare('PRAGMA table_info(steps)').all().map((c) => c.name);
      if (cols.includes('step_payload')) {
        const orderCol = cols.includes('idx') ? 'idx' : 'rowid';
        const rows = db
          .prepare(`SELECT step_payload FROM steps WHERE step_type IN (14, 101) OR ${orderCol} = 0 ORDER BY ${orderCol} ASC LIMIT 4`)
          .all();
        for (const r of rows) {
          promptTitle = extractPromptTitleFromPayload(r.step_payload);
          if (promptTitle) break;
        }
      }
    }

    let model = '';
    let modelDisplayName = '';
    if (tables.includes('gen_metadata')) {
      const gmRows = db.prepare('SELECT data FROM gen_metadata ORDER BY rowid DESC LIMIT 5').all();
      for (const row of gmRows) {
        const dataBuf = toBuffer(row.data);
        if (!dataBuf) continue;
        const root = decodePbMessage(dataBuf);
        const chatModelMsg = pbMsg(root, 1);
        if (!chatModelMsg) continue;
        const usageMsg = pbMsg(chatModelMsg, 4);
        const dn = pbStr(chatModelMsg, 21);
        const m = (usageMsg && pbStr(usageMsg, 1)) || pbStr(chatModelMsg, 19);
        if (dn || m) {
          model = m;
          modelDisplayName = dn;
          break;
        }
      }
    }

    const id = cascadeId || dbPath.split('/').pop().replace(/\.db$/i, '');
    return {
      title: buildFallbackTitle(promptTitle, workspaceUris, id),
      workspaceUris,
      model,
      modelDisplayName,
    };
  } catch {
    return null;
  } finally {
    try {
      db?.close();
    } catch {
      // ignore close error
    }
  }
}
