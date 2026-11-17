const assert = require('assert');
const http = require('http');
const express = require('express');
const mongoose = require('mongoose');
const { EventEmitter } = require('events');
const { PassThrough } = require('stream');
const { VoiceConnectionStatus } = require('@discordjs/voice');

process.env.MONGODB_URI = process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017/shadow_writer_test_129';
process.env.MCP_API_KEY = process.env.MCP_API_KEY || 'test-helix-mcp-key-129';

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

async function runTests() {
  await waitForConnection();
  console.log('Connected to test MongoDB for Issue #129');

  const testUserId = 'user-129';
  const testConfigId = `user:${testUserId}`;
  const testProjectId = 'proj-129-voice-flags';
  const testSessionIds = ['sess-129-a', 'sess-129-b'];

  await mongoDB.HelixConfig.deleteMany({ id: { $in: ['default', testConfigId] } });
  await mongoDB.Artifact.deleteMany({ projectId: testProjectId });
  await mongoDB.Note.deleteMany({ projectId: testProjectId });
  await mongoDB.Project.deleteMany({ id: testProjectId });

  const app = express();
  app.use(express.json());
  const server = http.createServer(app);
  const engine = setupHelixEngine(app, server);

  // Mock Flask summarizer server for session_end
  const mockFlaskApp = express();
  mockFlaskApp.use(express.json());
  mockFlaskApp.post('/admin/api/internal/helix/summarize', (req, res) => {
    res.json({
      summary: ['Session completed cleanly.'],
      next_steps: ['Continue run.']
    });
  });
  const mockFlaskServer = await new Promise((resolve) => {
    const s = mockFlaskApp.listen(0, '127.0.0.1', () => resolve(s));
  });
  process.env.FLASK_INTERNAL_URL = `http://127.0.0.1:${mockFlaskServer.address().port}`;

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;

  async function apiReq(method, path, body = null, headers = {}) {
    const opts = {
      method,
      headers: {
        'Content-Type': 'application/json',
        'x-user-id': testUserId,
        'x-user-email': 'gm129@example.com',
        ...headers
      }
    };
    if (body !== null) {
      opts.body = JSON.stringify(body);
    }
    const resp = await fetch(`${baseUrl}${path}`, opts);
    const data = await resp.json().catch(() => ({}));
    return { status: resp.status, data };
  }

  try {
    // Configure both minimal mock members (no .voice) and full Discord GuildMember-shaped objects
    const runnerRolesCache = new Map([['role-runners', { id: 'role-runners', name: 'Shadowrunners' }]]);
    const spectatorRolesCache = new Map([['role-spectator', { id: 'role-spectator', name: 'Spectators' }]]);

    engine.setMockDiscordState({
      online: true,
      botTag: 'HelixBot#2080',
      guilds: [
        {
          id: 'guild-129',
          name: 'Seattle Matrix 129',
          channels: [
            { id: 'chan-voice-129', name: 'Run Table 129', type: 2 }
          ],
          roles: [
            { id: 'guild-129', name: '@everyone', color: 0, position: 0 },
            { id: 'role-runners', name: 'Shadowrunners', color: 65280, position: 5 },
            { id: 'role-spectator', name: 'Spectators', color: 255, position: 1 }
          ],
          members: [
            // Minimal mock member without .voice
            {
              id: 'm-minimal',
              name: 'MinimalRunner',
              tag: 'MinimalRunner#0001',
              roles: ['role-runners']
            },
            // Full GuildMember-shaped: in voice, selfMute
            {
              id: 'm-self-mute',
              displayName: 'Razor',
              user: { username: 'razor', tag: 'Razor#1001', bot: false },
              roles: { cache: runnerRolesCache },
              voice: {
                channelId: 'chan-voice-129',
                mute: true,
                selfMute: true,
                serverMute: false,
                deaf: false,
                selfDeaf: false,
                serverDeaf: false
              }
            },
            // Full GuildMember-shaped: in voice, serverMute + serverDeaf
            {
              id: 'm-server-mute-deaf',
              displayName: 'Sledge',
              user: { username: 'sledge', tag: 'Sledge#1002', bot: false },
              roles: { cache: runnerRolesCache },
              voice: {
                channelId: 'chan-voice-129',
                mute: false,
                selfMute: false,
                serverMute: true,
                deaf: false,
                selfDeaf: false,
                serverDeaf: true
              }
            },
            // Full GuildMember-shaped: in voice, unmuted, active speaker target
            {
              id: 'm-active-speaker',
              displayName: 'Kitsune',
              user: { username: 'kitsune', tag: 'Kitsune#1003', bot: false },
              roles: { cache: runnerRolesCache },
              voice: {
                channelId: 'chan-voice-129',
                mute: false,
                selfMute: false,
                serverMute: false,
                deaf: false,
                selfDeaf: false,
                serverDeaf: false
              }
            },
            // Full GuildMember-shaped: not in voice, selfDeaf flag false
            {
              id: 'm-not-in-voice',
              displayName: 'Decker',
              user: { username: 'decker', tag: 'Decker#1004', bot: false },
              roles: { cache: runnerRolesCache },
              voice: {
                channelId: null,
                mute: false,
                selfMute: false,
                serverMute: false,
                deaf: false,
                selfDeaf: false,
                serverDeaf: false
              }
            },
            // Excluded by role filter
            {
              id: 'm-wrong-role',
              displayName: 'Watcher',
              user: { username: 'watcher', tag: 'Watcher#1005', bot: false },
              roles: { cache: spectatorRolesCache },
              voice: {
                channelId: 'chan-voice-129',
                mute: false,
                selfMute: false,
                serverMute: false,
                deaf: false
              }
            },
            // Bot account must remain excluded
            {
              id: 'm-bot',
              displayName: 'HelixBot',
              user: { username: 'helixbot', tag: 'HelixBot#2080', bot: true },
              roles: { cache: runnerRolesCache },
              voice: { channelId: 'chan-voice-129' }
            }
          ]
        }
      ]
    });

    // Save config with roleId filter
    const cfgRes = await apiReq('POST', '/api/helix/config', {
      guildId: 'guild-129',
      channelId: 'chan-voice-129',
      roleId: 'role-runners',
      roleName: 'Shadowrunners',
      language: 'de-DE'
    });
    assert.strictEqual(cfgRes.status, 200);

    // 1. Verify initial voice/mute/deaf/speaking flags & filtering on GET /api/helix/status
    console.log('1. Verifying voice, mute, deaf, speaking flags & filtering on GET /api/helix/status...');
    const status1 = await apiReq('GET', '/api/helix/status');
    assert.strictEqual(status1.status, 200);
    const members1 = status1.data.members;
    assert.strictEqual(members1.length, 5, 'Should return 5 non-bot members with role-runners');

    const byId1 = Object.fromEntries(members1.map(m => [m.id, m]));
    assert.strictEqual(byId1['m-wrong-role'], undefined, 'Wrong role member must be filtered out');
    assert.strictEqual(byId1['m-bot'], undefined, 'Bot member must be excluded');

    // Minimal member without .voice
    assert.deepStrictEqual(byId1['m-minimal'], {
      id: 'm-minimal',
      name: 'MinimalRunner',
      tag: 'MinimalRunner#0001',
      isBot: false,
      inVoice: false,
      channelId: null,
      channelName: null,
      muted: false,
      selfMute: false,
      serverMute: false,
      deaf: false,
      speaking: false
    });

    // Self-muted GuildMember
    assert.deepStrictEqual(byId1['m-self-mute'], {
      id: 'm-self-mute',
      name: 'Razor',
      tag: 'Razor#1001',
      isBot: false,
      inVoice: true,
      channelId: 'chan-voice-129',
      channelName: 'Run Table 129',
      muted: true,
      selfMute: true,
      serverMute: false,
      deaf: false,
      speaking: false
    });

    // Server-muted + server-deafened GuildMember
    assert.deepStrictEqual(byId1['m-server-mute-deaf'], {
      id: 'm-server-mute-deaf',
      name: 'Sledge',
      tag: 'Sledge#1002',
      isBot: false,
      inVoice: true,
      channelId: 'chan-voice-129',
      channelName: 'Run Table 129',
      muted: true,
      selfMute: false,
      serverMute: true,
      deaf: true,
      speaking: false
    });

    // Active speaker candidate (idle before speaking)
    assert.deepStrictEqual(byId1['m-active-speaker'], {
      id: 'm-active-speaker',
      name: 'Kitsune',
      tag: 'Kitsune#1003',
      isBot: false,
      inVoice: true,
      channelId: 'chan-voice-129',
      channelName: 'Run Table 129',
      muted: false,
      selfMute: false,
      serverMute: false,
      deaf: false,
      speaking: false
    });

    // Not in voice
    assert.deepStrictEqual(byId1['m-not-in-voice'], {
      id: 'm-not-in-voice',
      name: 'Decker',
      tag: 'Decker#1004',
      isBot: false,
      inVoice: false,
      channelId: null,
      channelName: null,
      muted: false,
      selfMute: false,
      serverMute: false,
      deaf: false,
      speaking: false
    });
    console.log('✓ Initial voice/mute/deaf/speaking flags passed!');

    // 2. Verify speaking toggles on receiver.speaking 'start' / 'end' and clears on Disconnected
    console.log('2. Verifying speaking start/end and Disconnected cleanup...');
    let currentConn = null;
    let currentSpeaking = null;

    engine.setVoiceDependencies({
      joinVoiceChannel: () => {
        const conn = new EventEmitter();
        const speaking = new EventEmitter();
        conn.receiver = {
          speaking,
          subscribe: () => new PassThrough()
        };
        conn.destroy = () => {
          conn.emit('stateChange', { status: VoiceConnectionStatus.Ready }, { status: VoiceConnectionStatus.Destroyed });
        };
        currentConn = conn;
        currentSpeaking = speaking;
        return conn;
      },
      createOpusDecoder: () => new PassThrough(),
      createSttStream: () => new PassThrough({ objectMode: true })
    });

    const startResA = await apiReq('POST', '/api/helix/session/start', {
      sessionId: 'sess-129-a',
      projectId: testProjectId,
      guildId: 'guild-129',
      channelId: 'chan-voice-129'
    });
    assert.strictEqual(startResA.status, 200);
    assert.ok(currentSpeaking, 'Speaking emitter must be attached');

    // Emit speaking start
    currentSpeaking.emit('start', 'm-active-speaker');
    const statusSpeaking = await apiReq('GET', '/api/helix/status');
    const byIdSpeaking = Object.fromEntries(statusSpeaking.data.members.map(m => [m.id, m]));
    assert.strictEqual(byIdSpeaking['m-active-speaker'].speaking, true, 'speaking must be true after start');
    assert.strictEqual(byIdSpeaking['m-self-mute'].speaking, false, 'other members must remain speaking: false');

    // Emit speaking end
    currentSpeaking.emit('end', 'm-active-speaker');
    const statusStopped = await apiReq('GET', '/api/helix/status');
    const byIdStopped = Object.fromEntries(statusStopped.data.members.map(m => [m.id, m]));
    assert.strictEqual(byIdStopped['m-active-speaker'].speaking, false, 'speaking must be false after end');

    // Emit speaking start again, then disconnect without emitting speaking end
    currentSpeaking.emit('start', 'm-active-speaker');
    const statusSpeakingAgain = await apiReq('GET', '/api/helix/status');
    assert.strictEqual(
      statusSpeakingAgain.data.members.find(m => m.id === 'm-active-speaker').speaking,
      true
    );

    currentConn.emit(
      'stateChange',
      { status: VoiceConnectionStatus.Ready },
      { status: VoiceConnectionStatus.Disconnected }
    );
    const statusAfterDisconnect = await apiReq('GET', '/api/helix/status');
    assert.strictEqual(
      statusAfterDisconnect.data.members.find(m => m.id === 'm-active-speaker').speaking,
      false,
      'speaking must clear cleanly on VoiceConnectionStatus.Disconnected'
    );

    // 3. Emit speaking start again, then end session via POST /api/helix/session/end without speaking 'end'
    console.log('3. Verifying activeSpeakers clears on session_end teardown...');
    currentSpeaking.emit('start', 'm-active-speaker');
    const statusBeforeEnd = await apiReq('GET', '/api/helix/status');
    assert.strictEqual(
      statusBeforeEnd.data.members.find(m => m.id === 'm-active-speaker').speaking,
      true
    );

    const endResA = await apiReq('POST', '/api/helix/session/end', {
      sessionId: 'sess-129-a',
      projectId: testProjectId
    });
    assert.strictEqual(endResA.status, 200);

    const statusAfterEnd = await apiReq('GET', '/api/helix/status');
    assert.strictEqual(
      statusAfterEnd.data.members.find(m => m.id === 'm-active-speaker').speaking,
      false,
      'speaking must clear cleanly on session_end teardown even if speaking end was not emitted'
    );
    console.log('✓ Speaking start/end, Disconnected, and session_end cleanup passed!');
  } finally {
    await mongoDB.HelixConfig.deleteMany({ id: { $in: ['default', testConfigId] } });
    await mongoDB.Artifact.deleteMany({ projectId: testProjectId });
    await mongoDB.Note.deleteMany({ projectId: testProjectId });
    await mongoDB.Project.deleteMany({ id: testProjectId });
    await new Promise((resolve) => mockFlaskServer.close(resolve));
    await new Promise((resolve) => server.close(resolve));
  }

  await mongoose.disconnect();
  console.log('All Issue #129 tests passed!');
}

runTests().catch(async (err) => {
  console.error('Test failed:', err);
  await mongoose.disconnect().catch(() => {});
  process.exit(1);
});
