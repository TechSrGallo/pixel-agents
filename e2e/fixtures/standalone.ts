import { test as base, expect } from '@playwright/test';
import type { TestInfo } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';

import { applyAllureLabels } from '../helpers/allure-labels';
import { type SseUpstream, startSseUpstream } from '../helpers/sse-upstream';
import { launchStandalone, type StandaloneSession } from '../helpers/standalone';

export interface StandaloneContext extends StandaloneSession {
  /** Controllable SSE upstream; present when launched with provider 'sse'. */
  sseUpstream?: SseUpstream;
}

export interface StandaloneLaunchOptions {
  /**
   * 'claude' (default) spawns the bare CLI. 'sse' starts a controllable SSE
   * upstream first and spawns the CLI with --provider sse --sse-url pointed
   * at it; tests drive the office by pushing events through `sseUpstream`.
   */
  provider: 'claude' | 'sse';
}

async function attachTextFileIfExists(
  testInfo: TestInfo,
  name: string,
  filePath: string,
  contentType: string,
): Promise<void> {
  try {
    if (!fs.existsSync(filePath)) return;
    await testInfo.attach(name, {
      body: fs.readFileSync(filePath, 'utf8'),
      contentType,
    });
  } catch {
    // Attachment failures are non-fatal in teardown.
  }
}

async function attachText(
  testInfo: TestInfo,
  name: string,
  body: string,
  contentType: string,
): Promise<void> {
  try {
    if (body.length === 0) return;
    await testInfo.attach(name, {
      body,
      contentType,
    });
  } catch {
    // Attachment failures are non-fatal in teardown.
  }
}

export const test = base.extend<{
  standalone: StandaloneContext;
  standaloneLaunch: StandaloneLaunchOptions;
  _allureLabels: void;
}>({
  // Option fixture: specs opt into SSE mode with
  //   test.use({ standaloneLaunch: { provider: 'sse' } });
  standaloneLaunch: [{ provider: 'claude' }, { option: true }],
  // Auto-fixture: tag every test with Allure epic + feature derived from its
  // @area: annotation and enclosing describe path. Runs before standalone.
  _allureLabels: [
    async ({}, use, testInfo) => {
      await applyAllureLabels(testInfo);
      await use();
    },
    { auto: true },
  ],
  standalone: async ({ page, standaloneLaunch }, use, testInfo) => {
    const sseUpstream = standaloneLaunch.provider === 'sse' ? await startSseUpstream() : null;
    let standalone: StandaloneContext;
    try {
      const session = await launchStandalone(page, {
        extraCliArgs: sseUpstream ? ['--provider', 'sse', '--sse-url', sseUpstream.url] : [],
      });
      standalone = sseUpstream ? { ...session, sseUpstream } : session;
    } catch (error) {
      await sseUpstream?.close();
      throw error;
    }

    try {
      await use(standalone);
    } finally {
      await attachText(testInfo, 'standalone-host-log', standalone.getHostLogs(), 'text/plain');
      await attachTextFileIfExists(
        testInfo,
        'server-json',
        path.join(standalone.tmpHome, '.pixel-agents', 'server.json'),
        'application/json',
      );

      try {
        const screenshotPath = testInfo.outputPath('final-screenshot.png');
        await page.screenshot({ path: screenshotPath });
        await testInfo.attach('final-screenshot', {
          path: screenshotPath,
          contentType: 'image/png',
        });
      } catch {
        // Screenshot failures are non-fatal in teardown.
      }

      await standalone.cleanup();
      await sseUpstream?.close();
    }
  },
});

export { expect };
