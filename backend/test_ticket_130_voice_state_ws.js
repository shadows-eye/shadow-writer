const assert = require('assert');
const http = require('http');
const express = require('express');
const mongoose = require('mongoose');
const WebSocket = require('ws');

process.env.MONGODB_URI = process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017/shadow_writer_test_130';
process.env.MCP_API_KEY = process.env.MCP_API_KEY || 'test-helix-mcp-key-130';
process.env.DISCORD_BOT_TOKEN = '';

const mongoDB = require('./mongoDB');
const { setupHelixEngine } = require('./helixEngine');

function waitForNextMessage(messages, startIndex, timeoutMs = 1500) {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const timer = setInterval(() => {
      if (messages.length > startIndex) {
        clearInterval(timer);
        resolve(messages[startIndex]);
      } else if (Date.now() - start > timeoutMs) {
        clearInterval(timer);
        reject(new Error(`Timed out waiting for WebSocket message at index ${startIndex}`));
      }
    }, 10);
  });
}

async function runTests() {
  if (mongoDB.dbReadyPromise) {
    await mongoDB.dbReadyPromise.catch(() => {});
  }

  const app = express();
  app.use(express.json());
  const server = http.createServer(app);
  const engine = setupHelixEngine(app, server);

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  const apiKey = process.env.MCP_API_KEY;

  const authMessages = [];
  const unauthMessages = [];
  let authWs = null;
  let unauthWs = null;

  try {
    // 1. Connect authenticated WS client and unauthorized WS client
    authWs = new WebSocket(`ws://127.0.0.1:${port}/helix/ws?apiKey=${apiKey}`);
    authWs.on('message', (raw) => {
      authMessages.push(JSON.parse(raw.toString()));
    });
    await new Promise((resolve, reject) => {
      authWs.once('open', resolve);
      authWs.once('error', reject);
    });

    unauthWs = new WebSocket(`ws://127.0.0.1:${port}/helix/ws?apiKey=invalid-key`);
    unauthWs.on('message', (raw) => {
      unauthMessages.push(JSON.parse(raw.toString()));
    });
    const unauthClose = await new Promise((resolve, reject) => {
      unauthWs.once('close', (code, reason) => resolve({ code, reason: reason.toString() }));
      unauthWs.once('error', reject);
    });
    assert.strictEqual(unauthClose.code, 4001, 'Unauthorized WS client must close with 4001');
    assert.strictEqual(unauthMessages.length, 0, 'Unauthorized WS client must receive zero frames');

    // Give server microtask queue a moment to finish adding authWs to authenticatedClients
    await new Promise((r) => setTimeout(r, 50));

    assert.strictEqual(
      typeof engine.handleVoiceStateUpdate,
      'function',
      'engine.handleVoiceStateUpdate must be exposed as a function'
    );

    const makeState = (overrides = {}) => ({
      guild: { id: 'guild-1' },
      id: 'user-1',
      channelId: null,
      mute: false,
      selfMute: false,
      serverMute: false,
      deaf: false,
      selfDeaf: false,
      serverDeaf: false,
      member: { id: 'user-1', user: { id: 'user-1', bot: false } },
      ...overrides
    });

    // 2. Join voice channel (channelId: null -> 'ch-1')
    engine.handleVoiceStateUpdate(
      makeState({ channelId: null }),
      makeState({ channelId: 'ch-1' })
    );
    const joinMsg = await waitForNextMessage(authMessages, 0);
    assert.deepStrictEqual(joinMsg, {
      action: 'voice_state_update',
      guildId: 'guild-1',
      discordId: 'user-1',
      inVoice: true,
      channelId: 'ch-1',
      muted: false,
      selfMute: false,
      serverMute: false,
      deaf: false
    });

    // 2b. Join voice channel with null oldState
    engine.handleVoiceStateUpdate(
      null,
      makeState({ id: 'user-2', channelId: 'ch-2', member: { id: 'user-2', user: { id: 'user-2', bot: false } } })
    );
    const nullOldMsg = await waitForNextMessage(authMessages, 1);
    assert.deepStrictEqual(nullOldMsg, {
      action: 'voice_state_update',
      guildId: 'guild-1',
      discordId: 'user-2',
      inVoice: true,
      channelId: 'ch-2',
      muted: false,
      selfMute: false,
      serverMute: false,
      deaf: false
    });

    // 3. Self-mute (selfMute: false -> true)
    engine.handleVoiceStateUpdate(
      makeState({ channelId: 'ch-1', selfMute: false }),
      makeState({ channelId: 'ch-1', selfMute: true })
    );
    const selfMuteMsg = await waitForNextMessage(authMessages, 2);
    assert.deepStrictEqual(selfMuteMsg, {
      action: 'voice_state_update',
      guildId: 'guild-1',
      discordId: 'user-1',
      inVoice: true,
      channelId: 'ch-1',
      muted: true,
      selfMute: true,
      serverMute: false,
      deaf: false
    });

    // 4. Server-mute (serverMute: false -> true)
    engine.handleVoiceStateUpdate(
      makeState({ channelId: 'ch-1', selfMute: true, serverMute: false }),
      makeState({ channelId: 'ch-1', selfMute: true, serverMute: true })
    );
    const serverMuteMsg = await waitForNextMessage(authMessages, 3);
    assert.deepStrictEqual(serverMuteMsg, {
      action: 'voice_state_update',
      guildId: 'guild-1',
      discordId: 'user-1',
      inVoice: true,
      channelId: 'ch-1',
      muted: true,
      selfMute: true,
      serverMute: true,
      deaf: false
    });

    // 5. Deafen (selfDeaf: false -> true)
    engine.handleVoiceStateUpdate(
      makeState({ channelId: 'ch-1', selfMute: true, serverMute: true, selfDeaf: false }),
      makeState({ channelId: 'ch-1', selfMute: true, serverMute: true, selfDeaf: true })
    );
    const deafMsg = await waitForNextMessage(authMessages, 4);
    assert.deepStrictEqual(deafMsg, {
      action: 'voice_state_update',
      guildId: 'guild-1',
      discordId: 'user-1',
      inVoice: true,
      channelId: 'ch-1',
      muted: true,
      selfMute: true,
      serverMute: true,
      deaf: true
    });

    // 6. Leave voice channel (channelId: 'ch-1' -> null)
    engine.handleVoiceStateUpdate(
      makeState({ channelId: 'ch-1', selfMute: true, serverMute: true, selfDeaf: true }),
      makeState({ channelId: null, selfMute: true, serverMute: true, selfDeaf: true })
    );
    const leaveMsg = await waitForNextMessage(authMessages, 5);
    assert.deepStrictEqual(leaveMsg, {
      action: 'voice_state_update',
      guildId: 'guild-1',
      discordId: 'user-1',
      inVoice: false,
      channelId: null,
      muted: true,
      selfMute: true,
      serverMute: true,
      deaf: true
    });

    // 7. Bot user updates must be ignored (user.bot, member.bot, member.isBot)
    engine.handleVoiceStateUpdate(
      makeState({ id: 'bot-1', channelId: null, member: { id: 'bot-1', user: { bot: true } } }),
      makeState({ id: 'bot-1', channelId: 'ch-1', member: { id: 'bot-1', user: { bot: true } } })
    );
    engine.handleVoiceStateUpdate(
      makeState({ id: 'bot-2', channelId: null, member: { id: 'bot-2', bot: true } }),
      makeState({ id: 'bot-2', channelId: 'ch-1', member: { id: 'bot-2', bot: true } })
    );
    engine.handleVoiceStateUpdate(
      makeState({ id: 'bot-3', channelId: null, member: { id: 'bot-3', isBot: true } }),
      makeState({ id: 'bot-3', channelId: 'ch-1', member: { id: 'bot-3', isBot: true } })
    );

    // 8. Redundant no-op update must NOT emit WS frame
    engine.handleVoiceStateUpdate(
      makeState({ channelId: 'ch-1', selfMute: true }),
      makeState({ channelId: 'ch-1', selfMute: true })
    );

    await new Promise((r) => setTimeout(r, 150));
    assert.strictEqual(
      authMessages.length,
      6,
      `Expected exactly 6 WS frames (bot & no-op updates must be ignored), got ${authMessages.length}`
    );
    assert.strictEqual(
      unauthMessages.length,
      0,
      'Unauthorized WS client must never receive voice_state_update broadcasts'
    );

    console.log('✓ All Issue #130 voice_state_update WebSocket tests passed!');
  } finally {
    if (authWs && authWs.readyState === WebSocket.OPEN) authWs.close();
    if (unauthWs && unauthWs.readyState === WebSocket.OPEN) unauthWs.close();
    await new Promise((resolve) => server.close(resolve));
    await mongoose.disconnect().catch(() => {});
  }
}

runTests().catch(async (err) => {
  console.error('Test failed:', err);
  await mongoose.disconnect().catch(() => {});
  process.exit(1);
});
