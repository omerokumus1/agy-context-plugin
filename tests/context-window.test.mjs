import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';

import { readConversationFromSqlite } from '../sidecars/context_window/lib/sqlite-fallback.mjs';
import { buildContextTelemetry, formatTokens } from '../sidecars/context_window/lib/telemetry.mjs';
import { createContextService, startStandaloneServer } from '../sidecars/context_window/main.mjs';

const REPO_ROOT = resolve(import.meta.dirname, '..');

function encodeVarint(num) {
  let n = BigInt(num);
  const bytes = [];
  while (true) {
    const b = Number(n & 0x7fn);
    n >>= 7n;
    if (n === 0n) {
      bytes.push(b);
      break;
    }
    bytes.push(b | 0x80);
  }
  return Buffer.from(bytes);
}

function pbFieldVarint(fn, val) {
  return Buffer.concat([encodeVarint((fn << 3) | 0), encodeVarint(val)]);
}

function pbFieldBytes(fn, buf) {
  return Buffer.concat([encodeVarint((fn << 3) | 2), encodeVarint(buf.length), buf]);
}

function pbFieldStr(fn, str) {
  return pbFieldBytes(fn, Buffer.from(str, 'utf8'));
}

test('manifest files plugin.json and sidecar.json are valid and properly configured', () => {
  const pluginManifest = JSON.parse(readFileSync(join(REPO_ROOT, 'plugin.json'), 'utf8'));
  assert.match(pluginManifest.name, /^[a-z0-9]+(-[a-z0-9]+)*$/);
  assert.equal(pluginManifest.displayName, 'Context Window');
  assert.ok(existsSync(join(REPO_ROOT, pluginManifest.logo)));

  const sidecarCfg = JSON.parse(readFileSync(join(REPO_ROOT, 'sidecars/context_window/sidecar.json'), 'utf8'));
  assert.equal(sidecarCfg.command, 'node');
  assert.equal(sidecarCfg.has_web_ui, true);
  assert.equal(sidecarCfg.ui_config.views.length, 2);
  assert.equal(sidecarCfg.ui_config.views[0].entrypoint, 'SIDECAR_UI_ENTRYPOINT_AUX_PANE');
  assert.equal(sidecarCfg.ui_config.views[1].entrypoint, 'SIDECAR_UI_ENTRYPOINT_SIDEBAR');
});

test('buildContextTelemetry computes additive cache metrics, compaction drops, and top spikes', () => {
  const trajectory = {
    cascadeId: 'test-cascade-1',
    summary: 'selam ortak nerede kalmıştık',
    requestedModel: 'gemini-4-neon-high',
    status: 'IDLE',
    createdTime: '2026-11-25T09:00:00.000Z',
    lastModifiedTime: '2026-11-25T09:07:00.000Z',
  };

  const genMetadata = [
    {
      stepIndices: [1],
      chatModel: {
        model: 'gemini-4-neon-high',
        usage: { inputTokens: 10_000, cacheReadTokens: 0, outputTokens: 1_000, thinkingOutputTokens: 400 },
        chatStartMetadata: { createdAt: '2026-11-25T09:01:00.000Z', startStepIndex: 1 },
      },
    },
    {
      stepIndices: [4],
      chatModel: {
        model: 'gemini-4-neon-high',
        usage: { inputTokens: 20_000, cacheReadTokens: 20_000, outputTokens: 1_500 },
        chatStartMetadata: { createdAt: '2026-11-25T09:02:00.000Z', startStepIndex: 4 },
      },
    },
    {
      stepIndices: [10],
      chatModel: {
        model: 'gemini-4-neon-high',
        usage: { inputTokens: 5_000, cacheReadTokens: 15_000, outputTokens: 800 },
        chatStartMetadata: { createdAt: '2026-11-25T09:04:00.000Z', startStepIndex: 10 },
      },
    },
    {
      stepIndices: [23],
      chatModel: {
        model: 'gemini-4-neon-high',
        usage: { inputTokens: 14_900, cacheReadTokens: 163_000, outputTokens: 2_000 },
        chatStartMetadata: { createdAt: '2026-11-25T09:06:30.000Z', startStepIndex: 23 },
      },
    },
  ];

  const steps = [
    { idx: 2, metadata: { toolCall: { name: 'view_file', argumentsJson: '{"AbsolutePath":"/repo/MEMORY.md"}' } } },
    { idx: 3, metadata: { toolCall: { name: 'list_dir', argumentsJson: '{"DirectoryPath":"/repo"}' } } },
    { idx: 20, metadata: { toolCall: { name: 'view_file', argumentsJson: '{"AbsolutePath":"/repo/plugin.json"}' } } },
    { idx: 21, metadata: { toolCall: { name: 'view_file', argumentsJson: '{"AbsolutePath":"/repo/sidecar.json"}' } } },
  ];

  const t = buildContextTelemetry({ trajectory, genMetadata, steps, nowMs: Date.parse('2026-11-25T09:07:39.000Z') });

  assert.equal(t.context.cacheTokens, 163_000);
  assert.equal(t.context.uncachedTokens, 14_900);
  assert.equal(t.context.usedTokens, 177_900);
  assert.equal(t.context.limitTokens, 1_000_000);
  assert.equal(t.context.freeTokens, 822_100);
  assert.ok(Math.abs(t.metrics.cacheHitLastTurnPct - 91.62) < 0.1);
  assert.equal(t.metrics.totalOutputTokens, 5_300);
  assert.equal(t.metrics.turnCount, 4);
  assert.equal(t.metrics.toolCount, 4);
  assert.equal(t.timeline.turns[2].isCompaction, true);

  assert.equal(t.topSpikes[0].stepIndex, 23);
  assert.equal(t.topSpikes[0].deltaTokens, 157_900);
  assert.equal(t.topSpikes[0].badge, 'read_file');
  assert.equal(t.topSpikes[0].detail, 'plugin.json +1');

  assert.equal(t.topSpikes[1].stepIndex, 4);
  assert.equal(t.topSpikes[1].badge, '2 tools');
  assert.equal(t.topSpikes[1].detail, 'read_file · MEMORY.md');

  assert.equal(formatTokens(177_900), '178K');
  assert.equal(formatTokens(14_900), '14.9K');
  assert.equal(formatTokens(1_000_000), '1M');
});

test('readConversationFromSqlite decodes protobuf gen_metadata and steps from a real SQLite DB', async () => {
  const { DatabaseSync } = await import('node:sqlite');
  const tempDir = mkdtempSync(join(tmpdir(), 'cw-sqlite-'));
  const dbPath = join(tempDir, 'test-session.db');

  try {
    const db = new DatabaseSync(dbPath);
    db.exec(`
      CREATE TABLE steps (idx INTEGER PRIMARY KEY, step_type INTEGER, status INTEGER, metadata BLOB);
      CREATE TABLE gen_metadata (data BLOB);
    `);

    const tcBlob = Buffer.concat([
      pbFieldStr(1, 'call-1'),
      pbFieldStr(2, 'read_file'),
      pbFieldStr(3, '{"AbsolutePath":"/tmp/app.js"}'),
    ]);
    const stepMdBlob = pbFieldBytes(4, tcBlob);
    db.prepare('INSERT INTO steps (idx, step_type, status, metadata) VALUES (?, ?, ?, ?)').run(5, 132, 3, stepMdBlob);

    const usageBlob = Buffer.concat([
      pbFieldStr(1, 'gemini-4-neon-high'),
      pbFieldVarint(2, 12_000),
      pbFieldVarint(3, 1_500),
      pbFieldVarint(4, 500),
      pbFieldVarint(5, 80_000),
      pbFieldVarint(9, 600),
      pbFieldVarint(10, 900),
    ]);
    const chatModelBlob = Buffer.concat([
      pbFieldBytes(4, usageBlob),
      pbFieldStr(19, 'gemini-4-neon-high'),
    ]);
    const packedSteps = Buffer.concat([encodeVarint(5)]);
    const genBlob = Buffer.concat([
      pbFieldBytes(1, chatModelBlob),
      pbFieldBytes(2, packedSteps),
    ]);
    db.prepare('INSERT INTO gen_metadata (data) VALUES (?)').run(genBlob);
    db.close();

    const parsed = await readConversationFromSqlite(dbPath);
    assert.ok(parsed);
    assert.equal(parsed.steps.length, 1);
    assert.equal(parsed.steps[0].metadata.toolCall.name, 'read_file');
    assert.equal(parsed.genMetadata.length, 1);
    assert.equal(parsed.genMetadata[0].chatModel.usage.cacheReadTokens, 80_000);
    assert.equal(parsed.genMetadata[0].chatModel.usage.inputTokens, 12_000);
    assert.deepEqual(parsed.genMetadata[0].stepIndices, [5]);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test('standalone HTTP server serves UI, demo snapshot with ETag, and persists preferences', async () => {
  const tempData = mkdtempSync(join(tmpdir(), 'cw-prefs-'));
  const service = createContextService({ demo: true, dataDir: tempData });
  const srv = await startStandaloneServer(service, { port: 0 });

  try {
    const healthRes = await fetch(`${srv.url}/api/health`);
    assert.equal(healthRes.status, 200);
    const health = await healthRes.json();
    assert.equal(health.ok, true);
    assert.equal(health.name, 'agy-context-plugin');

    const auxHtml = await (await fetch(`${srv.url}/`)).text();
    assert.match(auxHtml, /<script src="\/preload\.js"><\/script>/);

    const fullHtml = await (await fetch(`${srv.url}/full`)).text();
    assert.match(fullHtml, /Turn Ledger/);

    const snap1 = await (await fetch(`${srv.url}/api/snapshot`)).json();
    assert.equal(snap1.unchanged, false);
    assert.equal(snap1.snapshot.context.limitTokens, 1_000_000);
    assert.equal(snap1.snapshot.topSpikes.length, 5);

    const snapCached = await (await fetch(`${srv.url}/api/snapshot?etag=${snap1.etag}`)).json();
    assert.equal(snapCached.unchanged, true);

    const prefRes = await fetch(`${srv.url}/api/preferences`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ overrideLimit: 256_000 }),
    });
    assert.equal((await prefRes.json()).ok, true);

    const snap2 = await (await fetch(`${srv.url}/api/snapshot`)).json();
    assert.equal(snap2.snapshot.context.limitTokens, 256_000);
    assert.equal(snap2.snapshot.context.overrideLimit, 256_000);
  } finally {
    await srv.close();
    rmSync(tempData, { recursive: true, force: true });
  }
});
