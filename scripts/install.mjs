#!/usr/bin/env node
import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..');
const PLUGIN_ID = 'agy-context-plugin';
const SIDECAR_KEY = 'agy-context-plugin/context_window';

function getGeminiConfigDir() {
  return process.env.ANTIGRAVITY_GEMINI_DIR
    ? join(process.env.ANTIGRAVITY_GEMINI_DIR, 'config')
    : join(homedir(), '.gemini', 'config');
}

function getTargetPluginDir(workspaceMode) {
  if (workspaceMode) {
    return join(process.cwd(), '.agents', 'plugins', PLUGIN_ID);
  }
  return join(getGeminiConfigDir(), 'plugins', PLUGIN_ID);
}

function updateConfigJson(enable) {
  const configDir = getGeminiConfigDir();
  const configPath = join(configDir, 'config.json');
  let config = {};
  if (existsSync(configPath)) {
    try {
      config = JSON.parse(readFileSync(configPath, 'utf8').replace(/^\uFEFF/, ''));
      if (!config || typeof config !== 'object' || Array.isArray(config)) config = {};
    } catch {
      config = {};
    }
  }
  if (!config.sidecars || typeof config.sidecars !== 'object') {
    config.sidecars = {};
  }
  if (enable) {
    config.sidecars[SIDECAR_KEY] = { ...(config.sidecars[SIDECAR_KEY] || {}), enabled: true };
  } else {
    delete config.sidecars[SIDECAR_KEY];
  }
  mkdirSync(configDir, { recursive: true });
  writeFileSync(configPath, JSON.stringify(config, null, 2) + '\n', 'utf8');
  return configPath;
}

function install(workspaceMode) {
  const targetDir = getTargetPluginDir(workspaceMode);
  mkdirSync(dirname(targetDir), { recursive: true });
  rmSync(targetDir, { recursive: true, force: true });
  mkdirSync(targetDir, { recursive: true });

  const itemsToCopy = ['plugin.json', 'README.md', 'LICENSE', 'assets', 'sidecars', 'skills'];
  for (const item of itemsToCopy) {
    const src = join(REPO_ROOT, item);
    if (existsSync(src)) {
      cpSync(src, join(targetDir, item), { recursive: true });
    }
  }

  const configPath = updateConfigJson(true);
  console.log(`Installed "${PLUGIN_ID}" to: ${targetDir}`);
  console.log(`Enabled sidecar "${SIDECAR_KEY}" in: ${configPath}`);
  console.log('Open Antigravity Desktop and toggle the top-right panel or check Plugins > Context Window.');
}

function uninstall(workspaceMode) {
  const targetDir = getTargetPluginDir(workspaceMode);
  if (existsSync(targetDir)) {
    rmSync(targetDir, { recursive: true, force: true });
    console.log(`Removed plugin directory: ${targetDir}`);
  } else {
    console.log(`Plugin not found at: ${targetDir}`);
  }
  const configPath = updateConfigJson(false);
  console.log(`Updated config: ${configPath}`);
}

function status(workspaceMode) {
  const targetDir = getTargetPluginDir(workspaceMode);
  const manifestPath = join(targetDir, 'plugin.json');
  const installed = existsSync(manifestPath);
  const configPath = join(getGeminiConfigDir(), 'config.json');
  let enabled = false;
  if (existsSync(configPath)) {
    try {
      const cfg = JSON.parse(readFileSync(configPath, 'utf8'));
      enabled = Boolean(cfg?.sidecars?.[SIDECAR_KEY]?.enabled);
    } catch {
      enabled = false;
    }
  }
  console.log(JSON.stringify({ installed, enabled, targetDir, configPath }, null, 2));
}

const args = new Set(process.argv.slice(2));
const workspaceMode = args.has('--workspace');

if (args.has('--uninstall')) {
  uninstall(workspaceMode);
} else if (args.has('--status')) {
  status(workspaceMode);
} else {
  install(workspaceMode);
}
