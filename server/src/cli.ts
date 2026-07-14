#!/usr/bin/env node

/**
 * Standalone CLI entry point: `npx pixel-agents`
 *
 * Starts the Fastify server in standalone mode with SPA serving and WebSocket.
 * Loads all assets (PNGs -> SpriteData) on startup and caches in memory.
 * Each connecting WebSocket client receives the full state on webviewReady.
 */

import * as path from 'path';

import { AgentRuntime } from './agentRuntime.js';
import { AgentStateStore } from './agentStateStore.js';
import {
  loadCharacterSprites,
  loadDefaultLayout,
  loadFloorTiles,
  loadFurnitureAssets,
  loadPetSprites,
  loadWallTiles,
} from './assetLoader.js';
import type { AssetCache } from './clientMessageHandler.js';
import { FileStateAdapter } from './fileStateAdapter.js';
import type { SseBridgeHandle } from './providers/hook/sse/sseBridge.js';
import { claudeProvider, copyHookScript, sseProvider, startSseBridge } from './providers/index.js';
import { PixelAgentsServer } from './server.js';

// ── Argument parsing ──────────────────────────────────────────

interface CliArgs {
  port: number;
  host: string;
  /** Active provider id: 'claude' (default) or 'sse'. */
  provider: string;
  /** Upstream SSE endpoint (provider=sse). */
  sseUrl?: string;
  /** Optional bearer token for the upstream SSE endpoint. */
  sseToken?: string;
}

function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = {
    port: 3100,
    host: '127.0.0.1',
    provider: process.env.PIXEL_AGENTS_PROVIDER ?? '',
    sseUrl: process.env.PIXEL_AGENTS_SSE_URL,
    sseToken: process.env.PIXEL_AGENTS_SSE_TOKEN,
  };
  for (let i = 0; i < argv.length; i++) {
    if ((argv[i] === '--port' || argv[i] === '-p') && argv[i + 1]) {
      args.port = parseInt(argv[i + 1], 10);
      i++;
    } else if (argv[i] === '--host' && argv[i + 1]) {
      args.host = argv[i + 1];
      i++;
    } else if (argv[i] === '--provider' && argv[i + 1]) {
      args.provider = argv[i + 1];
      i++;
    } else if (argv[i] === '--sse-url' && argv[i + 1]) {
      args.sseUrl = argv[i + 1];
      i++;
    } else if (argv[i] === '--sse-token' && argv[i + 1]) {
      args.sseToken = argv[i + 1];
      i++;
    } else if (argv[i] === '--help') {
      console.log(`Usage: pixel-agents [options]

Options:
  --port, -p <number>   Port to listen on (default: 3100)
  --host <string>       Host to bind to (default: 127.0.0.1)
  --provider <id>       Agent provider: 'claude' (default) or 'sse'
  --sse-url <url>       Upstream SSE endpoint (implies --provider sse)
  --sse-token <token>   Bearer token for the upstream SSE endpoint
  --help                Show this help message

Environment variables:
  PIXEL_AGENTS_PROVIDER    Same as --provider
  PIXEL_AGENTS_SSE_URL     Same as --sse-url
  PIXEL_AGENTS_SSE_TOKEN   Same as --sse-token`);
      process.exit(0);
    }
  }
  // --sse-url without an explicit provider implies provider=sse.
  if (!args.provider) {
    args.provider = args.sseUrl ? sseProvider.id : claudeProvider.id;
  }
  if (args.provider !== claudeProvider.id && args.provider !== sseProvider.id) {
    console.error(`Unknown provider "${args.provider}" (expected 'claude' or 'sse')`);
    process.exit(1);
  }
  if (args.provider === sseProvider.id && !args.sseUrl) {
    console.error('Provider "sse" requires --sse-url <url> (or PIXEL_AGENTS_SSE_URL)');
    process.exit(1);
  }
  return args;
}

// ── Main ──────────────────────────────────────────────────────

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  // dist/ contains both the CLI bundle and the assets/ + webview/ directories
  const distRoot = __dirname;
  const staticDir = path.join(distRoot, 'webview');

  // ── Load assets on startup (same pipeline as VS Code extension) ──
  console.log('[Pixel Agents] Loading assets...');
  const assetCache: AssetCache = {
    characters: await loadCharacterSprites(distRoot),
    pets: await loadPetSprites(distRoot),
    floorTiles: await loadFloorTiles(distRoot).then((t) => t?.sprites ?? null),
    wallTiles: await loadWallTiles(distRoot).then((t) => t?.sets ?? null),
    furniture: await loadFurnitureAssets(distRoot),
    defaultLayout: loadDefaultLayout(distRoot),
  };
  const charCount = assetCache.characters?.characters.length ?? 0;
  const petCount = assetCache.pets?.pets.length ?? 0;
  const furnitureCount = assetCache.furniture?.catalog.length ?? 0;
  console.log(
    `[Pixel Agents] Assets loaded: ${charCount} characters, ${petCount} pets, ${furnitureCount} furniture items`,
  );

  // ── Store + adapter (shared settings + standalone-scoped agents/seats) ──
  const store = new AgentStateStore();
  const adapter = new FileStateAdapter({ namespace: 'standalone' });
  store.setAdapter(adapter);

  // ── Provider selection (claude by default, sse for external agent systems) ──
  const provider = args.provider === sseProvider.id ? sseProvider : claudeProvider;
  const isClaude = provider.id === claudeProvider.id;

  // ── Create server ──
  const server = new PixelAgentsServer();

  try {
    // Create runtime first (before server.start, so we can pass it in)
    const runtime = new AgentRuntime(store, provider);

    // Wire hook events: HTTP POST -> runtime -> hookEventHandler -> agents
    server.onHookEvent((providerId, event) => {
      runtime.handleHookEvent(providerId, event);
    });

    // onSetHooksEnabled side effect: install/uninstall hooks when user toggles in UI.
    // Captures config from the outer scope after server.start().
    // No-op for push providers (sse): installHooks resolves without side effects.
    let currentConfig: { port: number; token: string } | null = null;
    const onSetHooksEnabled = async (enabled: boolean): Promise<void> => {
      if (!currentConfig) return;
      if (enabled) {
        await provider.installHooks(`http://127.0.0.1:${currentConfig.port}`, currentConfig.token);
        if (isClaude) copyHookScript(distRoot);
        console.log('[Pixel Agents] Hooks installed (user toggle)');
      } else {
        await provider.uninstallHooks();
        console.log('[Pixel Agents] Hooks uninstalled (user toggle)');
      }
    };

    const config = await server.start({
      store,
      runtime,
      embedded: false,
      host: args.host,
      port: args.port,
      staticDir,
      assetCache,
      onSetHooksEnabled,
      provider,
    });
    currentConfig = { port: config.port, token: config.token };

    // Sync runtime refs with persisted settings BEFORE first scan tick
    runtime.hooksEnabled.current = adapter.getSetting('pixel-agents.hooksEnabled', true);
    runtime.watchAllSessions.current = adapter.getSetting('pixel-agents.watchAllSessions', false);

    // Install hooks on startup if the persisted setting says so (claude only;
    // sse installHooks is a no-op and needs no hook script)
    if (runtime.hooksEnabled.current && isClaude) {
      try {
        await provider.installHooks(`http://127.0.0.1:${config.port}`, config.token);
        copyHookScript(distRoot);
        console.log('[Pixel Agents] Hooks installed');
      } catch (err) {
        console.error('[Pixel Agents] Failed to install hooks:', err);
      }
    }

    // Start scanning for external sessions (Claude running in user's terminal).
    // Push providers (sse) have no session dirs, so scanning is skipped for them.
    const cwd = process.cwd();
    const dirs = provider.getSessionDirs?.(cwd);
    if (dirs && dirs[0]) {
      const projectDir = dirs[0];
      console.log(`[Pixel Agents] Scanning project dir: ${projectDir}`);
      runtime.startProjectScan(projectDir);
      runtime.startExternalScanning(projectDir);
      runtime.startStaleCheck();
    }

    // ── SSE bridge: pump the upstream event stream into the runtime ──
    let sseBridge: SseBridgeHandle | null = null;
    if (provider.id === sseProvider.id && args.sseUrl) {
      console.log(`[Pixel Agents] SSE: bridging ${args.sseUrl}`);
      sseBridge = startSseBridge({ url: args.sseUrl, token: args.sseToken }, (raw) =>
        runtime.handleHookEvent(sseProvider.id, raw),
      );
    }

    console.log(`\n  Pixel Agents server running at http://${args.host}:${config.port}\n`);

    // ── Graceful shutdown ──
    function shutdown(): void {
      console.log('\nShutting down...');
      sseBridge?.stop();
      runtime.dispose();
      server.stop();
      process.exit(0);
    }

    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
  } catch (err) {
    console.error('Failed to start server:', err);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
