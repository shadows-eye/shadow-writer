const assert = require('assert');
const express = require('express');
const mongoose = require('mongoose');
const WebSocket = require('ws');

process.env.MONGODB_URI = process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017/shadow_writer_test_126';
process.env.MCP_API_KEY = process.env.MCP_API_KEY || 'test-helix-mcp-key-126';

const mongoDB = require('./mongoDB');
const { server } = require('./server');

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
  console.log('Connected to test MongoDB for Issue #126');

  const testProjectIds = ['book-a', 'book-b', 'book-owned', 'book-unowned'];
  await mongoDB.HelixConfig.deleteMany({ id: { $in: ['default', 'user:user-a', 'user:user-b'] } });
  await mongoDB.Artifact.deleteMany({ projectId: { $in: testProjectIds } });
  await mongoDB.Note.deleteMany({ projectId: { $in: testProjectIds } });
  await mongoDB.Project.deleteMany({ id: { $in: testProjectIds } });

  // Mock Flask summarizer server
  const mockFlaskApp = express();
  mockFlaskApp.use(express.json());
  mockFlaskApp.post('/admin/api/internal/helix/summarize', (req, res) => {
    const pid = (req.body && req.body.projectId) || 'unknown';
    res.json({
      summary: [`Summary for ${pid}`],
      next_steps: [`Next step for ${pid}`]
    });
  });
  const mockFlaskServer = await new Promise((resolve) => {
    const s = mockFlaskApp.listen(0, '127.0.0.1', () => resolve(s));
  });
  process.env.FLASK_INTERNAL_URL = `http://127.0.0.1:${mockFlaskServer.address().port}`;

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  const baseUrl = `http://127.0.0.1:${port}`;

  async function apiReq(method, path, body = null, headers = {}) {
    const opts = {
      method,
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.MCP_API_KEY,
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
    // 1. Test POST /api/helix/session/start with bookId returns projectId, and POST /api/helix/session/end returns projectId + WS session_summary includes projectId
    console.log('1. Testing session/start, session/end, WS session_summary projectId & structured Note...');
    const ws = new WebSocket(`ws://127.0.0.1:${port}/helix/ws`, {
      headers: { 'x-api-key': process.env.MCP_API_KEY, 'x-user-id': 'user-a' }
    });
    const wsMessages = [];
    await new Promise((resolve, reject) => {
      ws.on('open', resolve);
      ws.on('error', reject);
    });
    ws.on('message', (raw) => {
      try {
        wsMessages.push(JSON.parse(raw.toString()));
      } catch (_) {}
    });

    const startRes = await apiReq(
      'POST',
      '/api/helix/session/start',
      { sessionId: 'sess-126-a', bookId: 'book-a', projectName: 'Book A' },
      { 'x-user-id': 'user-a', 'x-user-email': 'a@example.com' }
    );
    assert.strictEqual(startRes.status, 200);
    assert.strictEqual(startRes.data.sessionId, 'sess-126-a');
    assert.strictEqual(startRes.data.projectId, 'book-a', 'session/start should return projectId');

    const endRes = await apiReq(
      'POST',
      '/api/helix/session/end',
      { sessionId: 'sess-126-a' },
      { 'x-user-id': 'user-a' }
    );
    assert.strictEqual(endRes.status, 200);
    assert.strictEqual(endRes.data.sessionId, 'sess-126-a');
    assert.strictEqual(endRes.data.projectId, 'book-a', 'session/end should return projectId');

    await new Promise((r) => setTimeout(r, 150));
    const summaryWsMsg = wsMessages.find((m) => m.action === 'session_summary' && m.sessionId === 'sess-126-a');
    assert.ok(summaryWsMsg, 'Should emit session_summary WS message');
    assert.strictEqual(summaryWsMsg.projectId, 'book-a', 'WS session_summary should include projectId');
    ws.close();

    // Verify Note has structured storage + projectId & sessionId in attributes
    const noteA = await mongoDB.Note.findOne({ projectId: 'book-a', id: 'summary-sess-126-a' }).lean();
    assert.ok(noteA, 'Summary Note should exist for book-a');
    assert.strictEqual(noteA.content, '', 'Note content must remain empty string');
    assert.strictEqual(noteA.userId, 'user-a');
    assert.strictEqual(noteA.attributes.projectId, 'book-a');
    assert.strictEqual(noteA.attributes.sessionId, 'sess-126-a');
    assert.strictEqual(typeof noteA.attributes.summary.text, 'string');
    assert.strictEqual(typeof noteA.attributes.summary.html, 'string');
    console.log('✓ Test 1 passed!');

    // 2. Test GET /api/helix/summary/:jobId scoping by projectId and userId
    console.log('2. Testing GET /api/helix/summary/:jobId scoping by projectId and userId...');
    // Owner + matching projectId -> completed with projectId and sessionId
    const okSummary = await apiReq(
      'GET',
      '/api/helix/summary/sess-126-a?projectId=book-a',
      null,
      { 'x-user-id': 'user-a' }
    );
    assert.strictEqual(okSummary.status, 200);
    assert.strictEqual(okSummary.data.status, 'completed');
    assert.strictEqual(okSummary.data.projectId, 'book-a');
    assert.strictEqual(okSummary.data.sessionId, 'sess-126-a');

    // Also works with bookId query param
    const okSummaryBookId = await apiReq(
      'GET',
      '/api/helix/summary/sess-126-a?bookId=book-a',
      null,
      { 'x-user-id': 'user-a' }
    );
    assert.strictEqual(okSummaryBookId.data.status, 'completed');
    assert.strictEqual(okSummaryBookId.data.projectId, 'book-a');

    // Different projectId (book-b) -> must NOT return book-a's summary
    const wrongBookSummary = await apiReq(
      'GET',
      '/api/helix/summary/sess-126-a?projectId=book-b',
      null,
      { 'x-user-id': 'user-a' }
    );
    assert.strictEqual(wrongBookSummary.status, 200);
    assert.strictEqual(wrongBookSummary.data.status, 'processing', 'Should not leak book-a summary to book-b');

    // Different userId (user-b) -> must NOT return user-a's summary
    const wrongUserSummary = await apiReq(
      'GET',
      '/api/helix/summary/sess-126-a?projectId=book-a',
      null,
      { 'x-user-id': 'user-b' }
    );
    assert.strictEqual(wrongUserSummary.status, 200);
    assert.strictEqual(wrongUserSummary.data.status, 'processing', 'Should not leak user-a summary to user-b');
    console.log('✓ Test 2 passed!');

    // 3. Test handleSessionEnd does NOT overwrite another project's summary Note with same sessionId
    console.log('3. Testing per-project Note isolation when sessionId collides...');
    const startShared = await apiReq(
      'POST',
      '/api/helix/session/start',
      { sessionId: 'shared-sess', projectId: 'book-b' },
      { 'x-user-id': 'user-b' }
    );
    assert.strictEqual(startShared.status, 200);
    await apiReq('POST', '/api/helix/session/end', { sessionId: 'shared-sess' }, { 'x-user-id': 'user-b' });

    // Pre-create a note in book-a with id summary-shared-sess-2 and end session in book-b with same sessionId
    await mongoDB.Note.create({
      projectId: 'book-a',
      id: 'summary-shared-sess-2',
      userId: 'user-a',
      name: 'Book A Original',
      title: 'Book A Original',
      content: '',
      attributes: {
        type: 'summary',
        subtypeTag: 'summary',
        sessionId: 'shared-sess-2',
        projectId: 'book-a',
        summary: { text: 'Original A', html: '<p>Original A</p>' },
        next_steps: { text: '', html: '' }
      }
    });

    await apiReq(
      'POST',
      '/api/helix/session/start',
      { sessionId: 'shared-sess-2', projectId: 'book-b' },
      { 'x-user-id': 'user-b' }
    );
    await apiReq('POST', '/api/helix/session/end', { sessionId: 'shared-sess-2' }, { 'x-user-id': 'user-b' });

    const noteAStillIntact = await mongoDB.Note.findOne({ projectId: 'book-a', id: 'summary-shared-sess-2' }).lean();
    const noteBCreated = await mongoDB.Note.findOne({ projectId: 'book-b', id: 'summary-shared-sess-2' }).lean();
    assert.ok(noteAStillIntact, 'Book A note must still exist');
    assert.strictEqual(noteAStillIntact.userId, 'user-a', 'Book A note userId must not be overwritten');
    assert.strictEqual(noteAStillIntact.attributes.summary.text, 'Original A', 'Book A note summary must not be overwritten');
    assert.ok(noteBCreated, 'Book B must get its own summary note');
    assert.strictEqual(noteBCreated.userId, 'user-b');
    assert.strictEqual(noteBCreated.attributes.projectId, 'book-b');
    console.log('✓ Test 3 passed!');

    // 4. Test handleSessionStart Project ownership protection
    console.log('4. Testing handleSessionStart Project ownership protection...');
    await mongoDB.Project.create({
      id: 'book-owned',
      name: 'Owned By User A',
      genre: 'shadowrun',
      userId: 'user-a',
      userEmail: 'a@example.com'
    });
    await mongoDB.Project.create({
      id: 'book-unowned',
      name: 'Unowned Book',
      genre: 'shadowrun'
    });

    // User B tries to start a session on User A's project -> 403 Forbidden, no Artifact/Note created
    const startOwnedRes = await apiReq(
      'POST',
      '/api/helix/session/start',
      { sessionId: 'sess-owned-check', projectId: 'book-owned', projectName: 'Hijacked Name' },
      { 'x-user-id': 'user-b', 'x-user-email': 'b@example.com' }
    );
    assert.strictEqual(startOwnedRes.status, 403, 'session/start on another user project must return 403');
    const leakedArtifact = await mongoDB.Artifact.findOne({ projectId: 'book-owned', id: 'transcript-sess-owned-check' }).lean();
    assert.strictEqual(leakedArtifact, null, 'No transcript Artifact should be created on forbidden session/start');

    const ownedProjAfter = await mongoDB.Project.findOne({ id: 'book-owned' }).lean();
    assert.strictEqual(ownedProjAfter.userId, 'user-a', 'Existing project userId must not be overwritten by another user');
    assert.strictEqual(ownedProjAfter.userEmail, 'a@example.com', 'Existing project userEmail must not be overwritten');
    assert.strictEqual(ownedProjAfter.name, 'Owned By User A', 'Existing project name must not be overwritten');

    // User A starts a session on an unowned project -> userId/userEmail can be claimed
    const startUnownedRes = await apiReq(
      'POST',
      '/api/helix/session/start',
      { sessionId: 'sess-unowned-check', projectId: 'book-unowned' },
      { 'x-user-id': 'user-a', 'x-user-email': 'a@example.com' }
    );
    assert.strictEqual(startUnownedRes.status, 200);
    await apiReq('POST', '/api/helix/session/end', { sessionId: 'sess-unowned-check' }, { 'x-user-id': 'user-a' });

    const unownedProjAfter = await mongoDB.Project.findOne({ id: 'book-unowned' }).lean();
    assert.strictEqual(unownedProjAfter.userId, 'user-a', 'Unowned project should be claimed by session user');
    console.log('✓ Test 4 passed!');

    // 5. Test POST /api/notes/summary-<id> & GET /api/notes/summary-<id> userId isolation + scalar attributes.projectId
    console.log('5. Testing POST/GET /api/notes/summary-<id> userId isolation & scalar projectId...');
    const postNoteRes = await apiReq(
      'POST',
      '/api/notes/summary-note-126',
      {
        projectId: 'book-a',
        title: 'Run Summary (note-126)',
        type: 'summary',
        subtypeTag: 'summary',
        attributes: {
          type: 'summary',
          subtypeTag: 'summary',
          sessionId: 'note-126',
          projectId: 'book-a',
          summary: { text: 'Direct note summary', html: '<p>Direct note summary</p>' },
          next_steps: { text: 'Direct next step', html: '<p>Direct next step</p>' }
        }
      },
      { 'x-user-id': 'user-a' }
    );
    assert.strictEqual(postNoteRes.status, 200, 'POST /api/notes/summary-note-126 should succeed');
    const savedDirectNote = await mongoDB.Note.findOne({ projectId: 'book-a', id: 'summary-note-126' }).lean();
    assert.ok(savedDirectNote, 'Summary note should be persisted');
    assert.strictEqual(savedDirectNote.userId, 'user-a', 'POST /api/notes should persist X-User-Id as userId');
    assert.strictEqual(savedDirectNote.attributes.projectId, 'book-a', 'attributes.projectId must remain a scalar string');
    assert.strictEqual(savedDirectNote.attributes.sessionId, 'note-126', 'attributes.sessionId must remain a scalar string');

    // Cross-user overwrite via POST /api/notes must return 403
    const forbiddenPostRes = await apiReq(
      'POST',
      '/api/notes/summary-note-126',
      {
        projectId: 'book-a',
        title: 'Hijacked',
        attributes: { summary: { text: 'Hijacked', html: '<p>Hijacked</p>' } }
      },
      { 'x-user-id': 'user-b' }
    );
    assert.strictEqual(forbiddenPostRes.status, 403, 'Cross-user POST /api/notes must return 403');

    // GET /api/helix/summary/:id returns completed for owner, processing for other user
    const helixDirectOwner = await apiReq(
      'GET',
      '/api/helix/summary/note-126?projectId=book-a',
      null,
      { 'x-user-id': 'user-a' }
    );
    assert.strictEqual(helixDirectOwner.status, 200);
    assert.strictEqual(helixDirectOwner.data.status, 'completed');
    assert.strictEqual(helixDirectOwner.data.projectId, 'book-a');

    const helixDirectOther = await apiReq(
      'GET',
      '/api/helix/summary/note-126?projectId=book-a',
      null,
      { 'x-user-id': 'user-b' }
    );
    assert.strictEqual(helixDirectOther.status, 200);
    assert.strictEqual(helixDirectOther.data.status, 'processing', 'GET /api/helix/summary must hide user-a note from user-b');

    // GET /api/notes/summary-<id> enforces X-User-Id isolation
    const getNoteOwner = await apiReq(
      'GET',
      '/api/notes/summary-note-126?projectId=book-a',
      null,
      { 'x-user-id': 'user-a' }
    );
    assert.strictEqual(getNoteOwner.status, 200, 'Owner should retrieve note via GET /api/notes');

    const getNoteOther = await apiReq(
      'GET',
      '/api/notes/summary-note-126?projectId=book-a',
      null,
      { 'x-user-id': 'user-b' }
    );
    assert.strictEqual(getNoteOther.status, 404, 'Other user should get 404 via GET /api/notes');
    console.log('✓ Test 5 passed!');

    // 6. Test POST /api/helix/session/end forwards X-User-Id when activeSession is absent & does not overwrite another user's note
    console.log('6. Testing POST /api/helix/session/end X-User-Id forwarding when activeSession is absent...');
    const endNoActiveRes = await apiReq(
      'POST',
      '/api/helix/session/end',
      { sessionId: 'sess-no-active-126', projectId: 'book-a' },
      { 'x-user-id': 'user-a', 'x-user-email': 'a@example.com' }
    );
    assert.strictEqual(endNoActiveRes.status, 200);
    const noActiveNote = await mongoDB.Note.findOne({ projectId: 'book-a', id: 'summary-sess-no-active-126' }).lean();
    assert.ok(noActiveNote, 'Summary note should be created when activeSession is absent');
    assert.strictEqual(noActiveNote.userId, 'user-a', 'session/end must forward X-User-Id when activeSession is absent');

    // Attempting to end same sessionId + projectId as user-b must NOT overwrite user-a's note
    await apiReq(
      'POST',
      '/api/helix/session/end',
      { sessionId: 'sess-no-active-126', projectId: 'book-a' },
      { 'x-user-id': 'user-b', 'x-user-email': 'b@example.com' }
    );
    const noActiveNoteAfter = await mongoDB.Note.findOne({ projectId: 'book-a', id: 'summary-sess-no-active-126' }).lean();
    assert.strictEqual(noActiveNoteAfter.userId, 'user-a', 'session/end must not overwrite another user note');
    console.log('✓ Test 6 passed!');

    console.log('All Issue #126 tests passed!');
  } finally {
    await mongoDB.HelixConfig.deleteMany({ id: { $in: ['default', 'user:user-a', 'user:user-b'] } });
    await mongoDB.Artifact.deleteMany({ projectId: { $in: testProjectIds } });
    await mongoDB.Note.deleteMany({ projectId: { $in: testProjectIds } });
    await mongoDB.Project.deleteMany({ id: { $in: testProjectIds } });
    server.close();
    mockFlaskServer.close();
    await mongoose.disconnect();
  }
}

runTests().catch((err) => {
  console.error('Test failed:', err);
  process.exit(1);
});
