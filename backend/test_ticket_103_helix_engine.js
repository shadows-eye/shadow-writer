const assert = require('assert');
const mongoose = require('mongoose');

process.env.MONGODB_URI = process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017/shadow_writer_test_103';
process.env.MCP_API_KEY = process.env.MCP_API_KEY || 'test-helix-mcp-key-103';

const mongoDB = require('./mongoDB');

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
  console.log('Connected to test MongoDB for Issue #103');

  // --- SLICE 1: Database Models, Metadata Key Preservation, Genre Profile & On-the-Fly Markdown ---
  console.log('Running Slice 1: Database Models, Metadata Keys, shadowrun Genre & Markdown Synthesis...');

  // 1a. Verify METADATA_ATTRIBUTE_KEYS contains Helix keys
  const requiredHelixMetaKeys = ['sessionId', 'entries', 'markers', 'activePlayers', 'startedAt', 'endedAt'];
  for (const key of requiredHelixMetaKeys) {
    assert.strictEqual(
      mongoDB.METADATA_ATTRIBUTE_KEYS.has(key),
      true,
      `METADATA_ATTRIBUTE_KEYS must include '${key}'`
    );
  }

  // 1b. Verify HelixConfig model exists and defaults properly
  assert.ok(mongoDB.HelixConfig, 'HelixConfig model must be exported from mongoDB.js');
  await mongoDB.HelixConfig.deleteMany({});
  const defaultCfg = await mongoDB.HelixConfig.create({
    id: 'default',
    guildId: 'guild-1',
    guildName: 'Seattle Matrix',
    channelId: 'chan-1',
    channelName: 'Runner Voice'
  });
  assert.strictEqual(defaultCfg.id, 'default');
  assert.strictEqual(defaultCfg.language, 'de-DE');
  assert.ok(defaultCfg.updatedAt instanceof Date);

  // 1c. Verify normalizeAttributesToStructuredObjects preserves Helix metadata arrays/primitives
  // while converting prose fields (transcript, summary, next_steps) to { text, html } and stripping unstructured
  const rawTranscriptAttrs = {
    sessionId: 'sess-001',
    startedAt: '2026-11-08T18:00:00.000Z',
    endedAt: null,
    activePlayers: [{ foundryId: 'f-1', discordId: 'd-1', name: 'Razor' }],
    entries: [
      { kind: 'utterance', timestamp: '2026-11-08T18:01:00.000Z', discordId: 'd-1', foundryId: 'f-1', speaker: 'Razor', text: 'Ich hacke das Maglock.' },
      { kind: 'marker', timestamp: '2026-11-08T18:02:00.000Z', markerType: 'combat', text: 'Renraku Red Samurai', metadata: { round: 1 } }
    ],
    markers: [
      { timestamp: '2026-11-08T18:02:00.000Z', markerType: 'combat', label: 'Renraku Red Samurai', metadata: { round: 1 } }
    ],
    transcript: {
      text: '[18:01:00] Razor: Ich hacke das Maglock.\n[COMBAT] Renraku Red Samurai',
      html: '<div class="helix-transcript"><p><strong>Razor:</strong> Ich hacke das Maglock.</p></div>'
    },
    unstructured: '# Forbidden raw markdown dump'
  };

  const normAttrs = mongoDB.normalizeAttributesToStructuredObjects(rawTranscriptAttrs, 'transcript');
  assert.strictEqual(normAttrs.unstructured, undefined, 'unstructured must be stripped');
  assert.strictEqual(normAttrs.sessionId, 'sess-001');
  assert.strictEqual(normAttrs.startedAt, '2026-11-08T18:00:00.000Z');
  assert.ok(Array.isArray(normAttrs.activePlayers), 'activePlayers must remain an Array');
  assert.strictEqual(normAttrs.activePlayers[0].foundryId, 'f-1');
  assert.ok(Array.isArray(normAttrs.entries), 'entries must remain an Array');
  assert.strictEqual(normAttrs.entries.length, 2);
  assert.ok(Array.isArray(normAttrs.markers), 'markers must remain an Array');
  assert.strictEqual(normAttrs.markers.length, 1);
  assert.strictEqual(typeof normAttrs.transcript, 'object');
  assert.ok(normAttrs.transcript.text.includes('Ich hacke das Maglock.'));
  assert.ok(normAttrs.transcript.html.includes('helix-transcript'));

  // 1d. Verify Artifact & Note support title and subtypeTag and sync name <-> title
  await mongoDB.Artifact.deleteMany({ projectId: 'test-proj-103' });
  const createdArt = await mongoDB.Artifact.create({
    id: 'transcript-sess-001',
    projectId: 'test-proj-103',
    type: 'transcript',
    subtypeTag: 'transcript',
    title: 'Session Transcript (sess-001)',
    content: '',
    attributes: normAttrs
  });
  assert.strictEqual(createdArt.title, 'Session Transcript (sess-001)');
  assert.strictEqual(createdArt.name, 'Session Transcript (sess-001)');
  assert.strictEqual(createdArt.subtypeTag, 'transcript');
  assert.strictEqual(createdArt.content, '');

  // 1e. Verify constructMarkdownFromAttributes renders transcript Artifacts and summary Notes cleanly on-the-fly
  const transcriptMd = mongoDB.constructMarkdownFromAttributes(
    createdArt.title,
    'transcript',
    normAttrs
  );
  assert.ok(transcriptMd.includes('# Session Transcript (sess-001)'), 'Markdown must include title header');
  assert.ok(transcriptMd.includes('Ich hacke das Maglock.'), 'Markdown must include utterance text');
  assert.ok(transcriptMd.includes('Renraku Red Samurai'), 'Markdown must include marker text');

  const summaryAttrs = mongoDB.normalizeAttributesToStructuredObjects({
    sessionId: 'sess-001',
    summary: {
      text: '- Team infiltrated Renraku Arcology\n- Extracted paydata',
      html: '<ul><li>Team infiltrated Renraku Arcology</li><li>Extracted paydata</li></ul>'
    },
    next_steps: {
      text: '- Meet Mr. Johnson at Docking Bay 9',
      html: '<ul><li>Meet Mr. Johnson at Docking Bay 9</li></ul>'
    }
  }, 'summary');
  const summaryMd = mongoDB.constructMarkdownFromAttributes('Run Summary (sess-001)', 'summary', summaryAttrs);
  assert.ok(summaryMd.includes('# Run Summary (sess-001)'));
  assert.ok(summaryMd.includes('Team infiltrated Renraku Arcology'));
  assert.ok(summaryMd.includes('Meet Mr. Johnson at Docking Bay 9'));
  assert.strictEqual((summaryMd.match(/## Summary/g) || []).length, 1);
  assert.strictEqual((summaryMd.match(/## Next Steps/g) || []).length, 1);

  // Verify case-insensitive deduplication when both Summary/summary or Next Steps/next_steps exist
  const summaryDupMd = mongoDB.constructMarkdownFromAttributes('Run Summary (sess-001)', 'summary', {
    ...summaryAttrs,
    Summary: summaryAttrs.summary,
    'Next Steps': summaryAttrs.next_steps
  });
  assert.strictEqual((summaryDupMd.match(/## Summary/g) || []).length, 1, '## Summary must not render twice');
  assert.strictEqual((summaryDupMd.match(/## Next Steps/g) || []).length, 1, '## Next Steps must not render twice');

  // 1f. Verify shadowrun genre in genres.json
  const genresJson = require('./public/genres.json');
  const srGenre = genresJson.find(g => g.id === 'shadowrun');
  assert.ok(srGenre, 'shadowrun genre must exist in public/genres.json');
  const catIds = (srGenre.filterCategories || []).map(c => c.id);
  for (const expectedCat of ['summary', 'transcript', 'locations', 'organizations', 'secrets', 'lore']) {
    assert.ok(catIds.includes(expectedCat), `shadowrun genre must include filter category '${expectedCat}'`);
  }

  console.log('✓ Slice 1 passed!');

  // --- SLICE 2: Artifact CRUD, Summary Note CRUD, and Project Markdown Export via Express HTTP API ---
  console.log('Running Slice 2: Express HTTP API for Artifacts, Summary Notes & Markdown Export...');

  const { app, server } = require('./server');
  assert.ok(app, 'server.js must export app');
  assert.ok(server, 'server.js must export http server instance');

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
    const res = await fetch(`${baseUrl}${pathUrl}`, opts);
    const text = await res.text();
    let data = null;
    try { data = JSON.parse(text); } catch (e) { data = text; }
    return { status: res.status, data };
  }

  try {
    // 2a. Ensure test project exists
    await mongoDB.Project.findOneAndUpdate(
      { id: 'sr-campaign-103' },
      { id: 'sr-campaign-103', name: 'Seattle Shadows', genre: 'shadowrun' },
      { upsert: true }
    );
    await mongoDB.Artifact.deleteMany({ projectId: 'sr-campaign-103' });
    await mongoDB.Note.deleteMany({ projectId: 'sr-campaign-103' });

    // 2b. POST /api/artifacts creates a transcript artifact, enforcing content: "", stripping unstructured, preserving Helix metadata
    const postArtRes = await apiReq('POST', '/api/artifacts', {
      id: 'transcript-session-alpha',
      projectId: 'sr-campaign-103',
      type: 'transcript',
      subtypeTag: 'transcript',
      title: 'Session Transcript (session-alpha)',
      content: '# Raw markdown that must be stripped',
      attributes: {
        unstructured: 'Forbidden unstructured dump',
        sessionId: 'session-alpha',
        startedAt: '2026-11-08T19:00:00.000Z',
        endedAt: null,
        activePlayers: [{ foundryId: 'f-decker', discordId: 'd-decker', name: 'ZeroCool' }],
        entries: [
          {
            kind: 'utterance',
            timestamp: '2026-11-08T19:05:00.000Z',
            discordId: 'd-decker',
            foundryId: 'f-decker',
            speaker: 'ZeroCool',
            text: 'Wir sind im Gitter von Saeder-Krupp.'
          }
        ],
        markers: [],
        transcript: {
          text: '[19:05:00] ZeroCool: Wir sind im Gitter von Saeder-Krupp.',
          html: '<div class="helix-transcript"><p><strong>ZeroCool:</strong> Wir sind im Gitter von Saeder-Krupp.</p></div>'
        }
      }
    });
    assert.strictEqual(postArtRes.status, 200, `POST /api/artifacts failed: ${JSON.stringify(postArtRes.data)}`);

    // Verify GET /api/artifacts/:id
    const getArtRes = await apiReq('GET', '/api/artifacts/transcript-session-alpha?projectId=sr-campaign-103');
    assert.strictEqual(getArtRes.status, 200);
    assert.strictEqual(getArtRes.data.id, 'transcript-session-alpha');
    assert.strictEqual(getArtRes.data.type, 'transcript');
    assert.strictEqual(getArtRes.data.subtypeTag, 'transcript');
    assert.strictEqual(getArtRes.data.title, 'Session Transcript (session-alpha)');
    assert.strictEqual(getArtRes.data.content, '', 'Artifact content must be empty string');
    assert.strictEqual(getArtRes.data.attributes.unstructured, undefined, 'attributes.unstructured must not exist');
    assert.strictEqual(getArtRes.data.attributes.sessionId, 'session-alpha');
    assert.strictEqual(getArtRes.data.attributes.endedAt, null);
    assert.strictEqual(getArtRes.data.attributes.activePlayers.length, 1);
    assert.strictEqual(getArtRes.data.attributes.entries.length, 1);
    assert.strictEqual(getArtRes.data.attributes.transcript.text, '[19:05:00] ZeroCool: Wir sind im Gitter von Saeder-Krupp.');

    // Verify PUT /api/artifacts/:id updates markers, entries, endedAt while preserving Structured Object Storage
    const putArtRes = await apiReq('PUT', '/api/artifacts/transcript-session-alpha', {
      projectId: 'sr-campaign-103',
      content: 'Should still be sanitized to empty',
      attributes: {
        ...getArtRes.data.attributes,
        endedAt: '2026-11-08T21:00:00.000Z',
        markers: [
          { timestamp: '2026-11-08T19:10:00.000Z', markerType: 'scene', label: 'Brachialer IC-Alarm', metadata: { alert: 'red' } }
        ]
      }
    });
    assert.strictEqual(putArtRes.status, 200);
    assert.strictEqual(putArtRes.data.content, '');
    assert.strictEqual(putArtRes.data.attributes.endedAt, '2026-11-08T21:00:00.000Z');
    assert.strictEqual(putArtRes.data.attributes.markers.length, 1);

    // Verify GET /api/artifacts with filtering by projectId, type, subtypeTag
    const listArtRes = await apiReq('GET', '/api/artifacts?projectId=sr-campaign-103&type=transcript&subtypeTag=transcript');
    assert.strictEqual(listArtRes.status, 200);
    const artList = Array.isArray(listArtRes.data) ? listArtRes.data : listArtRes.data.artifacts;
    assert.ok(Array.isArray(artList), 'GET /api/artifacts must return artifacts array');
    assert.strictEqual(artList.length, 1);
    assert.strictEqual(artList[0].id, 'transcript-session-alpha');

    // 2c. Verify Summary Note creation via POST /api/notes obeys Structured Object Storage
    const postNoteRes = await apiReq('POST', '/api/notes', {
      id: 'summary-session-alpha',
      projectId: 'sr-campaign-103',
      type: 'summary',
      subtypeTag: 'summary',
      title: 'Run Summary (session-alpha)',
      content: 'Forbidden raw markdown note content',
      attributes: {
        unstructured: 'Forbidden unstructured note content',
        sessionId: 'session-alpha',
        summary: {
          text: '- ZeroCool hacked the Saeder-Krupp host\n- Triggered IC alarm',
          html: '<ul><li>ZeroCool hacked the Saeder-Krupp host</li><li>Triggered IC alarm</li></ul>'
        },
        next_steps: {
          text: '- Fence the stolen blueprints in Puyallup',
          html: '<ul><li>Fence the stolen blueprints in Puyallup</li></ul>'
        }
      }
    });
    assert.strictEqual(postNoteRes.status, 200);

    const getNoteRes = await apiReq('GET', '/api/notes/summary-session-alpha?projectId=sr-campaign-103');
    assert.strictEqual(getNoteRes.status, 200);
    assert.strictEqual(getNoteRes.data.id, 'summary-session-alpha');
    assert.strictEqual(getNoteRes.data.type, 'summary');
    assert.strictEqual(getNoteRes.data.subtypeTag, 'summary');
    assert.strictEqual(getNoteRes.data.title, 'Run Summary (session-alpha)');
    assert.strictEqual(getNoteRes.data.content, '');
    assert.strictEqual(getNoteRes.data.attributes.unstructured, undefined);
    assert.strictEqual(getNoteRes.data.attributes.sessionId, 'session-alpha');
    assert.ok(getNoteRes.data.attributes.summary.text.includes('Saeder-Krupp host'));
    assert.ok(getNoteRes.data.attributes.next_steps.text.includes('Puyallup'));

    // 2d. Verify GET /api/projects/:projectId/export-markdown renders transcript Artifact & summary Note on-the-fly
    const exportMdRes = await apiReq('GET', '/api/projects/sr-campaign-103/export-markdown');
    assert.strictEqual(exportMdRes.status, 200);
    const mdText = typeof exportMdRes.data === 'string' ? exportMdRes.data : exportMdRes.data.markdown;
    assert.ok(mdText && mdText.includes('Session Transcript (session-alpha)'), 'Exported markdown must include transcript artifact');
    assert.ok(mdText.includes('Wir sind im Gitter von Saeder-Krupp.'), 'Exported markdown must include utterance text');
    assert.ok(mdText.includes('Run Summary (session-alpha)'), 'Exported markdown must include summary note');
    assert.ok(mdText.includes('Fence the stolen blueprints in Puyallup'), 'Exported markdown must include next_steps');

    // 2e. Verify DELETE /api/artifacts/:id
    const delArtRes = await apiReq('DELETE', '/api/artifacts/transcript-session-alpha?projectId=sr-campaign-103');
    assert.strictEqual(delArtRes.status, 200);
    const afterDelRes = await apiReq('GET', '/api/artifacts/transcript-session-alpha?projectId=sr-campaign-103');
    assert.strictEqual(afterDelRes.status, 404);

    console.log('✓ Slice 2 passed!');

    // --- SLICE 3: Helix Internal REST Endpoints (/api/helix/status, /api/helix/guilds/:guildId/channels, /api/helix/config) ---
    console.log('Running Slice 3: Helix Internal REST Endpoints...');

    const { helixEngine } = require('./server');
    assert.ok(helixEngine, 'server.js must export helixEngine');

    // 3a. Verify x-api-key enforcement on /api/helix/*
    const unauthStatus = await apiReq('GET', '/api/helix/status', null, { 'x-api-key': 'wrong-key' });
    assert.strictEqual(unauthStatus.status, 401, 'GET /api/helix/status must reject invalid x-api-key');

    const unauthChannels = await apiReq('GET', '/api/helix/guilds/guild-1/channels', null, { 'x-api-key': '' });
    assert.strictEqual(unauthChannels.status, 401, 'GET /api/helix/guilds/:guildId/channels must reject missing x-api-key');

    const unauthConfig = await apiReq('POST', '/api/helix/config', { language: 'de-DE' }, { 'x-api-key': 'wrong-key' });
    assert.strictEqual(unauthConfig.status, 401, 'POST /api/helix/config must reject invalid x-api-key');

    // Inject mock Discord state via helixEngine test seam to verify guild/channel resolution & status reporting
    helixEngine.setMockDiscordState({
      online: true,
      botTag: 'Helix#2080',
      members: [
        { id: 'user-sr-01', name: 'Razor', tag: 'Razor#0001', isBot: false }
      ],
      guilds: [
        {
          id: 'guild-sr-seattle',
          name: 'Seattle Sprawl 2080',
          members: [
            { id: 'user-sr-01', name: 'Razor', tag: 'Razor#0001', isBot: false },
            { id: 'user-sr-02', name: 'Decker', tag: 'Decker#0002', isBot: false },
            { id: 'bot-sr-03', name: 'Helix', tag: 'Helix#5072', isBot: true, bot: true }
          ],
          channels: [
            { id: 'ch-text-1', name: 'general-chat', type: 0 }, // GuildText (0) - should be filtered out
            { id: 'ch-voice-1', name: 'Matrix Comms', type: 2 }, // GuildVoice (2) - should be included
            { id: 'ch-stage-1', name: 'Johnson Briefing', type: 13 }, // GuildStageVoice (13) - should be included
            { id: 'ch-cat-1', name: 'Categories', type: 4 } // GuildCategory (4) - should be filtered out
          ]
        }
      ]
    });

    // 3b. Verify GET /api/helix/guilds/:guildId/channels filters to GuildVoice (2) and GuildStageVoice (13)
    const channelsRes = await apiReq('GET', '/api/helix/guilds/guild-sr-seattle/channels');
    assert.strictEqual(channelsRes.status, 200);
    assert.ok(Array.isArray(channelsRes.data), 'GET /api/helix/guilds/:guildId/channels must return an array');
    assert.strictEqual(channelsRes.data.length, 2, 'Only GuildVoice and GuildStageVoice channels should be returned');
    assert.strictEqual(channelsRes.data[0].id, 'ch-voice-1');
    assert.strictEqual(channelsRes.data[0].name, 'Matrix Comms');
    assert.strictEqual(channelsRes.data[0].type, 2);
    assert.strictEqual(channelsRes.data[1].id, 'ch-stage-1');
    assert.strictEqual(channelsRes.data[1].name, 'Johnson Briefing');
    assert.strictEqual(channelsRes.data[1].type, 13);

    // 3c. Verify POST /api/helix/config validates language ("de-DE" or "en-US") and resolves guildName & channelName
    const badLangRes = await apiReq('POST', '/api/helix/config', {
      guildId: 'guild-sr-seattle',
      channelId: 'ch-voice-1',
      language: 'fr-FR'
    });
    assert.strictEqual(badLangRes.status, 400, 'POST /api/helix/config must reject unsupported language');

    const saveCfgRes = await apiReq('POST', '/api/helix/config', {
      guildId: 'guild-sr-seattle',
      channelId: 'ch-voice-1',
      language: 'de-DE'
    });
    assert.strictEqual(saveCfgRes.status, 200);
    const savedConfig = saveCfgRes.data.config || saveCfgRes.data;
    assert.strictEqual(savedConfig.id, 'default');
    assert.strictEqual(savedConfig.guildId, 'guild-sr-seattle');
    assert.strictEqual(savedConfig.guildName, 'Seattle Sprawl 2080');
    assert.strictEqual(savedConfig.channelId, 'ch-voice-1');
    assert.strictEqual(savedConfig.channelName, 'Matrix Comms');
    assert.strictEqual(savedConfig.language, 'de-DE');

    // Also test en-US
    const saveCfgEnRes = await apiReq('POST', '/api/helix/config', {
      guildId: 'guild-sr-seattle',
      channelId: 'ch-stage-1',
      language: 'en-US'
    });
    assert.strictEqual(saveCfgEnRes.status, 200);
    assert.strictEqual((saveCfgEnRes.data.config || saveCfgEnRes.data).language, 'en-US');
    assert.strictEqual((saveCfgEnRes.data.config || saveCfgEnRes.data).channelName, 'Johnson Briefing');

    // Restore de-DE on ch-voice-1 for subsequent tests
    await apiReq('POST', '/api/helix/config', {
      guildId: 'guild-sr-seattle',
      channelId: 'ch-voice-1',
      language: 'de-DE'
    });

    // 3d. Verify GET /api/helix/status returns online, botTag, guilds, botStatus, config, activeSession
    const statusRes = await apiReq('GET', '/api/helix/status');
    assert.strictEqual(statusRes.status, 200);
    assert.strictEqual(statusRes.data.online, true);
    assert.strictEqual(statusRes.data.botTag, 'Helix#2080');
    assert.strictEqual(statusRes.data.connectedGuildId, 'guild-sr-seattle');
    assert.strictEqual(statusRes.data.connectedChannelId, 'ch-voice-1');
    assert.deepStrictEqual(statusRes.data.installedGuildIds, ['guild-sr-seattle']);
    assert.deepStrictEqual(statusRes.data.botStatus, {
      online: true,
      connectedGuildId: 'guild-sr-seattle',
      connectedChannelId: 'ch-voice-1',
      installedGuildIds: ['guild-sr-seattle']
    });
    assert.ok(Array.isArray(statusRes.data.guilds));
    assert.strictEqual(statusRes.data.guilds[0].id, 'guild-sr-seattle');
    assert.strictEqual(statusRes.data.guilds[0].name, 'Seattle Sprawl 2080');
    assert.ok(Array.isArray(statusRes.data.members), 'GET /api/helix/status must return members array');
    assert.strictEqual(statusRes.data.members.length, 2, 'GET /api/helix/status must filter out bot members and return guild members');
    assert.strictEqual(statusRes.data.members[0].id, 'user-sr-01');
    assert.strictEqual(statusRes.data.members[0].name, 'Razor');
    assert.strictEqual(statusRes.data.members[0].tag, 'Razor#0001');
    assert.strictEqual(statusRes.data.members[0].isBot, false);
    assert.strictEqual(statusRes.data.members[1].id, 'user-sr-02');
    assert.strictEqual(statusRes.data.members[1].name, 'Decker');
    assert.strictEqual(statusRes.data.members[1].tag, 'Decker#0002');
    assert.strictEqual(statusRes.data.members[1].isBot, false);
    assert.strictEqual(statusRes.data.config.id, 'default');
    assert.strictEqual(statusRes.data.config.guildId, 'guild-sr-seattle');
    assert.strictEqual(statusRes.data.config.guildName, 'Seattle Sprawl 2080');
    assert.strictEqual(statusRes.data.config.channelId, 'ch-voice-1');
    assert.strictEqual(statusRes.data.config.channelName, 'Matrix Comms');
    assert.strictEqual(statusRes.data.config.language, 'de-DE');
    assert.strictEqual(statusRes.data.activeSession, null);

    // 3e. Verify POST /api/helix/session/start, POST /api/helix/session/end, and GET /api/helix/summary/:jobId
    const unauthStart = await apiReq('POST', '/api/helix/session/start', { sessionId: 's-unauth' }, { 'x-api-key': 'bad-key' });
    assert.strictEqual(unauthStart.status, 401, 'POST /api/helix/session/start must reject invalid x-api-key');

    const unauthEnd = await apiReq('POST', '/api/helix/session/end', { sessionId: 's-unauth' }, { 'x-api-key': 'bad-key' });
    assert.strictEqual(unauthEnd.status, 401, 'POST /api/helix/session/end must reject invalid x-api-key');

    const unauthSummary = await apiReq('GET', '/api/helix/summary/job-test', null, { 'x-api-key': 'bad-key' });
    assert.strictEqual(unauthSummary.status, 401, 'GET /api/helix/summary/:jobId must reject invalid x-api-key');

    const missingIdStart = await apiReq('POST', '/api/helix/session/start', {});
    assert.strictEqual(missingIdStart.status, 400, 'POST /api/helix/session/start must reject missing sessionId');

    const missingIdEnd = await apiReq('POST', '/api/helix/session/end', {});
    assert.strictEqual(missingIdEnd.status, 400, 'POST /api/helix/session/end must reject missing sessionId when no active session');

    // Start session via REST
    const restSessionId = 'rest-sess-118';
    const restProjectId = 'sr-project-118';
    const startRes = await apiReq('POST', '/api/helix/session/start', {
      sessionId: restSessionId,
      projectId: restProjectId,
      activePlayers: [
        { foundryId: 'f-118', name: 'Ghost', discordId: 'd-118' }
      ]
    });
    assert.strictEqual(startRes.status, 200);
    assert.strictEqual(startRes.data.success, true);
    assert.strictEqual(startRes.data.sessionId, restSessionId);
    assert.strictEqual(startRes.data.status, 'active');
    assert.ok(startRes.data.startedAt, 'startedAt timestamp must be returned');

    // Status check reflects active session
    const statusWithActive = await apiReq('GET', '/api/helix/status');
    assert.strictEqual(statusWithActive.status, 200);
    assert.ok(statusWithActive.data.activeSession, 'activeSession must be set in status');
    assert.strictEqual(statusWithActive.data.activeSession.sessionId, restSessionId);

    // Summary endpoint returns 'processing' for pending session
    const summaryPending = await apiReq('GET', `/api/helix/summary/${restSessionId}`);
    assert.strictEqual(summaryPending.status, 200);
    assert.strictEqual(summaryPending.data.status, 'processing');
    assert.strictEqual(summaryPending.data.jobId, restSessionId);

    // End session via REST
    const endRes = await apiReq('POST', '/api/helix/session/end', {
      sessionId: restSessionId,
      projectId: restProjectId
    });
    assert.strictEqual(endRes.status, 200);
    assert.strictEqual(endRes.data.success, true);
    assert.strictEqual(endRes.data.sessionId, restSessionId);
    assert.strictEqual(endRes.data.status, 'ended');
    assert.ok(endRes.data.endedAt, 'endedAt timestamp must be returned');

    // Status check confirms activeSession is cleared
    const statusAfterEnd = await apiReq('GET', '/api/helix/status');
    assert.strictEqual(statusAfterEnd.data.activeSession, null);

    // Summary endpoint returns 'completed' once summary Note exists
    const summaryCompleted = await apiReq('GET', `/api/helix/summary/${restSessionId}`);
    assert.strictEqual(summaryCompleted.status, 200);
    assert.strictEqual(summaryCompleted.data.status, 'completed');
    assert.strictEqual(summaryCompleted.data.sessionId, restSessionId);

    // Summary endpoint with 'summary-' prefix works identically
    const summaryWithPrefix = await apiReq('GET', `/api/helix/summary/summary-${restSessionId}`);
    assert.strictEqual(summaryWithPrefix.status, 200);
    assert.strictEqual(summaryWithPrefix.data.status, 'completed');

    console.log('✓ Slice 3 passed!');

    // --- SLICE 4: WebSocket (/helix/ws) Authentication & Full Session Lifecycle ---
    console.log('Running Slice 4: WebSocket (/helix/ws) Auth, Voice/STT Pipeline, Markers & Summarization...');

    const WebSocket = require('ws');
    const http = require('http');
    const { EventEmitter } = require('events');
    const { PassThrough } = require('stream');

    // 4a. Start a local mock Flask server for key verification and /admin/api/internal/helix/summarize
    let receivedSummarizeRequest = null;
    let receivedSummarizeHeaders = null;
    const mockFlaskServer = http.createServer((req, res) => {
      let body = '';
      req.on('data', chunk => { body += chunk; });
      req.on('end', () => {
        if (req.url === '/api/shadowrun/helix/verify-key' && req.method === 'POST') {
          const parsed = JSON.parse(body || '{}');
          if (parsed.apiKey === 'valid-foundry-client-key') {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            return res.end(JSON.stringify({ valid: true }));
          }
          res.writeHead(401, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ valid: false }));
        }
        if (req.url === '/admin/api/internal/helix/summarize' && req.method === 'POST') {
          receivedSummarizeHeaders = req.headers;
          receivedSummarizeRequest = JSON.parse(body || '{}');
          res.writeHead(200, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({
            summary: [
              'Das Team schlich durch den Lüftungsschacht in die Konzernanlage.',
              'Ein HTR-Team griff in Kampfrunde 1 an und wurde mit einer Blendgranate geblendet.'
            ],
            next_steps: [
              'Host-Paydata entschlüsseln.',
              'Treffen mit Mr. Johnson im Safe House vereinbaren.'
            ]
          }));
        }
        res.writeHead(404);
        res.end();
      });
    });

    await new Promise(resolve => mockFlaskServer.listen(0, '127.0.0.1', resolve));
    const flaskPort = mockFlaskServer.address().port;
    process.env.FLASK_INTERNAL_URL = `http://127.0.0.1:${flaskPort}`;

    try {
      // 4b. Verify WebSocket connection rejection with missing or invalid API key
      const rejectMissingKey = await new Promise((resolve) => {
        const ws = new WebSocket(`ws://127.0.0.1:${port}/helix/ws`);
        ws.on('close', (code) => resolve({ closed: true, code }));
        ws.on('error', () => resolve({ closed: true, code: 4001 }));
      });
      assert.strictEqual(rejectMissingKey.closed, true, 'Missing apiKey WS connection must be closed');
      assert.ok([1008, 4001, 1006].includes(rejectMissingKey.code), `Unexpected close code: ${rejectMissingKey.code}`);

      const rejectBadKey = await new Promise((resolve) => {
        const ws = new WebSocket(`ws://127.0.0.1:${port}/helix/ws?apiKey=invalid-key-999`);
        ws.on('close', (code) => resolve({ closed: true, code }));
        ws.on('error', () => resolve({ closed: true, code: 4001 }));
      });
      assert.strictEqual(rejectBadKey.closed, true, 'Invalid apiKey WS connection must be closed');

      // 4c. Inject mock Discord voice receiver & GCP Speech-to-Text stream into helixEngine
      const speakingEmitter = new EventEmitter();
      const activeUserOpusStreams = new Map();
      const activeUserSttStreams = new Map();
      let voiceDisconnected = false;
      let sttRecognizeConfigCaptured = null;

      helixEngine.setVoiceDependencies({
        joinVoiceChannel: () => ({
          receiver: {
            speaking: speakingEmitter,
            subscribe: (discordId) => {
              const opusStream = new PassThrough();
              activeUserOpusStreams.set(discordId, opusStream);
              return opusStream;
            }
          },
          destroy: () => {
            voiceDisconnected = true;
          }
        }),
        createOpusDecoder: () => new PassThrough(),
        createSttStream: (recognizeConfig, discordId) => {
          sttRecognizeConfigCaptured = recognizeConfig;
          const sttStream = new PassThrough({ objectMode: true });
          activeUserSttStreams.set(discordId, sttStream);
          return sttStream;
        }
      });

      // 4d. Connect authorized WebSocket client using valid key
      const wsMessages = [];
      const wsClient = new WebSocket(`ws://127.0.0.1:${port}/helix/ws?apiKey=${encodeURIComponent(apiKey)}`);
      await new Promise((resolve, reject) => {
        wsClient.once('open', resolve);
        wsClient.once('error', reject);
      });

      wsClient.on('message', (raw) => {
        try {
          wsMessages.push(JSON.parse(raw.toString()));
        } catch (e) {
          wsMessages.push(raw.toString());
        }
      });

      const sessionId = 'run-session-2080';
      const projectId = 'sr-project-2080';
      await mongoDB.Project.deleteMany({ id: projectId });
      await mongoDB.Artifact.deleteMany({ id: `transcript-${sessionId}` });
      await mongoDB.Note.deleteMany({ id: `summary-${sessionId}` });

      // 4e. Send session_start
      wsClient.send(JSON.stringify({
        action: 'session_start',
        sessionId,
        projectId,
        dossier: 'Mr. Johnson (Aztechnology), Zielort: Renraku Arkologie Sektor 7.',
        activePlayers: [
          { foundryId: 'foundry-actor-1', discordId: 'discord-player-1', name: 'Kitsune' },
          { foundryId: 'foundry-actor-2', discordId: 'discord-player-2', name: 'Sledge' }
        ]
      }));

      // Wait until transcript Artifact and Project are created in MongoDB
      let transcriptDoc = null;
      for (let i = 0; i < 30; i++) {
        transcriptDoc = await mongoDB.Artifact.findOne({ id: `transcript-${sessionId}` }).lean();
        if (transcriptDoc) break;
        await new Promise(r => setTimeout(r, 50));
      }
      assert.ok(transcriptDoc, 'session_start must create transcript Artifact in MongoDB');
      assert.strictEqual(transcriptDoc.projectId, projectId);
      assert.strictEqual(transcriptDoc.type, 'transcript');
      assert.strictEqual(transcriptDoc.subtypeTag, 'transcript');
      assert.strictEqual(transcriptDoc.title, `Session Transcript (${sessionId})`);
      assert.strictEqual(transcriptDoc.content, '');

      const upsertedProj = await mongoDB.Project.findOne({ id: projectId }).lean();
      assert.ok(upsertedProj, 'session_start must upsert target Project');
      assert.strictEqual(upsertedProj.genre, 'shadowrun');

      // Check GET /api/helix/status reflects activeSession
      const activeStatusRes = await apiReq('GET', '/api/helix/status');
      assert.ok(activeStatusRes.data.activeSession, 'activeSession must be populated during live session');
      assert.strictEqual(activeStatusRes.data.activeSession.sessionId, sessionId);
      assert.strictEqual(activeStatusRes.data.activeSession.projectId, projectId);

      // 4f. Simulate Speaker 1 speaking start -> STT result -> speaking stop
      speakingEmitter.emit('start', 'discord-player-1');
      await new Promise(r => setTimeout(r, 50));

      const startEvt1 = wsMessages.find(m => m.action === 'speaking_start' && m.discordId === 'discord-player-1');
      assert.ok(startEvt1, 'WebSocket must immediately emit speaking_start when user begins speaking');
      assert.strictEqual(startEvt1.sessionId, sessionId);
      assert.strictEqual(startEvt1.foundryId, 'foundry-actor-1');

      // Verify STT config uses configured language ('de-DE'), 48000 Hz, LINEAR16, enableAutomaticPunctuation
      assert.ok(sttRecognizeConfigCaptured, 'STT stream must be created on speaking start');
      const sttCfg = sttRecognizeConfigCaptured.config || sttRecognizeConfigCaptured;
      assert.strictEqual(sttCfg.languageCode, 'de-DE');
      assert.strictEqual(sttCfg.sampleRateHertz, 48000);
      assert.strictEqual(sttCfg.encoding, 'LINEAR16');
      assert.strictEqual(sttCfg.enableAutomaticPunctuation, true);

      // Emit final STT transcript for Speaker 1
      const sttStream1 = activeUserSttStreams.get('discord-player-1');
      assert.ok(sttStream1, 'Active STT stream for discord-player-1 must exist');
      sttStream1.emit('data', {
        results: [
          {
            isFinal: true,
            alternatives: [{ transcript: 'Wir schleichen durch den Lüftungsschacht.' }]
          }
        ]
      });

      speakingEmitter.emit('end', 'discord-player-1');
      await new Promise(r => setTimeout(r, 80));

      const stopEvt1 = wsMessages.find(m => m.action === 'speaking_stop' && m.discordId === 'discord-player-1');
      assert.ok(stopEvt1, 'WebSocket must immediately emit speaking_stop when user stops speaking');
      assert.strictEqual(stopEvt1.sessionId, sessionId);
      assert.strictEqual(stopEvt1.foundryId, 'foundry-actor-1');

      // Verify NO live transcript message was broadcast over WebSocket during gameplay
      const liveTranscriptBroadcasts = wsMessages.filter(
        m => m.action !== 'speaking_start' && m.action !== 'speaking_stop' && m.action !== 'session_started'
      );
      assert.strictEqual(liveTranscriptBroadcasts.length, 0, 'Live transcript text must NOT be broadcast over WebSocket during session');

      // 4g. Send session_marker to interleave a combat marker
      wsClient.send(JSON.stringify({
        action: 'session_marker',
        sessionId,
        markerType: 'combat',
        label: 'Initiative Round 1: HTR Team',
        metadata: { round: 1, threatLevel: 'high' }
      }));
      await new Promise(r => setTimeout(r, 80));

      // 4h. Simulate Speaker 2 speaking start -> STT result -> speaking stop
      speakingEmitter.emit('start', 'discord-player-2');
      await new Promise(r => setTimeout(r, 50));
      const sttStream2 = activeUserSttStreams.get('discord-player-2');
      sttStream2.emit('data', {
        results: [
          {
            isFinal: true,
            alternatives: [{ transcript: 'Ich werfe eine Blendgranate!' }]
          }
        ]
      });
      speakingEmitter.emit('end', 'discord-player-2');
      await new Promise(r => setTimeout(r, 80));

      // Verify chronological interleaving in transcript Artifact before session_end
      const midArtRes = await apiReq('GET', `/api/artifacts/transcript-${sessionId}?projectId=${projectId}`);
      assert.strictEqual(midArtRes.status, 200);
      const midEntries = midArtRes.data.attributes.entries;
      assert.strictEqual(midEntries.length, 3, 'Should have 2 utterances and 1 interleaved marker');
      assert.strictEqual(midEntries[0].kind, 'utterance');
      assert.strictEqual(midEntries[0].foundryId, 'foundry-actor-1');
      assert.strictEqual(midEntries[0].text, 'Wir schleichen durch den Lüftungsschacht.');
      assert.strictEqual(midEntries[1].kind, 'marker');
      assert.strictEqual(midEntries[1].markerType, 'combat');
      assert.strictEqual(midEntries[1].text, 'Initiative Round 1: HTR Team');
      assert.strictEqual(midEntries[2].kind, 'utterance');
      assert.strictEqual(midEntries[2].foundryId, 'foundry-actor-2');
      assert.strictEqual(midEntries[2].text, 'Ich werfe eine Blendgranate!');
      assert.strictEqual(midArtRes.data.attributes.markers.length, 1);
      assert.strictEqual(midArtRes.data.attributes.markers[0].label, 'Initiative Round 1: HTR Team');

      // 4i. Send session_end and wait for session_summary WebSocket event
      wsClient.send(JSON.stringify({
        action: 'session_end',
        sessionId
      }));

      let summaryWsEvt = null;
      for (let i = 0; i < 40; i++) {
        summaryWsEvt = wsMessages.find(m => m.action === 'session_summary');
        if (summaryWsEvt) break;
        await new Promise(r => setTimeout(r, 50));
      }
      assert.ok(summaryWsEvt, 'WebSocket must emit session_summary upon session_end');
      assert.strictEqual(summaryWsEvt.sessionId, sessionId);
      assert.ok(Array.isArray(summaryWsEvt.summary));
      assert.strictEqual(summaryWsEvt.summary.length, 2);
      assert.ok(summaryWsEvt.summary[0].includes('Lüftungsschacht'));
      assert.ok(Array.isArray(summaryWsEvt.next_steps));
      assert.strictEqual(summaryWsEvt.next_steps.length, 2);
      assert.ok(summaryWsEvt.next_steps[0].includes('Host-Paydata'));

      // Verify voice connection was disconnected
      assert.strictEqual(voiceDisconnected, true, 'Discord voice connection must be destroyed on session_end');

      // Verify Flask summarizer received dossier and chronological transcript with x-api-key
      assert.ok(receivedSummarizeRequest, 'Flask summarizer endpoint must be called on session_end');
      assert.strictEqual(receivedSummarizeHeaders['x-api-key'], apiKey);
      assert.ok(receivedSummarizeRequest.dossier.includes('Renraku Arkologie Sektor 7'));
      assert.ok(receivedSummarizeRequest.transcript.includes('Wir schleichen durch den Lüftungsschacht.'));
      assert.ok(receivedSummarizeRequest.transcript.includes('Initiative Round 1: HTR Team'));
      assert.ok(receivedSummarizeRequest.transcript.includes('Ich werfe eine Blendgranate!'));

      // Verify finalized transcript Artifact in MongoDB
      const finalArtRes = await apiReq('GET', `/api/artifacts/transcript-${sessionId}?projectId=${projectId}`);
      assert.strictEqual(finalArtRes.status, 200);
      assert.strictEqual(finalArtRes.data.content, '');
      assert.strictEqual(finalArtRes.data.attributes.unstructured, undefined);
      assert.ok(finalArtRes.data.attributes.endedAt, 'endedAt must be set on session_end');
      assert.ok(finalArtRes.data.attributes.transcript.html.includes('helix-transcript'));

      // Verify persisted summary Note in MongoDB
      const summaryNoteRes = await apiReq('GET', `/api/notes/summary-${sessionId}?projectId=${projectId}`);
      assert.strictEqual(summaryNoteRes.status, 200);
      assert.strictEqual(summaryNoteRes.data.id, `summary-${sessionId}`);
      assert.strictEqual(summaryNoteRes.data.type, 'summary');
      assert.strictEqual(summaryNoteRes.data.subtypeTag, 'summary');
      assert.strictEqual(summaryNoteRes.data.title, `Run Summary (${sessionId})`);
      assert.strictEqual(summaryNoteRes.data.content, '');
      assert.strictEqual(summaryNoteRes.data.attributes.unstructured, undefined);
      assert.strictEqual(summaryNoteRes.data.attributes.sessionId, sessionId);
      assert.ok(summaryNoteRes.data.attributes.summary.text.includes('Lüftungsschacht'));
      assert.ok(summaryNoteRes.data.attributes.summary.html.includes('<ul>'));
      assert.ok(summaryNoteRes.data.attributes.next_steps.text.includes('Host-Paydata'));
      assert.ok(summaryNoteRes.data.attributes.next_steps.html.includes('<ul>'));

      wsClient.close();

      // 4j. Also verify WebSocket connection acceptance via X-API-Key header verified against Flask /api/shadowrun/helix/verify-key
      const wsHeaderClient = new WebSocket(`ws://127.0.0.1:${port}/helix/ws`, {
        headers: { 'X-API-Key': 'valid-foundry-client-key' }
      });
      await new Promise((resolve, reject) => {
        wsHeaderClient.once('open', resolve);
        wsHeaderClient.once('error', reject);
      });
      await new Promise(r => setTimeout(r, 80));
      assert.strictEqual(wsHeaderClient.readyState, WebSocket.OPEN, 'WS client with valid X-API-Key verified by Flask must stay OPEN');
      wsHeaderClient.close();

      console.log('✓ Slice 4 passed!');
    } finally {
      await new Promise(resolve => mockFlaskServer.close(resolve));
    }
  } finally {
    // Clean up test records
    await mongoDB.Artifact.deleteMany({ projectId: { $in: ['test-proj-103', 'sr-campaign-103', 'sr-project-2080', 'sr-project-118'] } });
    await mongoDB.Note.deleteMany({ projectId: { $in: ['test-proj-103', 'sr-campaign-103', 'sr-project-2080', 'sr-project-118'] } });
    await mongoDB.Project.deleteMany({ id: { $in: ['test-proj-103', 'sr-campaign-103', 'sr-project-2080', 'sr-project-118'] } });
    await mongoDB.Artifact.deleteMany({ id: { $in: ['transcript-rest-sess-118'] } });
    await mongoDB.Note.deleteMany({ id: { $in: ['summary-rest-sess-118'] } });
    await new Promise((resolve) => server.close(resolve));
  }

  await mongoose.disconnect();
}

runTests().catch(async (err) => {
  console.error('Test failed:', err);
  await mongoose.disconnect().catch(() => {});
  process.exit(1);
});
