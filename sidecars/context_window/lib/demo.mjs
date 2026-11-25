import { buildContextTelemetry } from './telemetry.mjs';

export function buildDemoState(overrideLimit = 0) {
  const now = Date.now();
  const baseTime = now - 7 * 60 * 1000;

  const trajectory = {
    cascadeId: 'demo-gemini-4-neon-session',
    summary: 'selam ortak nerede kalmıştık',
    status: 'IDLE',
    requestedModel: 'gemini-4-neon-high',
    generatorModel: 'gemini-4-neon-high',
    createdTime: new Date(baseTime).toISOString(),
    lastModifiedTime: new Date(now - 39_000).toISOString(),
    stepCount: 154,
  };

  // Craft realistic 43-turn progression with a compaction dip and rich tool spikes
  const turnsSpec = [
    [1, 14000, 0, 1200],
    [4, 30700, 11000, 1400],
    [8, 36200, 26000, 1100],
    [12, 42800, 33000, 1500],
    [16, 48900, 39000, 1200],
    [19, 55100, 45000, 1800],
    [23, 87900, 52000, 2100], // +32.8K spike
    [27, 92400, 82000, 1400],
    [31, 96100, 87000, 1600],
    [35, 100400, 91000, 1500],
    [38, 120200, 95000, 2200], // +19.8K spike
    [42, 124500, 114000, 1400],
    [46, 128900, 119000, 1600],
    [50, 132100, 123000, 1700],
    [54, 136400, 127000, 1500],
    [58, 140200, 131000, 1800],
    [62, 143500, 135000, 1300],
    [66, 146800, 138000, 1500],
    [70, 149200, 141000, 1600],
    [74, 152100, 144000, 1900],
    [78, 155400, 147000, 1400],
    [81, 163680, 149000, 2100], // +8.28K spike
    [85, 166200, 156000, 1500],
    [89, 168900, 159000, 1700],
    [93, 171500, 162000, 1600],
    [97, 174200, 165000, 1800],
    [101, 176800, 168000, 1400],
    [105, 179100, 171000, 1700],
    [108, 128000, 96000, 2000], // compaction / prune dip
    [111, 134500, 118000, 1500],
    [114, 145000, 127000, 1900], // +10.5K spike
    [118, 148200, 137000, 1600],
    [122, 151800, 141000, 1700],
    [126, 155100, 145000, 1800],
    [130, 158400, 148000, 1600],
    [134, 161900, 151000, 1900],
    [138, 165200, 155000, 1500],
    [141, 168500, 158000, 1800],
    [144, 171200, 161000, 1700],
    [147, 173900, 163000, 1600],
    [150, 175600, 164000, 1900],
    [152, 176800, 162000, 1800],
    [154, 177900, 163000, 2300],
  ];

  const genMetadata = turnsSpec.map(([stepIdx, total, cacheRead, out], i) => ({
    stepIndices: [stepIdx],
    chatModel: {
      model: 'gemini-4-neon-high',
      usage: {
        model: 'gemini-4-neon-high',
        inputTokens: Math.max(0, total - cacheRead),
        cacheReadTokens: cacheRead,
        cacheCreationTokens: 0,
        outputTokens: out,
        thinkingOutputTokens: Math.round(out * 0.45),
        responseOutputTokens: Math.round(out * 0.55),
      },
      chatStartMetadata: {
        createdAt: new Date(baseTime + i * 9500).toISOString(),
        startStepIndex: stepIdx,
      },
    },
  }));

  const steps = [];
  for (let s = 1; s <= 154; s++) {
    let toolCall = null;
    if (s === 3) toolCall = { name: 'read_file', argumentsJson: JSON.stringify({ AbsolutePath: '/proj/MEMORY.md' }) };
    else if (s === 4) toolCall = { name: 'list_dir', argumentsJson: JSON.stringify({ DirectoryPath: '/proj' }) };
    else if (s >= 20 && s <= 23) {
      toolCall = { name: 'read_file', argumentsJson: JSON.stringify({ AbsolutePath: '/proj/plugin.json' }) };
    } else if (s === 37 || s === 38) {
      toolCall = { name: 'write_file', argumentsJson: JSON.stringify({ TargetFile: '/proj/plugin.json' }) };
    } else if (s >= 80 && s <= 81) {
      toolCall = { name: 'edit_file', argumentsJson: JSON.stringify({ TargetFile: '/proj/app.js' }) };
    } else if (s >= 112 && s <= 114) {
      toolCall = { name: 'write_file', argumentsJson: JSON.stringify({ TargetFile: '/proj/plugin.json' }) };
    } else if (s % 2 === 0 && steps.length < 105) {
      toolCall = { name: 'grep_search', argumentsJson: JSON.stringify({ Query: 'context' }) };
    }

    steps.push({
      idx: s,
      type: toolCall ? 'STEP_TYPE_GENERIC' : 'STEP_TYPE_PLANNER_RESPONSE',
      status: 'DONE',
      metadata: {
        createdAt: new Date(baseTime + s * 2600).toISOString(),
        ...(toolCall ? { toolCall } : {}),
      },
    });
  }

  // Pad extra tools at spike 23 & 38 & 114 to match realistic multi-tool counts
  for (let k = 0; k < 3; k++) {
    steps.push({ idx: 21, type: 'STEP_TYPE_GENERIC', metadata: { toolCall: { name: 'read_file', argumentsJson: '{"AbsolutePath":"/proj/sidecar.json"}' } } });
  }
  for (let k = 0; k < 2; k++) {
    steps.push({ idx: 37, type: 'STEP_TYPE_GENERIC', metadata: { toolCall: { name: 'write_file', argumentsJson: '{"TargetFile":"/proj/main.mjs"}' } } });
  }
  for (let k = 0; k < 4; k++) {
    steps.push({ idx: 113, type: 'STEP_TYPE_GENERIC', metadata: { toolCall: { name: 'write_file', argumentsJson: '{"TargetFile":"/proj/ui.html"}' } } });
  }

  const telemetry = buildContextTelemetry({
    trajectory,
    genMetadata,
    steps,
    overrideLimit,
    nowMs: now,
  });

  const conversations = [
    {
      cascadeId: trajectory.cascadeId,
      title: trajectory.summary,
      model: 'gemini-4-neon-high',
      status: 'IDLE',
      lastModifiedTime: trajectory.lastModifiedTime,
      stepCount: 154,
    },
    {
      cascadeId: 'demo-opus-arch-review',
      title: 'plugin architecture & open-source release',
      model: 'claude-opus-5-thinking',
      status: 'IDLE',
      lastModifiedTime: new Date(now - 18 * 60 * 1000).toISOString(),
      stepCount: 62,
    },
  ];

  return { telemetry, conversations };
}
