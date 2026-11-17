const assert = require('assert');
const http = require('http');
const express = require('express');
const mongoose = require('mongoose');
const WebSocket = require('ws');

process.env.MONGODB_URI = process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017/shadow_writer_test_128';
process.env.MCP_API_KEY = 'test-helix-mcp-key-128';
delete process.env.REDSHADOW_INTERNAL_API_KEY;

const mongoDB = require('./mongoDB');
const { setupHelixEngine } = require('./helixEngine');

const VALID_LICENSE_KEY = 'sr-valid-license-128';
const EXPIRED_LICENSE_KEY = 'sr-expired-license-128';
const INVALID_LICENSE_KEY = 'sr-invalid-license-128';

function connectWsAndExpectOpen(url, options = {}) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url, options);
    let opened = false;
    const timer = setTimeout(() => {
      ws.terminate();
      reject(new Error(`Timed out waiting for WS open: ${url}`));
    }, 5000);

    ws.once('open', () => {
      opened = true;
      setTimeout(() => {
        clearTimeout(timer);
        if (ws.readyState === WebSocket.OPEN) {
          resolve(ws);
        } else {
          reject(new Error(`WS closed unexpectedly after open (state=${ws.readyState})`));
        }
      }, 100);
    });

    ws.once('close', (code, reason) => {
      if (!opened) {
        clearTimeout(timer);
        reject(new Error(`WS closed before open: code=${code} reason=${reason ? reason.toString() : ''}`));
      }
    });

    ws.once('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

function connectWsAndExpectClose(url, options = {}, expectedCode = 4001) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url, options);
    const timer = setTimeout(() => {
      ws.terminate();
      reject(new Error(`Timed out waiting for WS close ${expectedCode}: ${url}`));
    }, 5000);

    ws.once('close', (code, reason) => {
      clearTimeout(timer);
      try {
        assert.strictEqual(code, expectedCode, `Expected close code ${expectedCode}, got ${code}`);
        resolve({ code, reason: reason ? reason.toString() : '' });
      } catch (err) {
        reject(err);
      }
    });

    ws.once('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

async function runTests() {
  const recordedRequests = [];

  // Mock Flask server mimicking /api/shadowrun/helix/verify-key (POST only)
  const mockFlaskApp = express();
  mockFlaskApp.use(express.json());

  mockFlaskApp.all('/api/shadowrun/helix/verify-key', (req, res) => {
    recordedRequests.push({
      method: req.method,
      headers: { ...req.headers },
      body: req.body ? { ...req.body } : {}
    });

    if (req.method !== 'POST') {
      return res.status(405).json({ error: 'Method not allowed for this API endpoint', status_code: 405 });
    }

    const key = String(req.headers['x-api-key'] || (req.body && req.body.apiKey) || '').trim();
    if (!key) {
      return res.status(401).json({ valid: false, error: 'Missing API key' });
    }
    if (key === VALID_LICENSE_KEY) {
      return res.status(200).json({
        valid: true,
        user_id: '42',
        email: 'gm-128@shadowplays.de'
      });
    }
    if (key === EXPIRED_LICENSE_KEY) {
      return res.status(403).json({
        valid: false,
        error: 'License key is inactive or expired'
      });
    }
    return res.status(401).json({
      valid: false,
      error: 'Invalid API key'
    });
  });

  const mockFlaskServer = await new Promise((resolve) => {
    const s = mockFlaskApp.listen(0, '127.0.0.1', () => resolve(s));
  });
  const flaskPort = mockFlaskServer.address().port;
  process.env.FLASK_INTERNAL_URL = `http://127.0.0.1:${flaskPort}`;

  // Spin up Express + HTTP + WS server with setupHelixEngine
  const app = express();
  app.use(express.json());
  const server = http.createServer(app);
  setupHelixEngine(app, server);

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const wsPort = server.address().port;

  try {
    // 1. Valid license key via query param -> POST verify-key -> stays OPEN
    console.log('1. Testing /helix/ws auth with valid license key via query param...');
    recordedRequests.length = 0;
    const wsQuery = await connectWsAndExpectOpen(`ws://127.0.0.1:${wsPort}/helix/ws?apiKey=${VALID_LICENSE_KEY}`);
    assert.strictEqual(wsQuery.readyState, WebSocket.OPEN);
    assert.strictEqual(recordedRequests.length, 1);
    assert.strictEqual(recordedRequests[0].method, 'POST');
    assert.strictEqual(recordedRequests[0].headers['x-api-key'], VALID_LICENSE_KEY);
    assert.deepStrictEqual(recordedRequests[0].body, { apiKey: VALID_LICENSE_KEY });
    await new Promise((r) => {
      wsQuery.once('close', r);
      wsQuery.close();
    });
    console.log('✓ Valid query-param WS auth passed!');

    // 2. Valid license key via x-api-key header -> POST verify-key -> stays OPEN
    console.log('2. Testing /helix/ws auth with valid license key via x-api-key header...');
    recordedRequests.length = 0;
    const wsHeader = await connectWsAndExpectOpen(`ws://127.0.0.1:${wsPort}/helix/ws`, {
      headers: { 'x-api-key': VALID_LICENSE_KEY }
    });
    assert.strictEqual(wsHeader.readyState, WebSocket.OPEN);
    assert.strictEqual(recordedRequests.length, 1);
    assert.strictEqual(recordedRequests[0].method, 'POST');
    assert.strictEqual(recordedRequests[0].headers['x-api-key'], VALID_LICENSE_KEY);
    assert.deepStrictEqual(recordedRequests[0].body, { apiKey: VALID_LICENSE_KEY });
    await new Promise((r) => {
      wsHeader.once('close', r);
      wsHeader.close();
    });
    console.log('✓ Valid header WS auth passed!');

    // 3. Invalid license key -> Flask returns 401 -> WS closes with 4001
    console.log('3. Testing /helix/ws closes with 4001 for invalid license key...');
    recordedRequests.length = 0;
    const closeInvalid = await connectWsAndExpectClose(
      `ws://127.0.0.1:${wsPort}/helix/ws?apiKey=${INVALID_LICENSE_KEY}`,
      {},
      4001
    );
    assert.strictEqual(closeInvalid.code, 4001);
    assert.strictEqual(recordedRequests.length, 1);
    assert.strictEqual(recordedRequests[0].method, 'POST');
    console.log('✓ Invalid key closed with 4001!');

    // 4. Expired license key -> Flask returns 403 -> WS closes with 4001
    console.log('4. Testing /helix/ws closes with 4001 for expired license key...');
    recordedRequests.length = 0;
    const closeExpired = await connectWsAndExpectClose(
      `ws://127.0.0.1:${wsPort}/helix/ws?apiKey=${EXPIRED_LICENSE_KEY}`,
      {},
      4001
    );
    assert.strictEqual(closeExpired.code, 4001);
    assert.strictEqual(recordedRequests.length, 1);
    assert.strictEqual(recordedRequests[0].method, 'POST');
    console.log('✓ Expired key closed with 4001!');

    // 5. Missing API key -> WS closes with 4001
    console.log('5. Testing /helix/ws closes with 4001 when API key is missing...');
    recordedRequests.length = 0;
    const closeMissing = await connectWsAndExpectClose(
      `ws://127.0.0.1:${wsPort}/helix/ws`,
      {},
      4001
    );
    assert.strictEqual(closeMissing.code, 4001);
    assert.strictEqual(recordedRequests.length, 0);
    console.log('✓ Missing key closed with 4001!');

    // 6. Valid first-frame auth ({ action: 'auth', apiKey }) with NO query string -> auth_ok -> stays OPEN
    console.log('6. Testing /helix/ws first-frame auth with valid license key (no query string)...');
    recordedRequests.length = 0;
    const wsFirstFrame = await new Promise((resolve, reject) => {
      const ws = new WebSocket(`ws://127.0.0.1:${wsPort}/helix/ws`);
      const timer = setTimeout(() => {
        ws.terminate();
        reject(new Error('Timed out waiting for first-frame auth_ok'));
      }, 5000);
      ws.once('open', () => {
        ws.send(JSON.stringify({ action: 'auth', apiKey: VALID_LICENSE_KEY }));
      });
      ws.on('message', (raw) => {
        const msg = JSON.parse(raw.toString());
        if (msg.action === 'auth_ok') {
          clearTimeout(timer);
          resolve(ws);
        }
      });
      ws.once('close', (code) => {
        clearTimeout(timer);
        reject(new Error(`WS closed unexpectedly with code=${code}`));
      });
      ws.once('error', (err) => {
        clearTimeout(timer);
        reject(err);
      });
    });
    assert.strictEqual(wsFirstFrame.readyState, WebSocket.OPEN);
    assert.strictEqual(recordedRequests.length, 1);
    assert.strictEqual(recordedRequests[0].method, 'POST');
    assert.strictEqual(recordedRequests[0].headers['x-api-key'], VALID_LICENSE_KEY);
    await new Promise((r) => {
      wsFirstFrame.once('close', r);
      wsFirstFrame.close();
    });
    console.log('✓ First-frame auth succeeded without query-string key!');

    // 7. Invalid first-frame auth -> closes with 4001
    console.log('7. Testing /helix/ws first-frame auth closes with 4001 on invalid key...');
    const closeInvalidFrame = await new Promise((resolve, reject) => {
      const ws = new WebSocket(`ws://127.0.0.1:${wsPort}/helix/ws`);
      const timer = setTimeout(() => {
        ws.terminate();
        reject(new Error('Timed out waiting for close 4001 on invalid first-frame auth'));
      }, 5000);
      ws.once('open', () => {
        ws.send(JSON.stringify({ action: 'auth', apiKey: INVALID_LICENSE_KEY }));
      });
      ws.once('close', (code) => {
        clearTimeout(timer);
        resolve(code);
      });
    });
    assert.strictEqual(closeInvalidFrame, 4001);
    console.log('✓ Invalid first-frame auth closed with 4001!');

    // 8. Non-auth first frame before authenticating -> closes with 4001
    console.log('8. Testing /helix/ws closes with 4001 on non-auth first frame...');
    const closeNonAuthFrame = await new Promise((resolve, reject) => {
      const ws = new WebSocket(`ws://127.0.0.1:${wsPort}/helix/ws`);
      const timer = setTimeout(() => {
        ws.terminate();
        reject(new Error('Timed out waiting for close 4001 on non-auth first frame'));
      }, 5000);
      ws.once('open', () => {
        ws.send(JSON.stringify({ action: 'session_marker', label: 'unauth' }));
      });
      ws.once('close', (code) => {
        clearTimeout(timer);
        resolve(code);
      });
    });
    assert.strictEqual(closeNonAuthFrame, 4001);
    console.log('✓ Non-auth first frame closed with 4001!');

    console.log('All Ticket #128 WS verify-key tests passed!');
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await new Promise((resolve) => mockFlaskServer.close(resolve));
    if (mongoDB.dbReadyPromise) {
      await Promise.race([mongoDB.dbReadyPromise, new Promise((r) => setTimeout(r, 1000))]).catch(() => {});
    }
    await mongoose.disconnect().catch(() => {});
  }
}

runTests().catch(async (err) => {
  console.error('Test failed:', err);
  await mongoose.disconnect().catch(() => {});
  process.exit(1);
});
