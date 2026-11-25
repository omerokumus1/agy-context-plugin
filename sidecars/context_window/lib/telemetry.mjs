import { resolveContextLimit, resolveModelName, resolveModelSlug } from './rpc.mjs';

const COMPACTION_DROP_THRESHOLD = 10_000;
const SHADOW_MODEL_RE = /flash-lite|title|intent|summary|checkpoint|m50/i;

export function parseNonNegInt(val) {
  if (typeof val === 'number') return Number.isFinite(val) && val > 0 ? Math.round(val) : 0;
  if (typeof val === 'string') {
    const n = Number(val.trim());
    return Number.isFinite(n) && n > 0 ? Math.round(n) : 0;
  }
  return 0;
}

export function formatTokens(n) {
  const num = Number(n) || 0;
  const sign = num < 0 ? '-' : '';
  const abs = Math.abs(num);
  if (abs >= 1_000_000) {
    const m = abs / 1_000_000;
    return sign + (Number.isInteger(m) ? `${m}M` : `${m.toFixed(m >= 10 ? 1 : 2).replace(/\.0+$/, '')}M`);
  }
  if (abs >= 100_000) {
    return `${sign}${Math.round(abs / 1000)}K`;
  }
  if (abs >= 10_000) {
    return `${sign}${(abs / 1000).toFixed(1).replace(/\.0$/, '')}K`;
  }
  if (abs >= 1_000) {
    return `${sign}${(abs / 1000).toFixed(2).replace(/\.?0+$/, '')}K`;
  }
  return `${sign}${Math.round(abs)}`;
}

export function formatTokensCompact(n) {
  const num = Number(n) || 0;
  const sign = num < 0 ? '-' : '';
  const abs = Math.abs(num);
  if (abs >= 1_000_000) {
    const m = abs / 1_000_000;
    return `${sign}${Number.isInteger(m) ? m : m.toFixed(1)}M`;
  }
  if (abs >= 100_000) {
    return `${sign}${Math.round(abs / 1000)}K`;
  }
  if (abs >= 10_000) {
    return `${sign}${(abs / 1000).toFixed(1)}K`;
  }
  if (abs >= 1_000) {
    return `${sign}${(abs / 1000).toFixed(2).replace(/0$/, '')}K`;
  }
  return `${sign}${Math.round(abs)}`;
}

export function formatRelativeAge(isoTime, nowMs = Date.now()) {
  if (!isoTime) return '';
  const ts = Date.parse(isoTime);
  if (!Number.isFinite(ts)) return '';
  const diffSec = Math.max(0, Math.floor((nowMs - ts) / 1000));
  if (diffSec < 5) return 'just now';
  if (diffSec < 60) return `${diffSec}s ago`;
  const diffMin = Math.floor(diffSec / 60);
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffHr = Math.floor(diffMin / 60);
  if (diffHr < 24) return `${diffHr}h ago`;
  const diffDays = Math.floor(diffHr / 24);
  return `${diffDays}d ago`;
}

export function formatDurationCompact(ms) {
  if (!Number.isFinite(ms) || ms <= 0) return '0m';
  const sec = Math.floor(ms / 1000);
  if (sec < 60) return `${sec}s`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m`;
  const hr = Math.floor(min / 60);
  const remMin = min % 60;
  return remMin > 0 ? `${hr}h ${remMin}m` : `${hr}h`;
}

function basenameOf(rawPath) {
  if (!rawPath || typeof rawPath !== 'string') return '';
  const clean = rawPath.replace(/\\/g, '/').replace(/\/+$/, '');
  const idx = clean.lastIndexOf('/');
  return idx >= 0 ? clean.slice(idx + 1) : clean;
}

function extractTargetFromArgs(toolName, argsJson) {
  if (!argsJson || typeof argsJson !== 'string') return '';
  try {
    const args = JSON.parse(argsJson);
    if (!args || typeof args !== 'object') return '';
    for (const key of ['TargetFile', 'AbsolutePath', 'Path', 'FilePath', 'file_path', 'path', 'DirectoryPath', 'SearchDirectory']) {
      if (typeof args[key] === 'string' && args[key].trim()) {
        return basenameOf(args[key].trim());
      }
    }
    if (typeof args.Query === 'string' && args.Query.trim()) {
      return args.Query.trim().slice(0, 26);
    }
    if (typeof args.CommandLine === 'string' && args.CommandLine.trim()) {
      const cmd = args.CommandLine.trim().split(/\s+/).slice(0, 2).join(' ');
      return cmd.slice(0, 26);
    }
    if (typeof args.Url === 'string' && args.Url.trim()) {
      try {
        return new URL(args.Url.trim()).hostname;
      } catch {
        return args.Url.trim().slice(0, 24);
      }
    }
    if (args.ToolName) {
      return String(args.ToolName);
    }
  } catch {
    // ignore invalid JSON
  }
  return '';
}

function normalizeToolName(rawName) {
  const s = String(rawName || '').trim();
  if (!s) return 'tool';
  if (s === 'view_file') return 'read_file';
  if (s === 'write_to_file') return 'write_file';
  if (s === 'replace_file_content' || s === 'multi_replace_file_content') return 'edit_file';
  return s;
}

export function extractToolsFromSteps(steps) {
  const toolsByStep = new Map();
  let totalTools = 0;

  for (let i = 0; i < (steps || []).length; i++) {
    const step = steps[i];
    if (!step || typeof step !== 'object') continue;
    const stepIdx = typeof step.idx === 'number' ? step.idx : i;
    const meta = step.metadata || {};
    const stepTools = [];

    if (meta.toolCall && typeof meta.toolCall === 'object' && meta.toolCall.name) {
      const name = normalizeToolName(meta.toolCall.name);
      if (name !== 'send_message') {
        const target = extractTargetFromArgs(name, meta.toolCall.argumentsJson);
        stepTools.push({
          stepIndex: stepIdx,
          name,
          target,
          outputTokens: parseNonNegInt(meta.toolCallOutputTokens),
        });
      }
    }

    const plannerToolCalls = step.plannerResponse?.toolCalls;
    if (Array.isArray(plannerToolCalls)) {
      for (const tc of plannerToolCalls) {
        if (!tc || !tc.name) continue;
        const name = normalizeToolName(tc.name);
        if (name === 'send_message') continue;
        // Avoid duplicating if toolCall metadata already counted on same step
        if (!stepTools.some((t) => t.name === name)) {
          stepTools.push({
            stepIndex: stepIdx,
            name,
            target: extractTargetFromArgs(name, tc.argumentsJson),
            outputTokens: 0,
          });
        }
      }
    }

    if (stepTools.length === 0) {
      if (step.viewFile?.absolutePathUri) {
        stepTools.push({
          stepIndex: stepIdx,
          name: 'read_file',
          target: basenameOf(step.viewFile.absolutePathUri),
          outputTokens: parseNonNegInt(meta.toolCallOutputTokens),
        });
      } else if (step.runCommand?.commandLine) {
        stepTools.push({
          stepIndex: stepIdx,
          name: 'run_command',
          target: String(step.runCommand.commandLine).trim().split(/\s+/).slice(0, 2).join(' ').slice(0, 26),
          outputTokens: parseNonNegInt(meta.toolCallOutputTokens),
        });
      } else if (step.codeAction?.actionSpec?.createFile || step.codeAction?.actionSpec?.editFile) {
        const uri = step.codeAction.actionSpec.createFile?.path?.absoluteUri || step.codeAction.actionSpec.editFile?.path?.absoluteUri || '';
        stepTools.push({
          stepIndex: stepIdx,
          name: step.codeAction.actionSpec.createFile ? 'write_file' : 'edit_file',
          target: basenameOf(uri),
          outputTokens: parseNonNegInt(meta.toolCallOutputTokens),
        });
      }
    }

    if (stepTools.length > 0) {
      toolsByStep.set(stepIdx, stepTools);
      totalTools += stepTools.length;
    }
  }

  return { toolsByStep, totalTools };
}

function summarizeTurnTools(tools) {
  if (!tools || tools.length === 0) {
    return { badge: 'prompt', detail: 'context turn' };
  }
  if (tools.length === 1) {
    return {
      badge: tools[0].name,
      detail: tools[0].target || 'step output',
    };
  }
  const uniqueNames = [...new Set(tools.map((t) => t.name))];
  const firstWithTarget = tools.find((t) => t.target) || tools[0];
  if (uniqueNames.length === 1) {
    return {
      badge: uniqueNames[0],
      detail: firstWithTarget.target ? `${firstWithTarget.target} +${tools.length - 1}` : `${tools.length} calls`,
    };
  }
  return {
    badge: `${tools.length} tools`,
    detail: firstWithTarget.target
      ? `${firstWithTarget.name} · ${firstWithTarget.target}`
      : uniqueNames.slice(0, 2).join(' · '),
  };
}

export function buildContextTelemetry({
  trajectory,
  genMetadata = [],
  steps = [],
  modelCatalog = {},
  overrideLimit = 0,
  nowMs = Date.now(),
}) {
  const { toolsByStep, totalTools } = extractToolsFromSteps(steps);
  const turns = [];
  let totalOutputTokens = 0;
  let totalThinkingTokens = 0;
  let totalResponseTokens = 0;
  let totalCacheReadAll = 0;
  let totalPromptAll = 0;
  let activeModelSlug = trajectory?.requestedModel || trajectory?.generatorModel || '';
  let activeModelDisplay = resolveModelName(activeModelSlug, modelCatalog, trajectory?.modelDisplayName);

  const sortedGen = [...(genMetadata || [])].filter((g) => g && g.chatModel && g.chatModel.usage);
  for (let i = 0; i < sortedGen.length; i++) {
    const entry = sortedGen[i];
    const cm = entry.chatModel;
    const usage = cm.usage || {};
    const stepIndices = Array.isArray(entry.stepIndices) ? entry.stepIndices.map(Number).filter(Number.isFinite) : [];
    const startStep = parseNonNegInt(cm.chatStartMetadata?.startStepIndex);
    const stepIndex = stepIndices.length > 0
      ? Math.max(...stepIndices)
      : (startStep || (i + 1));

    const freshInput = parseNonNegInt(usage.inputTokens);
    const cacheRead = parseNonNegInt(usage.cacheReadTokens);
    const cacheCreation = parseNonNegInt(usage.cacheCreationTokens);
    const totalInput = freshInput + cacheRead + cacheCreation;
    const uncached = freshInput + cacheCreation;

    const thinkingTokens = parseNonNegInt(usage.thinkingOutputTokens);
    const responseTokens = parseNonNegInt(usage.responseOutputTokens);
    const rawOut = parseNonNegInt(usage.outputTokens);
    const outputTokens = rawOut > 0 ? rawOut : (thinkingTokens + responseTokens);

    if (totalInput <= 0 && outputTokens <= 0) continue;

    const rawTurnModel = usage.model || cm.model || cm.responseModel || activeModelSlug;
    const turnModelSlug = resolveModelSlug(rawTurnModel);
    const turnModelDisplay = resolveModelName(rawTurnModel, modelCatalog, cm.modelDisplayName);
    if (
      turnModelSlug &&
      turnModelSlug !== 'unknown' &&
      !SHADOW_MODEL_RE.test(turnModelSlug) &&
      !SHADOW_MODEL_RE.test(turnModelDisplay)
    ) {
      activeModelSlug = turnModelSlug;
      activeModelDisplay = turnModelDisplay;
    }

    const prevTurn = turns[turns.length - 1];
    const deltaTokens = prevTurn ? totalInput - prevTurn.totalTokens : totalInput;
    const isCompaction = Boolean(prevTurn && deltaTokens <= -COMPACTION_DROP_THRESHOLD);
    const cacheHitPct = totalInput > 0 ? (cacheRead / totalInput) * 100 : 0;

    totalOutputTokens += outputTokens;
    totalThinkingTokens += thinkingTokens;
    totalResponseTokens += responseTokens > 0 ? responseTokens : Math.max(0, outputTokens - thinkingTokens);
    totalCacheReadAll += cacheRead;
    totalPromptAll += totalInput;

    const timestamp = cm.chatStartMetadata?.createdAt || '';
    turns.push({
      turnIndex: turns.length + 1,
      stepIndex,
      stepIndices,
      timestamp,
      model: turnModelDisplay,
      totalTokens: totalInput,
      cacheTokens: cacheRead,
      uncachedTokens: uncached,
      outputTokens,
      thinkingTokens,
      cacheHitPct,
      deltaTokens,
      isCompaction,
    });
  }

  // Fallback estimation when genMetadata is empty but steps exist
  if (turns.length === 0 && steps.length > 0) {
    let running = 2500;
    for (let i = 0; i < steps.length; i++) {
      const s = steps[i];
      const stepIdx = typeof s.idx === 'number' ? s.idx : i;
      const outTok = parseNonNegInt(s.metadata?.toolCallOutputTokens) || 120;
      const prev = running;
      running += outTok;
      turns.push({
        turnIndex: turns.length + 1,
        stepIndex: stepIdx,
        stepIndices: [stepIdx],
        timestamp: s.metadata?.createdAt || '',
        model: activeModelDisplay || resolveModelName(activeModelSlug, modelCatalog, trajectory?.modelDisplayName),
        totalTokens: running,
        cacheTokens: Math.round(prev * 0.75),
        uncachedTokens: running - Math.round(prev * 0.75),
        outputTokens: Math.round(outTok * 0.2),
        thinkingTokens: 0,
        cacheHitPct: prev > 0 ? 75 : 0,
        deltaTokens: outTok,
        isCompaction: false,
        estimated: true,
      });
    }
  }

  const latestTurn = turns[turns.length - 1] || null;
  const modelSlug = resolveModelSlug(activeModelSlug || 'unknown');
  const modelDisplay = activeModelDisplay && activeModelDisplay !== 'unknown'
    ? activeModelDisplay
    : resolveModelName(modelSlug, modelCatalog, trajectory?.modelDisplayName);
  const autoLimitTokens = resolveContextLimit(modelSlug, modelCatalog);
  const limitTokens = overrideLimit > 0 ? overrideLimit : autoLimitTokens;

  const cacheTokens = latestTurn ? latestTurn.cacheTokens : 0;
  const uncachedTokens = latestTurn ? latestTurn.uncachedTokens : 0;
  const usedTokens = latestTurn ? latestTurn.totalTokens : 0;
  const freeTokens = Math.max(0, limitTokens - usedTokens);
  const usedPct = limitTokens > 0 ? Math.min(100, (usedTokens / limitTokens) * 100) : 0;

  const cacheHitLastTurnPct = latestTurn ? latestTurn.cacheHitPct : 0;
  const cacheHitSessionPct = totalPromptAll > 0 ? (totalCacheReadAll / totalPromptAll) * 100 : 0;

  // Build Top 5 Spikes by associating tools executed leading into each positive-delta turn
  const spikeCandidates = [];
  for (let i = 0; i < turns.length; i++) {
    const turn = turns[i];
    if (turn.deltaTokens <= 0) continue;
    const prevStep = i > 0 ? turns[i - 1].stepIndex : -1;
    const collectedTools = [];

    // Look for tools between prevStep and current turn.stepIndex
    for (const [sIdx, sTools] of toolsByStep.entries()) {
      if ((sIdx > prevStep && sIdx <= turn.stepIndex) || turn.stepIndices.includes(sIdx)) {
        collectedTools.push(...sTools);
      }
    }

    const summary = summarizeTurnTools(collectedTools);
    spikeCandidates.push({
      turnIndex: turn.turnIndex,
      stepIndex: turn.stepIndex,
      deltaTokens: turn.deltaTokens,
      badge: summary.badge,
      detail: summary.detail,
      toolCount: collectedTools.length,
      tools: collectedTools.slice(0, 8),
    });
  }

  spikeCandidates.sort((a, b) => b.deltaTokens - a.deltaTokens);
  const topSpikes = spikeCandidates.slice(0, 5);

  // Timeline bounds
  const minStep = turns.length > 0 ? turns[0].stepIndex : 1;
  const maxStep = turns.length > 0 ? turns[turns.length - 1].stepIndex : 1;
  const peakTokens = turns.reduce((m, t) => Math.max(m, t.totalTokens), 0);
  const yMax = peakTokens > 0 ? Math.ceil(peakTokens / 1000) * 1000 : 100_000;

  // Session duration
  const firstTs = Date.parse(trajectory?.createdTime || turns[0]?.timestamp || '');
  const lastTs = Date.parse(trajectory?.lastModifiedTime || latestTurn?.timestamp || '');
  const durationMs = Number.isFinite(firstTs) && Number.isFinite(lastTs) && lastTs >= firstTs
    ? lastTs - firstTs
    : 0;

  const lastActivityIso = trajectory?.lastModifiedTime || latestTurn?.timestamp || new Date(nowMs).toISOString();
  const isRunning = /RUNNING|ACTIVE|GENERATING/i.test(String(trajectory?.status || ''));

  const textReport = [
    `Conversation: ${trajectory?.summary || trajectory?.cascadeId || 'Active Session'}`,
    `Model: ${modelDisplay}`,
    `Context: ${formatTokensCompact(usedTokens)} / ${formatTokensCompact(limitTokens)} (${usedPct.toFixed(1)}%)`,
    `  Cache:    ${formatTokensCompact(cacheTokens)}`,
    `  Uncached: ${formatTokensCompact(uncachedTokens)}`,
    `  Free:     ${formatTokensCompact(freeTokens)}`,
    `Cache Hit: ${cacheHitLastTurnPct.toFixed(1)}% (last turn) · ${cacheHitSessionPct.toFixed(1)}% (session)`,
    `Output: ${formatTokensCompact(totalOutputTokens)} total (${formatTokensCompact(totalThinkingTokens)} thinking)`,
    `Activity: ${turns.length} turns · ${totalTools} tools · ${formatDurationCompact(durationMs)}`,
    ...(topSpikes.length > 0
      ? [
          'Top Spikes:',
          ...topSpikes.map((s) => `  #${s.stepIndex}  ${s.badge} (${s.detail})  +${formatTokensCompact(s.deltaTokens)}`),
        ]
      : []),
  ].join('\n');

  return {
    conversation: {
      cascadeId: trajectory?.cascadeId || '',
      title: trajectory?.summary || 'No active conversation',
      model: modelDisplay,
      status: trajectory?.status || 'IDLE',
      isLive: true,
      isRunning,
      lastModifiedTime: lastActivityIso,
      updatedAgo: formatRelativeAge(lastActivityIso, nowMs),
    },
    context: {
      usedTokens,
      cacheTokens,
      uncachedTokens,
      freeTokens,
      limitTokens,
      autoLimitTokens,
      overrideLimit,
      usedPct,
    },
    metrics: {
      cacheHitLastTurnPct,
      cacheHitSessionPct,
      totalOutputTokens,
      totalThinkingTokens,
      totalResponseTokens,
      turnCount: turns.length,
      toolCount: totalTools,
      durationMs,
      durationLabel: formatDurationCompact(durationMs),
    },
    timeline: {
      minStep,
      maxStep,
      yMax,
      yMid: Math.round(yMax / 2),
      turns: turns.map(({ stepIndices, ...rest }) => rest),
    },
    topSpikes,
    textReport,
    generatedAt: new Date(nowMs).toISOString(),
  };
}
