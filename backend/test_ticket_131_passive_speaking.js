const assert = require('assert');
const http = require('http');
const express = require('express');
const mongoose = require('mongoose');
const WebSocket = require('ws');
const { EventEmitter } = require('events');
const { PassThrough } = require('stream');

process.env.MONGODB_URI = process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017/shadow_writer_test_131';
process.env.MCP_API_KEY = process.env.MCP_API_KEY || 'test-helix-mcp-key-131';

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

async function waitForCondition(predicate, timeoutMs = 2000, intervalMs = 25) {
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
  console.log('Connected to test MongoDB for Issue #131');

  const testProjects = ['proj-131-a', 'proj-131-b'];
  const testSessions = ['sess-131-1', 'sess-131-unconf', 'sess-131-diff'];

  await mongoDB.HelixConfig.deleteMany({ id: { $in: ['default', 'user:user-131'] } });
  await mongoDB.Artifact.deleteMany({ projectId: { $in: testProjects } });
  await mongoDB.Note.deleteMany({ projectId: { $in: testProjects } });
  await mongoDB.Project.deleteMany({ id: { $in: testProjects } });

  // Mock Flask server for summarization
  const mockFlaskApp = express();
  mockFlaskApp.use(express.json());
  mockFlaskApp.post('/admin/api/internal/helix/summarize', (req, res) => {
    res.json({
      summary: ['Session summarized cleanly.'],
      next_steps: ['Continue shadowrun.']
    });
  });
  const mockFlaskServer = await new Promise((resolve) => {
    const s = mockFlaskApp.listen(0, '127.0.0.1', () => resolve(s));
  });
  const flaskPort = mockFlaskServer.address().port;
  process.env.FLASK_INTERNAL_URL = `http://127.0.0.1:${flaskPort}`;

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
    engine.setMockDiscordState({
      online: true,
      botTag: 'Helix#2080',
      guilds: [
        {
          id: 'g-131',
          name: 'Seattle Grid 131',
          channels: [{ id: 'ch-131', name: 'Run Comms', type: 2 }],
          members: [
            { id: 'd-1', displayName: 'Razor', user: { username: 'razor', bot: false } },
            { id: 'd-2', displayName: 'Kitsune', user: { username: 'kitsune', bot: false } }
          ]
        },
        {
          id: 'g-unconf',
          name: 'Unconfigured Guild',
          channels: [{ id: 'ch-unconf', name: 'Ad-hoc Comms', type: 2 }],
          members: [
            { id: 'd-1', displayName: 'Razor', user: { username: 'razor', bot: false } }
          ]
        }
      ]
    });

    // Track voice connection & stream lifecycle counters
    let joinVoiceChannelCallCount = 0;
    let subscribeCallCount = 0;
    let createOpusDecoderCallCount = 0;
    let createSttStreamCallCount = 0;
    let destroyCallCount = 0;
    const joinedTargets = [];
    const createdConnections = [];
    const activeUserSttStreams = new Map();
    const endedSttStreams = [];
    const destroyedOpusStreams = [];
    const destroyedDecoders = [];

    engine.setVoiceDependencies({
      joinVoiceChannel: ({ guildId, channelId }) => {
        joinVoiceChannelCallCount += 1;
        joinedTargets.push({ guildId: String(guildId || ''), channelId: String(channelId || '') });
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

    // Connect authenticated WS client
    const wsMessages = [];
    wsClient = new WebSocket(`ws://127.0.0.1:${port}/helix/ws?apiKey=${encodeURIComponent(apiKey)}`);
    await new Promise((resolve, reject) => {
      wsClient.once('open', resolve);
      wsClient.once('error', reject);
    });
    wsClient.on('message', (raw) => {
      let wsClient = null;

  try {
        wsMessages.push(JSON.parse(raw.toString()));
      } catch (e) {
        wsMessages.push(raw.toString());
      }
    });

    // --- 1. Passive speaking without active session ---
    console.log('1. Testing passive speaking without active session...');
    assert.strictEqual(typeof engine.connectPassiveVoice, 'function', 'engine.connectPassiveVoice must be exposed');
    engine.connectPassiveVoice({ guildId: 'g-131', channelId: 'ch-131' });
    assert.strictEqual(joinVoiceChannelCallCount, 1, 'connectPassiveVoice must join voice channel once');
    const passiveConn = createdConnections[0];
    assert.ok(passiveConn, 'Passive voice connection must be created');

    passiveConn.speakingEmitter.emit('start', 'd-1');
    const passiveStart = await waitForCondition(() =>
      wsMessages.find((m) => m.action === 'speaking_start' && m.discordId === 'd-1' && m.sessionId === null)
    );
    assert.ok(passiveStart, 'speaking_start must be broadcast over WS during passive monitoring');
    assert.strictEqual(passiveStart.sessionId, null);
    assert.strictEqual(passiveStart.discordId, 'd-1');
    assert.strictEqual(passiveStart.foundryId, null);
    assert.strictEqual(createSttStreamCallCount, 0, 'createSttStream MUST NOT be called without active session');
    assert.strictEqual(createOpusDecoderCallCount, 0, 'createOpusDecoder MUST NOT be called without active session');
    assert.strictEqual(subscribeCallCount, 0, 'receiver.subscribe MUST NOT be called without active session');

    // Verify status reflects speaking: true in passive mode
    const passiveStatusSpeaking = await apiReq('GET', '/api/helix/status');
    assert.strictEqual(passiveStatusSpeaking.status, 200);
    const passiveMemberSpeaking = passiveStatusSpeaking.data.members.find((m) => m.id === 'd-1');
    assert.ok(passiveMemberSpeaking, 'Member d-1 must exist in status');
    assert.strictEqual(passiveMemberSpeaking.speaking, true, 'Member speaking flag must be true during passive speaking');

    passiveConn.speakingEmitter.emit('end', 'd-1');
    const passiveStop = await waitForCondition(() =>
      wsMessages.find((m) => m.action === 'speaking_stop' && m.discordId === 'd-1' && m.sessionId === null)
    );
    assert.ok(passiveStop, 'speaking_stop must be broadcast over WS during passive monitoring');
    assert.strictEqual(passiveStop.sessionId, null);
    assert.strictEqual(passiveStop.discordId, 'd-1');
    assert.strictEqual(passiveStop.foundryId, null);

    const passiveStatusStopped = await apiReq('GET', '/api/helix/status');
    const passiveMemberStopped = passiveStatusStopped.data.members.find((m) => m.id === 'd-1');
    assert.strictEqual(passiveMemberStopped.speaking, false, 'Member speaking flag must be false after speaking stop');
    console.log('✓ Test 1 passed!');

    // --- 2. Transition into session_start reusing existing voice connection ---
    console.log('2. Testing transition into session_start reusing existing voice connection...');
    wsMessages.length = 0;
    wsClient.send(JSON.stringify({
      action: 'session_start',
      sessionId: 'sess-131-1',
      projectId: 'proj-131-a',
      guildId: 'g-131',
      channelId: 'ch-131',
      activePlayers: [
        { foundryId: 'f-1', discordId: 'd-1', name: 'Razor' }
      ]
    }));

    const createdTranscript = await waitForCondition(async () => {
      return mongoDB.Artifact.findOne({ id: 'transcript-sess-131-1' }).lean();
    });
    assert.ok(createdTranscript, 'session_start must create transcript Artifact');
    assert.strictEqual(joinVoiceChannelCallCount, 1, 'joinVoiceChannelCallCount must remain 1 when reusing matching passive connection');

    passiveConn.speakingEmitter.emit('start', 'd-1');
    const activeStart = await waitForCondition(() =>
      wsMessages.find((m) => m.action === 'speaking_start' && m.discordId === 'd-1' && m.sessionId === 'sess-131-1')
    );
    assert.ok(activeStart, 'speaking_start must carry active sessionId');
    assert.strictEqual(activeStart.foundryId, 'f-1');
    assert.strictEqual(createSttStreamCallCount, 1, 'createSttStream must be called once during active session');
    assert.strictEqual(subscribeCallCount, 1, 'receiver.subscribe must be called once during active session');

    // Ensure listener was NOT attached twice
    await new Promise((r) => setTimeout(r, 50));
    const startCount = wsMessages.filter((m) => m.action === 'speaking_start' && m.discordId === 'd-1').length;
    assert.strictEqual(startCount, 1, 'speaking_start must only fire once per speak event (no duplicate listeners)');

    const sttStream = activeUserSttStreams.get('d-1');
    assert.ok(sttStream, 'STT stream for d-1 must exist');
    sttStream.emit('data', {
      results: [
        {
          isFinal: true,
          alternatives: [{ transcript: 'Passive to active works.' }]
        }
      ]
    });

    const updatedTranscript = await waitForCondition(async () => {
      const doc = await mongoDB.Artifact.findOne({ id: 'transcript-sess-131-1' }).lean();
      if (doc && doc.attributes && Array.isArray(doc.attributes.entries) && doc.attributes.entries.length > 0) {
        return doc;
      }
      return null;
    });
    assert.ok(updatedTranscript, 'Transcript Artifact must record final utterance');
    assert.strictEqual(updatedTranscript.attributes.entries[0].text, 'Passive to active works.');

    passiveConn.speakingEmitter.emit('end', 'd-1');
    const activeStop = await waitForCondition(() =>
      wsMessages.find((m) => m.action === 'speaking_stop' && m.discordId === 'd-1' && m.sessionId === 'sess-131-1')
    );
    assert.ok(activeStop, 'speaking_stop must carry active sessionId and foundryId');
    assert.strictEqual(activeStop.foundryId, 'f-1');
    console.log('✓ Test 2 passed!');

    // --- 3. Transition out via session_end preserving passive monitoring ---
    console.log('3. Testing session_end preserves passive monitoring without STT...');
    wsMessages.length = 0;
    wsClient.send(JSON.stringify({
      action: 'session_end',
      sessionId: 'sess-131-1'
    }));

    const summaryEvt = await waitForCondition(() =>
      wsMessages.find((m) => m.action === 'session_summary' && m.sessionId === 'sess-131-1')
    );
    assert.ok(summaryEvt, 'session_summary must be emitted on session_end');
    assert.strictEqual(endedSttStreams.includes('d-1'), true, 'STT stream must be ended on session_end');
    assert.strictEqual(destroyedOpusStreams.includes('d-1'), true, 'Opus stream must be destroyed on session_end');
    assert.ok(destroyedDecoders.length >= 1, 'PCM decoder must be destroyed on session_end');
    assert.strictEqual(destroyCallCount, 0, 'voiceConnection.destroy() must NOT be called when passive monitoring is configured');
    assert.strictEqual(passiveConn.destroyed, false);

    // Emit passive speaking after session_end
    wsMessages.length = 0;
    passiveConn.speakingEmitter.emit('start', 'd-1');
    const postStart = await waitForCondition(() =>
      wsMessages.find((m) => m.action === 'speaking_start' && m.discordId === 'd-1')
    );
    assert.ok(postStart, 'Passive speaking_start must still work after session_end');
    assert.strictEqual(postStart.sessionId, null);
    assert.strictEqual(postStart.foundryId, null);
    assert.strictEqual(createSttStreamCallCount, 1, 'createSttStreamCallCount must STILL equal 1 after session_end');
    assert.strictEqual(subscribeCallCount, 1, 'subscribeCallCount must STILL equal 1 after session_end');

    passiveConn.speakingEmitter.emit('end', 'd-1');
    const postStop = await waitForCondition(() =>
      wsMessages.find((m) => m.action === 'speaking_stop' && m.discordId === 'd-1')
    );
    assert.ok(postStop, 'Passive speaking_stop must still work after session_end');
    assert.strictEqual(postStop.sessionId, null);
    console.log('✓ Test 3 passed!');

    // --- 4. Unconfigured channel session_end teardown ---
    console.log('4. Testing unconfigured channel session_end teardown...');
    // Clear passive monitoring via POST /api/helix/config with empty guildId/channelId
    const clearCfgRes = await apiReq('POST', '/api/helix/config', {
      guildId: '',
      channelId: '',
      language: 'de-DE'
    });
    assert.strictEqual(clearCfgRes.status, 200);
    assert.strictEqual(destroyCallCount, 1, 'Clearing config channel must destroy passive voice connection');

    wsMessages.length = 0;
    wsClient.send(JSON.stringify({
      action: 'session_start',
      sessionId: 'sess-131-unconf',
      projectId: 'proj-131-b',
      guildId: 'g-unconf',
      channelId: 'ch-unconf',
      activePlayers: [
        { foundryId: 'f-1', discordId: 'd-1', name: 'Razor' }
      ]
    }));

    await waitForCondition(async () => mongoDB.Artifact.findOne({ id: 'transcript-sess-131-unconf' }).lean());
    assert.strictEqual(joinVoiceChannelCallCount, 2, 'New voice connection must be joined for unconfigured session');
    const unconfConn = createdConnections[1];
    assert.ok(unconfConn);

    unconfConn.speakingEmitter.emit('start', 'd-1');
    await waitForCondition(() =>
      wsMessages.find((m) => m.action === 'speaking_start' && m.sessionId === 'sess-131-unconf')
    );
    assert.strictEqual(createSttStreamCallCount, 2, 'STT stream must be created during unconfigured active session');

    wsClient.send(JSON.stringify({
      action: 'session_end',
      sessionId: 'sess-131-unconf'
    }));
    await waitForCondition(() =>
      wsMessages.find((m) => m.action === 'session_summary' && m.sessionId === 'sess-131-unconf')
    );

    assert.strictEqual(destroyCallCount, 2, 'Unconfigured channel voiceConnection must be destroyed on session_end');
    assert.strictEqual(unconfConn.destroyed, true);

    // Ensure speaking listeners were detached cleanly
    wsMessages.length = 0;
    unconfConn.speakingEmitter.emit('start', 'd-1');
    await new Promise((r) => setTimeout(r, 60));
    assert.strictEqual(wsMessages.length, 0, 'Detached connection must not emit speaking_start after teardown');
    assert.strictEqual(createSttStreamCallCount, 2, 'No STT stream must be created after teardown');
    console.log('✓ Test 4 passed!');

    // --- 5. POST /api/helix/config auto-connects passive voice when no activeSession ---
    console.log('5. Testing POST /api/helix/config auto-connects passive voice...');
    const saveCfgRes = await apiReq('POST', '/api/helix/config', {
      guildId: 'g-131',
      channelId: 'ch-131',
      language: 'de-DE'
    });
    assert.strictEqual(saveCfgRes.status, 200);
    assert.strictEqual(joinVoiceChannelCallCount, 3, 'POST /api/helix/config must trigger connectPassiveVoice when no activeSession');
    const cfgConn = createdConnections[2];
    assert.ok(cfgConn);

    wsMessages.length = 0;
    cfgConn.speakingEmitter.emit('start', 'd-2');
    const cfgStart = await waitForCondition(() =>
      wsMessages.find((m) => m.action === 'speaking_start' && m.discordId === 'd-2')
    );
    assert.ok(cfgStart, 'Auto-connected passive voice from POST /api/helix/config must emit speaking_start');
    assert.strictEqual(cfgStart.sessionId, null);
    assert.strictEqual(createSttStreamCallCount, 2, 'Auto-connected passive voice must NOT open STT stream');
    cfgConn.speakingEmitter.emit('end', 'd-2');
    await waitForCondition(() =>
      wsMessages.find((m) => m.action === 'speaking_stop' && m.discordId === 'd-2')
    );
    console.log('✓ Test 5 passed!');

    // --- 6. session_start for a different guild/channel destroys old passive connection ---
    console.log('6. Testing session_start for a different channel destroys old passive connection...');
    wsMessages.length = 0;
    cfgConn.speakingEmitter.emit('start', 'd-2');
    await waitForCondition(() =>
      wsMessages.find((m) => m.action === 'speaking_start' && m.discordId === 'd-2' && m.sessionId === null)
    );
    wsMessages.length = 0;

    wsClient.send(JSON.stringify({
      action: 'session_start',
      sessionId: 'sess-131-diff',
      projectId: 'proj-131-b',
      guildId: 'g-unconf',
      channelId: 'ch-unconf',
      activePlayers: [{ foundryId: 'f-1', discordId: 'd-1', name: 'Razor' }]
    }));
    await waitForCondition(async () => mongoDB.Artifact.findOne({ id: 'transcript-sess-131-diff' }).lean());
    assert.strictEqual(cfgConn.destroyed, true, 'Old passive connection for different channel must be destroyed');
    assert.strictEqual(joinVoiceChannelCallCount, 4, 'New connection must be joined for different channel');

    // Old connection speaking events must be detached
    cfgConn.speakingEmitter.emit('start', 'd-2');
    await new Promise((r) => setTimeout(r, 50));
    assert.strictEqual(
      wsMessages.some((m) => m.action === 'speaking_start' && m.discordId === 'd-2'),
      false,
      'Detached old passive connection must not emit speaking_start'
    );

    wsClient.send(JSON.stringify({
      action: 'session_end',
      sessionId: 'sess-131-diff'
    }));
    await waitForCondition(() =>
      wsMessages.find((m) => m.action === 'session_summary' && m.sessionId === 'sess-131-diff')
    );
    console.log('✓ Test 6 passed!');

    wsClient.close();
  } finally {
    if (wsClient && wsClient.readyState !== WebSocket.CLOSED) {
      try { wsClient.terminate(); } catch (e) {}
    }
    await mongoDB.HelixConfig.deleteMany({ id: { $in: ['default', 'user:user-131'] } });
    await mongoDB.Artifact.deleteMany({ projectId: { $in: testProjects } });
    await mongoDB.Note.deleteMany({ projectId: { $in: testProjects } });
    await mongoDB.Project.deleteMany({ id: { $in: testProjects } });
    if (typeof mockFlaskServer.closeAllConnections === 'function') mockFlaskServer.closeAllConnections();
    if (typeof server.closeAllConnections === 'function') server.closeAllConnections();
    await new Promise((resolve) => mockFlaskServer.close(resolve));
    await new Promise((resolve) => server.close(resolve));
  }

  await mongoose.disconnect();
  console.log('All Issue #131 tests passed!');
}

runTests().catch(async (err) => {
  console.error('Test failed:', err);
  await mongoose.disconnect().catch(() => {});
  process.exit(1);
});
