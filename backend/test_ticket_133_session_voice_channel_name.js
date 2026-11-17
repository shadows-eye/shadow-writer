const assert = require('assert');
const http = require('http');
const express = require('express');
const mongoose = require('mongoose');
const WebSocket = require('ws');
const { EventEmitter } = require('events');
const { PassThrough } = require('stream');

process.env.MONGODB_URI = process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017/shadow_writer_test_133';
process.env.MCP_API_KEY = process.env.MCP_API_KEY || 'test-helix-mcp-key-133';
process.env.DISCORD_BOT_TOKEN = '';

const mongoDB = require('./mongoDB');
const { setupHelixEngine } = require('./helixEngine');

async function waitForConnection() {
  if (mongoDB.dbReadyPromise) {
    await mongoDB.dbReadyPromise;
  }
  if (mongoose.connection.readyState === 1) return;
  await new Promise((resolve, reject) => {
    mongoose.connection.once('open', resolve);
    mongoose.connection.once('error', reject);
  });
}

async function waitForCondition(predicate, timeoutMs = 2000, intervalMs = 20) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const val = await predicate();
    if (val) return val;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  return null;
}

async function runTests() {
  await waitForConnection();
  console.log('Connected to test MongoDB for Issue #133');

  const testUserId = 'user-133';
  const testConfigId = `user:${testUserId}`;
  const testProjectId = 'proj-133-session-voice';
  const testSessionId = 'sess-133-a';

  await mongoDB.HelixConfig.deleteMany({ id: { $in: ['default', testConfigId] } });
  await mongoDB.Artifact.deleteMany({ projectId: testProjectId });
  await mongoDB.Note.deleteMany({ projectId: testProjectId });
  await mongoDB.Project.deleteMany({ id: testProjectId });

  // Mock Flask summarizer
  const mockFlaskApp = express();
  mockFlaskApp.use(express.json());
  mockFlaskApp.post('/admin/api/internal/helix/summarize', (req, res) => {
    res.json({
      summary: ['Session #133 summarized cleanly.'],
      next_steps: ['Proceed to next run.']
    });
  });
  const mockFlaskServer = await new Promise((resolve) => {
    const s = mockFlaskApp.listen(0, '127.0.0.1', () => resolve(s));
  });
  process.env.FLASK_INTERNAL_URL = `http://127.0.0.1:${mockFlaskServer.address().port}`;

  const app = express();
  app.use(express.json());
  const server = http.createServer(app);
  const engine = setupHelixEngine(app, server);

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  const baseUrl = `http://127.0.0.1:${port}`;
  const apiKey = process.env.MCP_API_KEY;

  async function apiReq(method, pathUrl, body = null, headers = {}) {
    const opts = {
      method,
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'x-user-id': testUserId,
        'x-user-email': 'gm133@example.com',
        ...headers
      }
    };
    if (body !== null) {
      opts.body = JSON.stringify(body);
    }
    const resp = await fetch(`${baseUrl}${pathUrl}`, opts);
    const data = await resp.json().catch(() => ({}));
    return { status: resp.status, data };
  }

  let wsClient = null;

  try {
    assert.strictEqual(
      engine.connectPassiveVoice,
      undefined,
      'engine.connectPassiveVoice must be removed (#133 supersedes #131)'
    );
    assert.strictEqual(
      engine.disconnectPassiveVoice,
      undefined,
      'engine.disconnectPassiveVoice must be removed (#133 supersedes #131)'
    );

    engine.setMockDiscordState({
      online: true,
      botTag: 'Helix#2080',
      guilds: [
        {
          id: 'g-133',
          name: 'Seattle Matrix 133',
          channels: [
            { id: 'ch-text-133', name: 'general-chat', type: 0 },
            { id: 'ch-voice-133', name: 'Matrix Comms', type: 2 },
            { id: 'ch-stage-133', name: 'Stage Briefing', type: 13 }
          ],
          members: [
            {
              id: 'm-voice',
              displayName: 'Razor',
              user: { username: 'razor', tag: 'Razor#1001', bot: false },
              voice: { channelId: 'ch-voice-133' }
            },
            {
              id: 'm-stage',
              displayName: 'Kitsune',
              user: { username: 'kitsune', tag: 'Kitsune#1002', bot: false },
              voice: { channelId: 'ch-stage-133' }
            },
            {
              id: 'm-text',
              displayName: 'Sledge',
              user: { username: 'sledge', tag: 'Sledge#1003', bot: false },
              voice: { channelId: 'ch-text-133' }
            },
            {
              id: 'm-unknown',
              displayName: 'Ghost',
              user: { username: 'ghost', tag: 'Ghost#1004', bot: false },
              voice: { channelId: 'ch-does-not-exist' }
            },
            {
              id: 'm-idle',
              displayName: 'Decker',
              user: { username: 'decker', tag: 'Decker#1005', bot: false },
              voice: { channelId: null }
            }
          ]
        }
      ]
    });

    let joinCallCount = 0;
    let createSttStreamCallCount = 0;
    let createOpusDecoderCallCount = 0;
    let subscribeCallCount = 0;
    let destroyCallCount = 0;
    const createdConnections = [];
    const activeUserSttStreams = new Map();
    const endedSttStreams = [];
    const destroyedOpusStreams = [];
    const destroyedDecoders = [];

    engine.setVoiceDependencies({
      joinVoiceChannel: ({ guildId, channelId }) => {
        joinCallCount += 1;
        const speakingEmitter = new EventEmitter();
        const conn = new EventEmitter();
        conn.guildId = String(guildId || '');
        conn.channelId = String(channelId || '');
        conn.speakingEmitter = speakingEmitter;
        conn.destroyed = false;
        conn.receiver = {
          speaking: speakingEmitter,
          subscribe: (discordId) => {
            subscribeCallCount += 1;
            const opusStream = new PassThrough();
            const origDestroy = opusStream.destroy.bind(opusStream);
            opusStream.destroy = (...args) => {
              destroyedOpusStreams.push(String(discordId));
              return origDestroy(...args);
            };
            return opusStream;
          }
        };
        conn.destroy = () => {
          destroyCallCount += 1;
          conn.destroyed = true;
          conn.emit('stateChange', { status: 'ready' }, { status: 'destroyed' });
          conn.emit('destroyed');
        };
        createdConnections.push(conn);
        return conn;
      },
      createOpusDecoder: () => {
        createOpusDecoderCallCount += 1;
        const decoder = new PassThrough();
        const origDestroy = decoder.destroy.bind(decoder);
        decoder.destroy = (...args) => {
          destroyedDecoders.push(true);
          return origDestroy(...args);
        };
        return decoder;
      },
      createSttStream: (recognizeConfig, discordId) => {
        createSttStreamCallCount += 1;
        const sttStream = new PassThrough({ objectMode: true });
        const origEnd = sttStream.end.bind(sttStream);
        sttStream.end = (...args) => {
          endedSttStreams.push(String(discordId));
          return origEnd(...args);
        };
        activeUserSttStreams.set(String(discordId), sttStream);
        return sttStream;
      }
    });

    // 1. Saving config must NOT invoke joinVoiceChannel
    console.log('1. Verifying POST /api/helix/config does NOT join voice channel...');
    const cfgRes = await apiReq('POST', '/api/helix/config', {
      guildId: 'g-133',
      channelId: 'ch-voice-133',
      language: 'de-DE'
    });
    assert.strictEqual(cfgRes.status, 200);
    assert.strictEqual(joinCallCount, 0, 'POST /api/helix/config MUST NOT invoke joinVoiceChannel');
    assert.strictEqual(engine.getActiveSession(), null);

    // 2. GET /api/helix/status exposes channelName on every member even with no bot voice connection
    console.log('2. Verifying GET /api/helix/status member channelName enrichment without active session...');
    const statusRes = await apiReq('GET', '/api/helix/status');
    assert.strictEqual(statusRes.status, 200);
    assert.strictEqual(statusRes.data.activeSession, null);
    const byId = Object.fromEntries(statusRes.data.members.map((m) => [m.id, m]));
    assert.strictEqual(byId['m-voice'].channelName, 'Matrix Comms');
    assert.strictEqual(byId['m-stage'].channelName, 'Stage Briefing');
    assert.strictEqual(byId['m-text'].channelName, null, 'Text channel type: 0 must resolve channelName to null');
    assert.strictEqual(byId['m-unknown'].channelName, null, 'Unknown channelId must resolve channelName to null');
    assert.strictEqual(byId['m-idle'].channelName, null, 'Not-in-voice member must have channelName: null');
    assert.strictEqual(joinCallCount, 0, 'GET /api/helix/status must not trigger joinVoiceChannel');

    // 3. voiceStateUpdate -> /helix/ws voice_state_update includes channelName while bot is NOT in voice
    console.log('3. Verifying /helix/ws voice_state_update channelName resolution while bot is NOT in voice...');
    const wsMessages = [];
    wsClient = new WebSocket(`ws://127.0.0.1:${port}/helix/ws?apiKey=${encodeURIComponent(apiKey)}`);
    await new Promise((resolve, reject) => {
      wsClient.once('open', resolve);
      wsClient.once('error', reject);
    });
    wsClient.on('message', (raw) => {
      wsMessages.push(JSON.parse(raw.toString()));
    });
    await new Promise((r) => setTimeout(r, 50));

    // 3a. Resolved via VoiceState.channel (type: 2)
    engine.handleVoiceStateUpdate(
      {
        guild: { id: 'g-133' },
        id: 'm-ws-1',
        channelId: null,
        member: { id: 'm-ws-1', user: { id: 'm-ws-1', bot: false } }
      },
      {
        guild: { id: 'g-133' },
        id: 'm-ws-1',
        channelId: 'ch-direct',
        channel: { id: 'ch-direct', name: 'Direct Voice', type: 2 },
        member: { id: 'm-ws-1', user: { id: 'm-ws-1', bot: false } }
      }
    );
    const wsJoinDirect = await waitForCondition(() => wsMessages[0]);
    assert.deepStrictEqual(wsJoinDirect, {
      action: 'voice_state_update',
      guildId: 'g-133',
      discordId: 'm-ws-1',
      inVoice: true,
      channelId: 'ch-direct',
      channelName: 'Direct Voice',
      muted: false,
      selfMute: false,
      serverMute: false,
      deaf: false
    });

    // 3b. Move to channel resolved via guild.channels.cache (stage channel type: 13)
    const guildCache = new Map([
      ['ch-cached-stage', { id: 'ch-cached-stage', name: 'Cached Stage', type: 13 }],
      ['ch-cached-text', { id: 'ch-cached-text', name: 'Cached Text', type: 0 }]
    ]);
    engine.handleVoiceStateUpdate(
      {
        guild: { id: 'g-133' },
        id: 'm-ws-1',
        channelId: 'ch-direct',
        member: { id: 'm-ws-1', user: { id: 'm-ws-1', bot: false } }
      },
      {
        guild: { id: 'g-133', channels: { cache: guildCache } },
        id: 'm-ws-1',
        channelId: 'ch-cached-stage',
        member: { id: 'm-ws-1', user: { id: 'm-ws-1', bot: false } }
      }
    );
    const wsMoveCache = await waitForCondition(() => wsMessages[1]);
    assert.strictEqual(wsMoveCache.channelId, 'ch-cached-stage');
    assert.strictEqual(wsMoveCache.channelName, 'Cached Stage');

    // 3c. Move to channel resolved via mockDiscordState / getVoiceChannelsForGuild
    engine.handleVoiceStateUpdate(
      {
        guild: { id: 'g-133' },
        id: 'm-ws-1',
        channelId: 'ch-cached-stage',
        member: { id: 'm-ws-1', user: { id: 'm-ws-1', bot: false } }
      },
      {
        guild: { id: 'g-133' },
        id: 'm-ws-1',
        channelId: 'ch-voice-133',
        member: { id: 'm-ws-1', user: { id: 'm-ws-1', bot: false } }
      }
    );
    const wsMoveMock = await waitForCondition(() => wsMessages[2]);
    assert.strictEqual(wsMoveMock.channelId, 'ch-voice-133');
    assert.strictEqual(wsMoveMock.channelName, 'Matrix Comms');

    // 3d. VoiceState.channel with type: 0 (text channel) -> channelName: null; type === undefined -> resolves name
    engine.handleVoiceStateUpdate(
      {
        guild: { id: 'g-133' },
        id: 'm-ws-1',
        channelId: 'ch-voice-133',
        member: { id: 'm-ws-1', user: { id: 'm-ws-1', bot: false } }
      },
      {
        guild: { id: 'g-133' },
        id: 'm-ws-1',
        channelId: 'ch-text-direct',
        channel: { id: 'ch-text-direct', name: 'Not Voice', type: 0 },
        member: { id: 'm-ws-1', user: { id: 'm-ws-1', bot: false } }
      }
    );
    const wsTextChannel = await waitForCondition(() => wsMessages[3]);
    assert.strictEqual(wsTextChannel.channelId, 'ch-text-direct');
    assert.strictEqual(wsTextChannel.channelName, null, 'Text channel type: 0 must emit channelName: null');

    // 3e. guild.channels as Array -> resolves voice/stage, ignores type: 0; channel with undefined type resolves
    engine.handleVoiceStateUpdate(
      {
        guild: { id: 'g-133' },
        id: 'm-ws-1',
        channelId: 'ch-text-direct',
        member: { id: 'm-ws-1', user: { id: 'm-ws-1', bot: false } }
      },
      {
        guild: {
          id: 'g-133',
          channels: [
            { id: 'ch-arr-voice', name: 'Array Voice', type: 2 },
            { id: 'ch-arr-text', name: 'Array Text', type: 0 }
          ]
        },
        id: 'm-ws-1',
        channelId: 'ch-arr-voice',
        member: { id: 'm-ws-1', user: { id: 'm-ws-1', bot: false } }
      }
    );
    const wsArrayVoice = await waitForCondition(() => wsMessages[4]);
    assert.strictEqual(wsArrayVoice.channelName, 'Array Voice');

    engine.handleVoiceStateUpdate(
      {
        guild: { id: 'g-133' },
        id: 'm-ws-1',
        channelId: 'ch-arr-voice',
        member: { id: 'm-ws-1', user: { id: 'm-ws-1', bot: false } }
      },
      {
        guild: { id: 'g-133' },
        id: 'm-ws-1',
        channelId: 'ch-untyped',
        channel: { id: 'ch-untyped', name: 'Untyped Voice' },
        member: { id: 'm-ws-1', user: { id: 'm-ws-1', bot: false } }
      }
    );
    const wsUntypedVoice = await waitForCondition(() => wsMessages[5]);
    assert.strictEqual(wsUntypedVoice.channelName, 'Untyped Voice');

    // 3f. Leave voice -> channelId: null, channelName: null, inVoice: false
    engine.handleVoiceStateUpdate(
      {
        guild: { id: 'g-133' },
        id: 'm-ws-1',
        channelId: 'ch-untyped',
        member: { id: 'm-ws-1', user: { id: 'm-ws-1', bot: false } }
      },
      {
        guild: { id: 'g-133' },
        id: 'm-ws-1',
        channelId: null,
        member: { id: 'm-ws-1', user: { id: 'm-ws-1', bot: false } }
      }
    );
    const wsLeave = await waitForCondition(() => wsMessages[6]);
    assert.deepStrictEqual(wsLeave, {
      action: 'voice_state_update',
      guildId: 'g-133',
      discordId: 'm-ws-1',
      inVoice: false,
      channelId: null,
      channelName: null,
      muted: false,
      selfMute: false,
      serverMute: false,
      deaf: false
    });
    assert.strictEqual(joinCallCount, 0, 'joinCallCount must still be 0 before session_start');

    // 4. session_start joins once, speaking emits WS + opens STT, session_end tears down without passive rejoin
    console.log('4. Verifying session_start / speaking / session_end lifecycle without passive rejoin...');
    wsMessages.length = 0;
    wsClient.send(JSON.stringify({
      action: 'session_start',
      sessionId: testSessionId,
      projectId: testProjectId,
      guildId: 'g-133',
      channelId: 'ch-voice-133',
      activePlayers: [
        { foundryId: 'f-razor', discordId: 'm-voice', name: 'Razor' }
      ]
    }));

    const createdTranscript = await waitForCondition(async () =>
      mongoDB.Artifact.findOne({ id: `transcript-${testSessionId}` }).lean()
    );
    assert.ok(createdTranscript, 'session_start must create transcript Artifact');
    assert.strictEqual(joinCallCount, 1, 'session_start must invoke joinVoiceChannel once');
    const sessionConn = createdConnections[0];
    assert.ok(sessionConn);

    sessionConn.speakingEmitter.emit('start', 'm-voice');
    const speakStartMsg = await waitForCondition(() =>
      wsMessages.find((m) => m.action === 'speaking_start' && m.discordId === 'm-voice')
    );
    assert.ok(speakStartMsg, 'speaking_start must be broadcast during active session');
    assert.strictEqual(speakStartMsg.sessionId, testSessionId);
    assert.strictEqual(speakStartMsg.foundryId, 'f-razor');
    assert.strictEqual(createSttStreamCallCount, 1, 'STT stream must be created during active session');
    assert.strictEqual(createOpusDecoderCallCount, 1);
    assert.strictEqual(subscribeCallCount, 1);

    const statusWhileSpeaking = await apiReq('GET', '/api/helix/status');
    const speakingMember = statusWhileSpeaking.data.members.find((m) => m.id === 'm-voice');
    assert.strictEqual(speakingMember.speaking, true);

    // End session without emitting speaking 'end' first -> activeSpeakers must still clear
    wsMessages.length = 0;
    wsClient.send(JSON.stringify({
      action: 'session_end',
      sessionId: testSessionId
    }));
    const summaryMsg = await waitForCondition(() =>
      wsMessages.find((m) => m.action === 'session_summary' && m.sessionId === testSessionId)
    );
    assert.ok(summaryMsg, 'session_summary must be emitted on session_end');
    assert.strictEqual(endedSttStreams.includes('m-voice'), true, 'STT stream must be ended on session_end');
    assert.strictEqual(destroyedOpusStreams.includes('m-voice'), true, 'Opus stream must be destroyed on session_end');
    assert.ok(destroyedDecoders.length >= 1, 'PCM decoder must be destroyed on session_end');
    assert.strictEqual(destroyCallCount, 1, 'voiceConnection.destroy() must be called on session_end');
    assert.strictEqual(sessionConn.destroyed, true);
    assert.strictEqual(joinCallCount, 1, 'session_end MUST NOT rejoin passively');
    assert.strictEqual(engine.getActiveSession(), null);

    const statusAfterEnd = await apiReq('GET', '/api/helix/status');
    const memberAfterEnd = statusAfterEnd.data.members.find((m) => m.id === 'm-voice');
    assert.strictEqual(memberAfterEnd.speaking, false, 'activeSpeakers must be cleared on session_end');
    assert.strictEqual(memberAfterEnd.channelName, 'Matrix Comms');

    console.log('✓ All Issue #133 tests passed!');
  } finally {
    if (wsClient && wsClient.readyState !== WebSocket.CLOSED) {
      try { wsClient.terminate(); } catch (e) {}
    }
    await mongoDB.HelixConfig.deleteMany({ id: { $in: ['default', testConfigId] } });
    await mongoDB.Artifact.deleteMany({ projectId: testProjectId });
    await mongoDB.Note.deleteMany({ projectId: testProjectId });
    await mongoDB.Project.deleteMany({ id: testProjectId });
    if (typeof mockFlaskServer.closeAllConnections === 'function') mockFlaskServer.closeAllConnections();
    if (typeof server.closeAllConnections === 'function') server.closeAllConnections();
    await new Promise((resolve) => mockFlaskServer.close(resolve));
    await new Promise((resolve) => server.close(resolve));
    await mongoose.disconnect().catch(() => {});
  }
}

runTests().catch(async (err) => {
  console.error('Test failed:', err);
  await mongoose.disconnect().catch(() => {});
  process.exit(1);
});
