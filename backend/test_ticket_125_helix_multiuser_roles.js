const assert = require('assert');
const http = require('http');
const express = require('express');
const mongoose = require('mongoose');
const WebSocket = require('ws');

process.env.MONGODB_URI = process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017/shadow_writer_test_125';
process.env.MCP_API_KEY = process.env.MCP_API_KEY || 'test-helix-mcp-key-125';

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
  console.log('Connected to test MongoDB for Issue #125');

  // Clean up any leftover test records
  await mongoDB.HelixConfig.deleteMany({ id: { $in: ['default', 'user:user-a', 'user:user-b', 'user:schema-check'] } });
  await mongoDB.Artifact.deleteMany({ projectId: { $in: ['proj-125-a', 'proj-125-b', 'proj-125-ws'] } });
  await mongoDB.Note.deleteMany({ projectId: { $in: ['proj-125-a', 'proj-125-b', 'proj-125-ws'] } });
  await mongoDB.Project.deleteMany({ id: { $in: ['proj-125-a', 'proj-125-b', 'proj-125-ws'] } });

  // 1. Schema checks
  console.log('1. Testing MongoDB schema fields for HelixConfig, Artifact, Note...');
  const cfgDoc = await mongoDB.HelixConfig.create({
    id: 'user:schema-check',
    userId: 'schema-check',
    guildId: 'g-1',
    roleId: 'r-1',
    roleName: 'Shadowrunners'
  });
  assert.strictEqual(cfgDoc.userId, 'schema-check');
  assert.strictEqual(cfgDoc.roleId, 'r-1');
  assert.strictEqual(cfgDoc.roleName, 'Shadowrunners');
  await mongoDB.HelixConfig.deleteOne({ id: 'user:schema-check' });

  const artDoc = new mongoDB.Artifact({ projectId: 'proj-schema', id: 'art-schema', userId: 'u-schema' });
  assert.strictEqual(artDoc.userId, 'u-schema');
  const noteDoc = new mongoDB.Note({ projectId: 'proj-schema', id: 'note-schema', userId: 'u-schema' });
  assert.strictEqual(noteDoc.userId, 'u-schema');
  console.log('✓ Schema checks passed!');

  // 2. Spin up Express + HTTP + WS server with HelixEngine
  const app = express();
  app.use(express.json());
  const server = http.createServer(app);
  const engine = setupHelixEngine(app, server);

  // Mock Flask summarizer server
  const mockFlaskApp = express();
  mockFlaskApp.use(express.json());
  mockFlaskApp.post('/admin/api/internal/helix/summarize', (req, res) => {
    res.json({
      summary: ['Team infiltrated Renraku facility.'],
      next_steps: ['Extract paydata.']
    });
  });
  const mockFlaskServer = await new Promise((resolve) => {
    const s = mockFlaskApp.listen(0, '127.0.0.1', () => resolve(s));
  });
  const flaskPort = mockFlaskServer.address().port;
  process.env.FLASK_INTERNAL_URL = `http://127.0.0.1:${flaskPort}`;

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  const baseUrl = `http://127.0.0.1:${port}`;

  async function apiReq(method, path, body = null, headers = {}) {
    const opts = {
      method,
      headers: { 'Content-Type': 'application/json', ...headers }
    };
    if (body !== null) {
      opts.body = JSON.stringify(body);
    }
    const resp = await fetch(`${baseUrl}${path}`, opts);
    const data = await resp.json().catch(() => ({}));
    return { status: resp.status, data };
  }

  try {
    // Configure mock Discord state with guilds, channels, roles, and members (array + cache.has styles)
    const roleSetCache = new Map([['role-runners', { id: 'role-runners', name: 'Shadowrunners' }]]);
    engine.setMockDiscordState({
      online: true,
      botTag: 'HelixBot#2080',
      guilds: [
        {
          id: 'guild-seattle',
          name: 'Seattle Matrix',
          channels: [
            { id: 'chan-voice-1', name: 'Run Table 1', type: 2 }
          ],
          roles: [
            { id: 'guild-seattle', name: '@everyone', color: 0, position: 0 },
            { id: 'role-gm', name: 'Gamemaster', color: 16711680, position: 10 },
            { id: 'role-runners', name: 'Shadowrunners', color: 65280, position: 5 },
            { id: 'role-spectator', name: 'Spectators', color: 255, position: 1 }
          ],
          members: [
            { id: 'm-1', displayName: 'Razor', user: { username: 'razor', bot: false }, roles: ['role-runners'] },
            { id: 'm-2', displayName: 'Deckard', user: { username: 'deckard', bot: false }, roles: { cache: roleSetCache } },
            { id: 'm-3', displayName: 'Watcher', user: { username: 'watcher', bot: false }, roles: ['role-spectator'] },
            { id: 'm-bot', displayName: 'HelixBot', user: { username: 'helix', bot: true }, roles: ['role-runners'] }
          ]
        },
        {
          id: 'guild-berlin',
          name: 'Berlin Flux',
          channels: [
            { id: 'chan-voice-2', name: 'Kiez Table', type: 2 }
          ],
          roles: [
            { id: 'guild-berlin', name: '@everyone', color: 0, position: 0 },
            { id: 'role-berlin', name: 'Anarchists', color: 16744192, position: 3 }
          ],
          members: [
            { id: 'm-4', displayName: 'Blitz', user: { username: 'blitz', bot: false }, roles: ['role-berlin'] }
          ]
        }
      ]
    });

    // 2. Test GET /api/helix/guilds/:guildId/roles
    console.log('2. Testing GET /api/helix/guilds/:guildId/roles...');
    const rolesRes = await apiReq('GET', '/api/helix/guilds/guild-seattle/roles');
    assert.strictEqual(rolesRes.status, 200);
    assert.ok(Array.isArray(rolesRes.data.roles), 'Response must include roles array');
    assert.strictEqual(rolesRes.data.roles.length, 3, '@everyone must be excluded');
    assert.deepStrictEqual(
      rolesRes.data.roles.map(r => r.id),
      ['role-gm', 'role-runners', 'role-spectator'],
      'Roles must be sorted by descending position'
    );
    assert.strictEqual(rolesRes.data.roles[0].name, 'Gamemaster');
    assert.strictEqual(rolesRes.data.roles[0].color, 16711680);
    assert.strictEqual(rolesRes.data.roles[0].position, 10);
    console.log('✓ Guild roles endpoint passed!');

    // 3. Test user-scoped config isolation + roleId/roleName persistence + role-filtered members
    console.log('3. Testing user-scoped HelixConfig and role-filtered members...');
    const saveARes = await apiReq('POST', '/api/helix/config', {
      guildId: 'guild-seattle',
      channelId: 'chan-voice-1',
      roleId: 'role-runners',
      roleName: 'Shadowrunners',
      language: 'de-DE'
    }, { 'x-user-id': 'user-a', 'x-user-email': 'a@example.com' });
    assert.strictEqual(saveARes.status, 200);
    assert.strictEqual(saveARes.data.id, 'user:user-a');
    assert.strictEqual(saveARes.data.userId, 'user-a');
    assert.strictEqual(saveARes.data.roleId, 'role-runners');
    assert.strictEqual(saveARes.data.roleName, 'Shadowrunners');
    assert.strictEqual(saveARes.data.config.roleId, 'role-runners');

    const saveBRes = await apiReq('POST', '/api/helix/config', {
      guildId: 'guild-berlin',
      channelId: 'chan-voice-2',
      roleId: '',
      roleName: '',
      language: 'en-US'
    }, { 'x-user-id': 'user-b', 'x-user-email': 'b@example.com' });
    assert.strictEqual(saveBRes.status, 200);
    assert.strictEqual(saveBRes.data.id, 'user:user-b');
    assert.strictEqual(saveBRes.data.guildId, 'guild-berlin');
    assert.strictEqual(saveBRes.data.roleId, '');

    // Status for user-a: filtered to role-runners (Razor + Deckard, excluding Watcher and Bot)
    const statusARes = await apiReq('GET', '/api/helix/status', null, { 'x-user-id': 'user-a' });
    assert.strictEqual(statusARes.status, 200);
    assert.strictEqual(statusARes.data.config.id, 'user:user-a');
    assert.strictEqual(statusARes.data.config.guildId, 'guild-seattle');
    assert.strictEqual(statusARes.data.config.roleId, 'role-runners');
    assert.strictEqual(statusARes.data.config.roleName, 'Shadowrunners');
    assert.ok(Array.isArray(statusARes.data.roles) && statusARes.data.roles.length === 3, 'Status must include guild roles');
    assert.deepStrictEqual(
      statusARes.data.members.map(m => m.id).sort(),
      ['m-1', 'm-2'],
      'Members must be filtered by config.roleId (supporting array and roles.cache.has)'
    );

    // Status for user-b: guild-berlin, no roleId filter
    const statusBRes = await apiReq('GET', '/api/helix/status', null, { 'x-user-id': 'user-b' });
    assert.strictEqual(statusBRes.status, 200);
    assert.strictEqual(statusBRes.data.config.id, 'user:user-b');
    assert.strictEqual(statusBRes.data.config.guildId, 'guild-berlin');
    assert.deepStrictEqual(statusBRes.data.members.map(m => m.id), ['m-4']);

    // Status for anonymous user: 'default'
    const statusDefaultRes = await apiReq('GET', '/api/helix/status');
    assert.strictEqual(statusDefaultRes.status, 200);
    assert.strictEqual(statusDefaultRes.data.config.id, 'default');
    assert.strictEqual(statusDefaultRes.data.config.guildId, '');
    console.log('✓ User-scoped config & role-filtered members passed!');

    // 4. Test session start conflict (REST 409 + WS) and userId stamping on Project, Artifact, Note
    console.log('4. Testing session conflict (409 / WS) and userId stamping...');
    const startARes = await apiReq('POST', '/api/helix/session/start', {
      sessionId: 'sess-125-a',
      projectId: 'proj-125-a',
      projectName: 'Run 125 A'
    }, { 'x-user-id': 'user-a', 'x-user-email': 'a@example.com' });
    assert.strictEqual(startARes.status, 200);
    assert.strictEqual(startARes.data.sessionId, 'sess-125-a');
    assert.strictEqual(engine.getActiveSession().guildId, 'guild-seattle');
    assert.strictEqual(engine.getActiveSession().channelId, 'chan-voice-1');
    assert.strictEqual(engine.getActiveSession().language, 'de-DE');

    // Second start with different sessionId must return 409 conflict and NOT overwrite activeSession
    const conflictRes = await apiReq('POST', '/api/helix/session/start', {
      sessionId: 'sess-125-b',
      projectId: 'proj-125-a'
    }, { 'x-user-id': 'user-b', 'x-user-email': 'b@example.com' });
    assert.strictEqual(conflictRes.status, 409);
    assert.strictEqual(conflictRes.data.conflict, true);
    assert.strictEqual(conflictRes.data.activeSessionId, 'sess-125-a');
    assert.strictEqual(engine.getActiveSession().sessionId, 'sess-125-a');

    // WebSocket conflict check
    const wsClient = new WebSocket(`ws://127.0.0.1:${port}/helix/ws?apiKey=${process.env.MCP_API_KEY}`, {
      headers: { 'x-user-id': 'user-b', 'x-user-email': 'b@example.com' }
    });
    await new Promise((resolve, reject) => {
      wsClient.once('open', resolve);
      wsClient.once('error', reject);
    });
    const wsConflictPromise = new Promise((resolve) => {
      wsClient.on('message', (raw) => {
        const msg = JSON.parse(raw.toString());
        if (msg.action === 'session_conflict' || msg.action === 'session_error') {
          resolve(msg);
        }
      });
    });
    wsClient.send(JSON.stringify({
      action: 'session_start',
      sessionId: 'sess-125-ws-conflict',
      projectId: 'proj-125-ws'
    }));
    const wsConflictMsg = await wsConflictPromise;
    assert.strictEqual(wsConflictMsg.conflict, true);
    assert.strictEqual(wsConflictMsg.activeSessionId, 'sess-125-a');
    assert.strictEqual(engine.getActiveSession().sessionId, 'sess-125-a');
    wsClient.close();

    // End sess-125-a and verify userId stamped on Project, Artifact, Note
    const endARes = await apiReq('POST', '/api/helix/session/end', {
      sessionId: 'sess-125-a'
    }, { 'x-user-id': 'user-a' });
    assert.strictEqual(endARes.status, 200);

    const projA = await mongoDB.Project.findOne({ id: 'proj-125-a' }).lean();
    assert.strictEqual(projA.userId, 'user-a');
    assert.strictEqual(projA.userEmail, 'a@example.com');

    const artA = await mongoDB.Artifact.findOne({ id: 'transcript-sess-125-a' }).lean();
    assert.strictEqual(artA.userId, 'user-a');

    const noteA = await mongoDB.Note.findOne({ id: 'summary-sess-125-a' }).lean();
    assert.strictEqual(noteA.userId, 'user-a');

    // Verify user-b's session start uses user-b's scoped HelixConfig when guildId/channelId/language are omitted
    const startBRes = await apiReq('POST', '/api/helix/session/start', {
      sessionId: 'sess-125-b-scoped',
      projectId: 'proj-125-b'
    }, { 'x-user-id': 'user-b', 'x-user-email': 'b@example.com' });
    assert.strictEqual(startBRes.status, 200);
    assert.strictEqual(engine.getActiveSession().guildId, 'guild-berlin');
    assert.strictEqual(engine.getActiveSession().channelId, 'chan-voice-2');
    assert.strictEqual(engine.getActiveSession().language, 'en-US');
    const endBRes = await apiReq('POST', '/api/helix/session/end', {
      sessionId: 'sess-125-b-scoped'
    }, { 'x-user-id': 'user-b' });
    assert.strictEqual(endBRes.status, 200);

    // Verify WS handshake header userId stamping
    const wsUserClient = new WebSocket(`ws://127.0.0.1:${port}/helix/ws?apiKey=${process.env.MCP_API_KEY}`, {
      headers: { 'x-user-id': 'user-ws', 'x-user-email': 'ws@example.com' }
    });
    await new Promise((resolve, reject) => {
      wsUserClient.once('open', resolve);
      wsUserClient.once('error', reject);
    });
    const wsSummaryPromise = new Promise((resolve) => {
      wsUserClient.on('message', (raw) => {
        const msg = JSON.parse(raw.toString());
        if (msg.action === 'session_summary' && msg.sessionId === 'sess-125-ws') {
          resolve(msg);
        }
      });
    });
    wsUserClient.send(JSON.stringify({
      action: 'session_start',
      sessionId: 'sess-125-ws',
      projectId: 'proj-125-ws'
    }));
    await new Promise(r => setTimeout(r, 150));
    wsUserClient.send(JSON.stringify({
      action: 'session_end',
      sessionId: 'sess-125-ws'
    }));
    await wsSummaryPromise;
    wsUserClient.close();

    const projWs = await mongoDB.Project.findOne({ id: 'proj-125-ws' }).lean();
    assert.strictEqual(projWs.userId, 'user-ws');
    const artWs = await mongoDB.Artifact.findOne({ id: 'transcript-sess-125-ws' }).lean();
    assert.strictEqual(artWs.userId, 'user-ws');
    const noteWs = await mongoDB.Note.findOne({ id: 'summary-sess-125-ws' }).lean();
    assert.strictEqual(noteWs.userId, 'user-ws');

    console.log('✓ Session conflict & userId stamping passed!');
  } finally {
    await mongoDB.HelixConfig.deleteMany({ id: { $in: ['default', 'user:user-a', 'user:user-b'] } });
    await mongoDB.Artifact.deleteMany({ projectId: { $in: ['proj-125-a', 'proj-125-ws'] } });
    await mongoDB.Note.deleteMany({ projectId: { $in: ['proj-125-a', 'proj-125-ws'] } });
    await mongoDB.Project.deleteMany({ id: { $in: ['proj-125-a', 'proj-125-ws'] } });
    await new Promise((resolve) => mockFlaskServer.close(resolve));
    await new Promise((resolve) => server.close(resolve));
  }

  await mongoose.disconnect();
  console.log('All Issue #125 tests passed!');
}

runTests().catch(async (err) => {
  console.error('Test failed:', err);
  await mongoose.disconnect().catch(() => {});
  process.exit(1);
});
