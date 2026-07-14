import { expect, test } from '../../fixtures/standalone';
import type { StandaloneContext } from '../../fixtures/standalone';
import { expectOverlayCount, expectOverlayVisible } from '../../helpers/office';
import type { SseUpstream } from '../../helpers/sse-upstream';
import type { RecordedServerMessage } from '../../helpers/standalone';
import { setSettings } from '../../helpers/webview';

test.use({ standaloneLaunch: { provider: 'sse' } });

function requireUpstream(standalone: StandaloneContext): SseUpstream {
  if (!standalone.sseUpstream) {
    throw new Error('standalone fixture was not launched with provider sse');
  }
  return standalone.sseUpstream;
}

/**
 * Drain-accumulating wait for a specific ServerMessage. drainMessages() clears
 * the recorder store on every call, so a plain expect.poll over a fresh drain
 * would drop earlier frames; this accumulates across polls and returns
 * everything collected once the predicate matches.
 */
async function waitForServerMessage(
  standalone: StandaloneContext,
  predicate: (message: RecordedServerMessage) => boolean,
): Promise<RecordedServerMessage[]> {
  const collected: RecordedServerMessage[] = [];
  await expect
    .poll(
      async () => {
        collected.push(...(await standalone.drainMessages()));
        return collected.some(predicate);
      },
      { timeout: 15_000 },
    )
    .toBe(true);
  return collected;
}

test.describe('Standalone / SSE provider', () => {
  test('visualizes an external SSE agent through its full lifecycle @area:standalone', async ({
    page,
    standalone,
  }) => {
    const upstream = requireUpstream(standalone);
    await upstream.waitForConnection();

    await setSettings(page, { alwaysShowLabels: true });
    await standalone.drainMessages();

    const ids = { agent_id: 'agent-backend', session_id: 'session-abc' };

    // session started -> character spawns carrying the upstream display name
    upstream.sendEvent('agent.session.started', {
      ...ids,
      name: 'Backend Engineer',
      role: 'coder',
      project: '/workspace/payments-api',
    });
    await expectOverlayVisible(page, 'Backend Engineer');
    const createdMessages = await standalone.drainMessages();
    const created = createdMessages.find((message) => message.type === 'agentCreated');
    expect(created).toBeTruthy();
    expect(created?.folderName).toBe('Backend Engineer');
    expect(created?.isExternal).toBe(true);
    expect(created?.hooksOnly).toBe(true);

    // status change -> the message becomes the activity label, agent goes active
    upstream.sendEvent('agent.status.changed', {
      ...ids,
      status: 'working',
      activity: 'editing',
      message: 'Editing payment validation',
    });
    await expectOverlayVisible(page, 'Editing payment validation');
    const statusMessages = await standalone.drainMessages();
    expect(
      statusMessages.some(
        (message) => message.type === 'agentStatus' && message.status === 'active',
      ),
    ).toBe(true);

    // tool started -> "Running: <command>" label; the open status-tool closes
    // first (the bridge keeps at most one hook-tool open per session)
    upstream.sendEvent('agent.tool.started', { ...ids, tool: 'shell', command: 'npm test' });
    await expectOverlayVisible(page, 'Running: npm test');
    const toolMessages = await standalone.drainMessages();
    const toolStart = toolMessages
      .filter(
        (message): message is RecordedServerMessage & { type: 'agentToolStart' } =>
          message.type === 'agentToolStart',
      )
      .find((message) => message.status === 'Running: npm test');
    expect(toolStart).toBeTruthy();
    expect(toolMessages.some((message) => message.type === 'agentToolDone')).toBe(true);

    // permission requested -> attention bubble
    upstream.sendEvent('agent.permission.requested', {
      ...ids,
      permission_id: 'perm-789',
      message: 'Wants to modify package.json',
    });
    await expectOverlayVisible(page, 'Needs approval');
    const permissionMessages = await standalone.drainMessages();
    expect(permissionMessages.some((message) => message.type === 'agentToolPermission')).toBe(true);

    // tool completed -> the shell tool closes
    upstream.sendEvent('agent.tool.completed', { ...ids, tool: 'shell', success: true });
    await waitForServerMessage(
      standalone,
      (message) => message.type === 'agentToolDone' && message.toolId === toolStart?.toolId,
    );

    // session completed -> turn ends: tools clear, agent waits ("Done" checkmark),
    // but the character stays in the office
    upstream.sendEvent('agent.session.completed', { ...ids, result: 'success' });
    const stopMessages = await waitForServerMessage(
      standalone,
      (message) => message.type === 'agentStatus' && message.status === 'waiting',
    );
    expect(stopMessages.some((message) => message.type === 'agentToolsClear')).toBe(true);
    await expectOverlayCount(page, 1);

    // session ended -> character despawns
    upstream.sendEvent('agent.session.ended', { ...ids, result: 'success' });
    await expectOverlayCount(page, 0);
    const closedMessages = await standalone.drainMessages();
    expect(closedMessages.some((message) => message.type === 'agentClosed')).toBe(true);
  });

  test('supports concurrent agents and adopts sessions seen mid-stream @area:standalone', async ({
    page,
    standalone,
  }) => {
    const upstream = requireUpstream(standalone);
    await upstream.waitForConnection();

    await setSettings(page, { alwaysShowLabels: true });
    await standalone.drainMessages();

    // two announced agents spawn two characters
    upstream.sendEvent('agent.session.started', {
      agent_id: 'agent-backend',
      session_id: 'session-1',
      name: 'Backend Engineer',
    });
    upstream.sendEvent('agent.session.started', {
      agent_id: 'agent-frontend',
      session_id: 'session-1',
      name: 'Frontend Engineer',
    });
    await expectOverlayCount(page, 2);
    await expectOverlayVisible(page, 'Backend Engineer');
    await expectOverlayVisible(page, 'Frontend Engineer');

    // an event for a session that never announced itself (e.g. the server
    // restarted mid-run) synthesizes a sessionStart: the character appears,
    // falling back to agent_id as its display name
    upstream.sendEvent('agent.status.changed', {
      agent_id: 'agent-rogue',
      session_id: 'session-9',
      status: 'working',
      message: 'Recovering after restart',
    });
    await expectOverlayCount(page, 3);
    await expectOverlayVisible(page, 'agent-rogue');
    await expectOverlayVisible(page, 'Recovering after restart');

    // activity routes to the right character; the others stay untouched
    upstream.sendEvent('agent.tool.started', {
      agent_id: 'agent-backend',
      session_id: 'session-1',
      tool: 'read',
      message: 'Reading DB schema',
    });
    await expectOverlayVisible(page, 'Reading DB schema');
    await expectOverlayVisible(page, 'Frontend Engineer');

    // ending each session removes exactly that character
    upstream.sendEvent('agent.session.ended', {
      agent_id: 'agent-rogue',
      session_id: 'session-9',
    });
    await expectOverlayCount(page, 2);
    upstream.sendEvent('agent.session.ended', {
      agent_id: 'agent-backend',
      session_id: 'session-1',
    });
    upstream.sendEvent('agent.session.ended', {
      agent_id: 'agent-frontend',
      session_id: 'session-1',
    });
    await expectOverlayCount(page, 0);
  });
});
