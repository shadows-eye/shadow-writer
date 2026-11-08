const express = require('express');
const { WebSocketServer, WebSocket } = require('ws');
const { Client, GatewayIntentBits, ChannelType, ActivityType } = require('discord.js');
const { joinVoiceChannel: discordJoinVoiceChannel, EndBehaviorType } = require('@discordjs/voice');
const prism = require('prism-media');
const speech = require('@google-cloud/speech');
const {
  Project,
  Artifact,
  Note,
  HelixConfig
} = require('./mongoDB');

const VALID_LANGUAGES = new Set(['de-DE', 'en-US']);
const VOICE_CHANNEL_TYPES = new Set([
  ChannelType.GuildVoice, // 2
  ChannelType.GuildStageVoice, // 13
  'GuildVoice',
  'GuildStageVoice',
  2,
  13
]);

function escapeHtml(str) {
  return String(str || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function renderTranscriptFromEntries(entries = []) {
  const textLines = [];
  const htmlParts = [];

  for (const entry of entries) {
    if (!entry) continue;
    const ts = entry.timestamp || '';
    if (entry.kind === 'marker' || entry.markerType) {
      const mType = String(entry.markerType || 'note');
      const label = String(entry.text || entry.label || '');
      textLines.push(`[${ts}] [${mType.toUpperCase()}] ${label}`);
      htmlParts.push(
        `<div class="helix-marker" data-marker-type="${escapeHtml(mType)}"><em>[${escapeHtml(mType)}] ${escapeHtml(label)}</em></div>`
      );
    } else {
      const speaker = String(entry.speaker || entry.foundryId || entry.discordId || 'Speaker');
      const text = String(entry.text || '');
      textLines.push(`[${ts}] ${speaker}: ${text}`);
      htmlParts.push(
        `<p class="helix-utterance" data-discord-id="${escapeHtml(entry.discordId || '')}" data-foundry-id="${escapeHtml(entry.foundryId || '')}"><strong>${escapeHtml(speaker)}:</strong> ${escapeHtml(text)}</p>`
      );
    }
  }

  return {
    text: textLines.join('\n'),
    html: `<div class="helix-transcript">${htmlParts.join('')}</div>`
  };
}

function arrayToStructuredList(items) {
  if (items && typeof items === 'object' && !Array.isArray(items) && (items.text !== undefined || items.html !== undefined)) {
    const t = String(items.text || '');
    const h = String(items.html || `<p>${escapeHtml(t)}</p>`);
    return { text: t, html: h, list: t.split('\n').map(l => l.replace(/^[\-\*]\s*/, '').trim()).filter(Boolean) };
  }
  const arr = Array.isArray(items)
    ? items.map(x => String(x || '').trim()).filter(Boolean)
    : (typeof items === 'string' && items.trim() ? [items.trim()] : []);
  const text = arr.map(line => (line.startsWith('- ') ? line : `- ${line}`)).join('\n');
  const html = `<ul>${arr.map(line => `<li>${escapeHtml(line.replace(/^[\-\*]\s*/, ''))}</li>`).join('')}</ul>`;
  return { text, html, list: arr };
}

function setupHelixEngine(app, server) {
  const router = express.Router();

  let discordClient = null;
  let discordReady = false;
  let mockDiscordState = null;
  let activeSession = null;
  let speechClient = null;

  let voiceDeps = {
    joinVoiceChannel: null,
    createOpusDecoder: null,
    createSttStream: null
  };

  function getSpeechClient() {
    if (!speechClient) {
      speechClient = new speech.SpeechClient();
    }
    return speechClient;
  }

  function updateBotPresence(mode = 'idle') {
    if (!discordClient || !discordReady || !discordClient.user || typeof discordClient.user.setPresence !== 'function') {
      return;
    }
    try {
      if (mode === 'recording') {
        discordClient.user.setPresence({
          status: 'online',
          activities: [
            {
              name: 'Shadowrun Live Session | shadowplays.de',
              state: '🎙️ Recording Run • https://shadowplays.de',
              type: ActivityType.Listening,
              url: 'https://shadowplays.de'
            }
          ]
        });
      } else {
        discordClient.user.setPresence({
          status: 'online',
          activities: [
            {
              name: 'shadowplays.de | Shadowrun Co-GM',
              state: '🌐 https://shadowplays.de',
              type: ActivityType.Playing,
              url: 'https://shadowplays.de'
            }
          ]
        });
      }
    } catch (err) {
      console.warn('[Helix] Failed to update Discord bot presence:', err.message);
    }
  }

  // Initialize Discord client if DISCORD_BOT_TOKEN is provided
  if (process.env.DISCORD_BOT_TOKEN && process.env.DISCORD_BOT_TOKEN.trim()) {
    try {
      discordClient = new Client({
        intents: [
          GatewayIntentBits.Guilds,
          GatewayIntentBits.GuildVoiceStates
        ]
      });
      discordClient.once('ready', () => {
        discordReady = true;
        console.log(`[Helix] Discord bot logged in as ${discordClient.user ? discordClient.user.tag : 'unknown'}`);
        updateBotPresence('idle');
      });
      discordClient.on('error', (err) => {
        console.error('[Helix] Discord client error:', err.message);
      });
      discordClient.login(process.env.DISCORD_BOT_TOKEN.trim()).catch((err) => {
        console.warn('[Helix] Discord bot login failed:', err.message);
      });
    } catch (err) {
      console.warn('[Helix] Failed to initialize Discord client:', err.message);
    }
  }

  function isBotOnline() {
    if (mockDiscordState !== null) {
      return Boolean(mockDiscordState.online);
    }
    return Boolean(discordClient && discordReady && discordClient.user);
  }

  function getBotTag() {
    if (mockDiscordState !== null) {
      return mockDiscordState.botTag || null;
    }
    return discordClient && discordReady && discordClient.user ? discordClient.user.tag : null;
  }

  function getGuildsList() {
    if (mockDiscordState !== null && Array.isArray(mockDiscordState.guilds)) {
      return mockDiscordState.guilds.map(g => ({ id: String(g.id), name: String(g.name) }));
    }
    if (discordClient && discordReady && discordClient.guilds && discordClient.guilds.cache) {
      return Array.from(discordClient.guilds.cache.values()).map(g => ({
        id: String(g.id),
        name: String(g.name)
      }));
    }
    return [];
  }

  function normalizeVoiceChannelType(rawType) {
    if (rawType === 13 || rawType === ChannelType.GuildStageVoice || rawType === 'GuildStageVoice') {
      return 13;
    }
    return 2;
  }

  function getVoiceChannelsForGuild(guildId) {
    if (mockDiscordState !== null && Array.isArray(mockDiscordState.guilds)) {
      const guild = mockDiscordState.guilds.find(g => String(g.id) === String(guildId));
      if (!guild || !Array.isArray(guild.channels)) return [];
      return guild.channels
        .filter(ch => ch && VOICE_CHANNEL_TYPES.has(ch.type))
        .map(ch => ({
          id: String(ch.id),
          name: String(ch.name),
          type: normalizeVoiceChannelType(ch.type)
        }));
    }
    if (discordClient && discordReady && discordClient.guilds && discordClient.guilds.cache) {
      const guild = discordClient.guilds.cache.get(String(guildId));
      if (!guild || !guild.channels || !guild.channels.cache) return [];
      return Array.from(guild.channels.cache.values())
        .filter(ch => ch && VOICE_CHANNEL_TYPES.has(ch.type))
        .map(ch => ({
          id: String(ch.id),
          name: String(ch.name),
          type: normalizeVoiceChannelType(ch.type)
        }));
    }
    return [];
  }

  async function getOrCreateHelixConfig() {
    let cfg = await HelixConfig.findOne({ id: 'default' }).lean();
    if (!cfg) {
      const created = await HelixConfig.findOneAndUpdate(
        { id: 'default' },
        {
          $setOnInsert: {
            id: 'default',
            guildId: '',
            guildName: '',
            channelId: '',
            channelName: '',
            language: 'de-DE',
            updatedAt: new Date()
          }
        },
        { upsert: true, new: true, lean: true }
      );
      cfg = created;
    }
    return {
      id: 'default',
      guildId: cfg.guildId || '',
      guildName: cfg.guildName || '',
      channelId: cfg.channelId || '',
      channelName: cfg.channelName || '',
      language: cfg.language || 'de-DE',
      updatedAt: cfg.updatedAt ? new Date(cfg.updatedAt).toISOString() : new Date().toISOString()
    };
  }

  // --- REST ENDPOINTS ---
  router.get('/api/helix/status', async (req, res) => {
    try {
      const config = await getOrCreateHelixConfig();
      const online = isBotOnline();
      const botTag = getBotTag();
      const guilds = getGuildsList();
      const installedGuildIds = guilds.map(g => String(g.id));
      const connectedGuildId = (activeSession && activeSession.guildId) || config.guildId || null;
      const connectedChannelId = (activeSession && activeSession.channelId) || config.channelId || null;
      const botStatus = {
        online,
        connectedGuildId,
        connectedChannelId,
        installedGuildIds
      };
      const activeSessionSummary = activeSession
        ? {
            sessionId: activeSession.sessionId,
            projectId: activeSession.projectId,
            startedAt: activeSession.startedAt
          }
        : null;

      res.json({
        online,
        botOnline: online,
        botTag,
        connectedGuildId,
        connectedChannelId,
        installedGuildIds,
        botStatus,
        guilds,
        config: {
          id: 'default',
          guildId: config.guildId,
          guildName: config.guildName,
          channelId: config.channelId,
          channelName: config.channelName,
          language: config.language
        },
        activeSession: activeSessionSummary
      });
    } catch (err) {
      console.error('[Helix] Error in GET /api/helix/status:', err);
      res.status(500).json({ error: 'Failed to retrieve Helix status' });
    }
  });

  router.get('/api/helix/guilds/:guildId/channels', async (req, res) => {
    try {
      const { guildId } = req.params;
      if (!guildId) {
        return res.status(400).json({ error: 'Missing guildId' });
      }
      const channels = getVoiceChannelsForGuild(guildId);
      res.json(channels);
    } catch (err) {
      console.error('[Helix] Error in GET /api/helix/guilds/:guildId/channels:', err);
      res.status(500).json({ error: 'Failed to fetch guild voice channels' });
    }
  });

  router.post('/api/helix/config', async (req, res) => {
    try {
      const { guildId, guildName, channelId, channelName, language } = req.body || {};
      const existing = await getOrCreateHelixConfig();

      const nextLanguage = language !== undefined ? String(language).trim() : existing.language;
      if (!VALID_LANGUAGES.has(nextLanguage)) {
        return res.status(400).json({
          error: `Invalid language '${nextLanguage}'. Allowed values are 'de-DE' or 'en-US'.`
        });
      }

      const nextGuildId = guildId !== undefined ? String(guildId).trim() : existing.guildId;
      const nextChannelId = channelId !== undefined ? String(channelId).trim() : existing.channelId;

      let resolvedGuildName = guildName !== undefined ? String(guildName).trim() : existing.guildName;
      if (nextGuildId) {
        const guilds = getGuildsList();
        const foundGuild = guilds.find(g => g.id === nextGuildId);
        if (foundGuild && foundGuild.name) {
          resolvedGuildName = foundGuild.name;
        }
      }

      let resolvedChannelName = channelName !== undefined ? String(channelName).trim() : existing.channelName;
      if (nextGuildId && nextChannelId) {
        const channels = getVoiceChannelsForGuild(nextGuildId);
        const foundChannel = channels.find(c => c.id === nextChannelId);
        if (foundChannel && foundChannel.name) {
          resolvedChannelName = foundChannel.name;
        }
      }

      const updatedAt = new Date();
      const updated = await HelixConfig.findOneAndUpdate(
        { id: 'default' },
        {
          $set: {
            id: 'default',
            guildId: nextGuildId,
            guildName: resolvedGuildName,
            channelId: nextChannelId,
            channelName: resolvedChannelName,
            language: nextLanguage,
            updatedAt
          }
        },
        { upsert: true, new: true, lean: true }
      );

      const formattedConfig = {
        id: 'default',
        guildId: updated.guildId || '',
        guildName: updated.guildName || '',
        channelId: updated.channelId || '',
        channelName: updated.channelName || '',
        language: updated.language || 'de-DE',
        updatedAt: updated.updatedAt ? new Date(updated.updatedAt).toISOString() : updatedAt.toISOString()
      };

      res.json({
        success: true,
        ...formattedConfig,
        config: formattedConfig
      });
    } catch (err) {
      console.error('[Helix] Error in POST /api/helix/config:', err);
      res.status(500).json({ error: 'Failed to save Helix configuration' });
    }
  });

  app.use(router);

  // --- WEBSOCKET SERVER (/helix/ws) & AUDIO/STT PIPELINE ---
  const authenticatedClients = new Set();

  function broadcastWs(payload) {
    const serialized = JSON.stringify(payload);
    for (const client of authenticatedClients) {
      if (client.readyState === WebSocket.OPEN) {
        try {
          client.send(serialized);
        } catch (err) {
          console.error('[Helix] WS broadcast error:', err.message);
        }
      }
    }
  }

  async function verifyApiKey(candidateKey) {
    if (!candidateKey || typeof candidateKey !== 'string' || !candidateKey.trim()) {
      return false;
    }
    const trimmed = candidateKey.trim();
    if (process.env.MCP_API_KEY && trimmed === process.env.MCP_API_KEY) {
      return true;
    }
    if (process.env.REDSHADOW_INTERNAL_API_KEY && trimmed === process.env.REDSHADOW_INTERNAL_API_KEY) {
      return true;
    }
    const flaskBase = process.env.FLASK_INTERNAL_URL || 'http://app:5000';
    try {
      const resp = await fetch(`${flaskBase}/api/shadowrun/helix/verify-key`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': trimmed
        },
        body: JSON.stringify({ apiKey: trimmed })
      });
      if (resp.ok) {
        const data = await resp.json().catch(() => ({}));
        if (data && (data.valid === true || data.success === true)) {
          return true;
        }
      }
    } catch (err) {
      // Flask verification endpoint unreachable or rejected key
    }
    return false;
  }

  async function persistSessionTranscriptArtifact(session) {
    if (!session) return null;
    const rendered = renderTranscriptFromEntries(session.entries);
    const artifactId = `transcript-${session.sessionId}`;
    const docTitle = `Session Transcript (${session.sessionId})`;

    const attributesPayload = {
      type: 'transcript',
      subtypeTag: 'transcript',
      sessionId: session.sessionId,
      startedAt: session.startedAt,
      endedAt: session.endedAt,
      activePlayers: session.activePlayers,
      entries: session.entries,
      markers: session.markers,
      transcript: rendered
    };

    let doc = await Artifact.findOne({ projectId: session.projectId, id: artifactId });
    if (!doc) {
      doc = await Artifact.findOne({ id: artifactId });
    }
    if (!doc) {
      doc = new Artifact({
        projectId: session.projectId,
        id: artifactId
      });
    }
    doc.projectId = session.projectId;
    doc.name = docTitle;
    doc.title = docTitle;
    doc.type = 'transcript';
    doc.subtypeTag = 'transcript';
    doc.content = '';
    doc.attributes = attributesPayload;
    doc.markModified('attributes');
    doc.lastEdited = new Date();
    await doc.save();
    return rendered;
  }

  function queueTranscriptSave(session) {
    if (!session) return Promise.resolve();
    session.writeChain = session.writeChain
      .then(() => persistSessionTranscriptArtifact(session))
      .catch(err => console.error('[Helix] Failed to persist transcript artifact:', err));
    return session.writeChain;
  }

  function cleanupUserStream(session, discordId) {
    if (!session || !session.userStreams) return;
    const bundle = session.userStreams.get(String(discordId));
    if (!bundle) return;
    session.userStreams.delete(String(discordId));
    try {
      if (bundle.opusStream && typeof bundle.opusStream.destroy === 'function') {
        bundle.opusStream.destroy();
      }
    } catch (e) {}
    try {
      if (bundle.pcmDecoder && typeof bundle.pcmDecoder.destroy === 'function') {
        bundle.pcmDecoder.destroy();
      }
    } catch (e) {}
    try {
      if (bundle.sttStream) {
        if (typeof bundle.sttStream.end === 'function') bundle.sttStream.end();
        if (typeof bundle.sttStream.destroy === 'function') bundle.sttStream.destroy();
      }
    } catch (e) {}
  }

  function attachVoiceReceiver(session, voiceConnection) {
    if (!voiceConnection || !voiceConnection.receiver || !voiceConnection.receiver.speaking) {
      return;
    }
    const receiver = voiceConnection.receiver;

    const onSpeakingStart = (userId) => {
      if (!activeSession || activeSession.sessionId !== session.sessionId) return;
      const discordId = String(userId);
      const playerInfo = session.playerMap.get(discordId) || null;
      const foundryId = playerInfo ? playerInfo.foundryId : null;
      const speakerName = (playerInfo && (playerInfo.name || playerInfo.foundryId)) || discordId;

      // Immediately emit speaking_start over WebSocket
      broadcastWs({
        action: 'speaking_start',
        sessionId: session.sessionId,
        discordId,
        foundryId
      });

      // Clean up any existing stream for this user before opening a new one
      cleanupUserStream(session, discordId);

      try {
        const opusStream = receiver.subscribe(discordId, {
          end: {
            behavior: EndBehaviorType.AfterSilence,
            duration: 1000
          }
        });

        const pcmDecoder = voiceDeps.createOpusDecoder
          ? voiceDeps.createOpusDecoder()
          : new prism.opus.Decoder({ rate: 48000, channels: 1, frameSize: 960 });

        const recognizeConfig = {
          config: {
            encoding: 'LINEAR16',
            sampleRateHertz: 48000,
            languageCode: session.language || 'de-DE',
            enableAutomaticPunctuation: true
          },
          interimResults: false
        };

        const sttStream = voiceDeps.createSttStream
          ? voiceDeps.createSttStream(recognizeConfig, discordId)
          : getSpeechClient().streamingRecognize(recognizeConfig);

        session.userStreams.set(discordId, { opusStream, pcmDecoder, sttStream });

        sttStream.on('data', (data) => {
          if (!activeSession || activeSession.sessionId !== session.sessionId) return;
          if (!data || !Array.isArray(data.results)) return;
          for (const result of data.results) {
            if (!result) continue;
            if (result.isFinal === false) continue;
            const alt = Array.isArray(result.alternatives) && result.alternatives[0];
            const transcriptText = alt && alt.transcript ? String(alt.transcript).trim() : '';
            if (!transcriptText) continue;

            session.entries.push({
              kind: 'utterance',
              timestamp: new Date().toISOString(),
              discordId,
              foundryId,
              speaker: speakerName,
              text: transcriptText
            });
            queueTranscriptSave(session);
          }
        });

        sttStream.on('error', (err) => {
          console.warn(`[Helix] STT stream error for user ${discordId}:`, err.message);
        });

        opusStream.on('error', (err) => {
          console.warn(`[Helix] Opus stream error for user ${discordId}:`, err.message);
        });

        pcmDecoder.on('error', (err) => {
          console.warn(`[Helix] PCM decoder error for user ${discordId}:`, err.message);
        });

        opusStream.pipe(pcmDecoder).pipe(sttStream);
      } catch (err) {
        console.warn(`[Helix] Failed to subscribe/decode voice stream for ${discordId}:`, err.message);
      }
    };

    const onSpeakingEnd = (userId) => {
      if (!activeSession || activeSession.sessionId !== session.sessionId) return;
      const discordId = String(userId);
      const playerInfo = session.playerMap.get(discordId) || null;
      const foundryId = playerInfo ? playerInfo.foundryId : null;

      // Immediately emit speaking_stop over WebSocket
      broadcastWs({
        action: 'speaking_stop',
        sessionId: session.sessionId,
        discordId,
        foundryId
      });

      const bundle = session.userStreams.get(discordId);
      if (bundle) {
        try {
          if (bundle.opusStream && typeof bundle.opusStream.end === 'function') {
            bundle.opusStream.end();
          }
        } catch (e) {}
      }
    };

    receiver.speaking.on('start', onSpeakingStart);
    receiver.speaking.on('end', onSpeakingEnd);
    session._detachSpeakingListeners = () => {
      try {
        if (typeof receiver.speaking.off === 'function') {
          receiver.speaking.off('start', onSpeakingStart);
          receiver.speaking.off('end', onSpeakingEnd);
        } else if (typeof receiver.speaking.removeListener === 'function') {
          receiver.speaking.removeListener('start', onSpeakingStart);
          receiver.speaking.removeListener('end', onSpeakingEnd);
        }
      } catch (e) {}
    };
  }

  async function handleSessionStart(payload) {
    const sessionId = String(payload.sessionId || '').trim();
    const projectId = String(payload.projectId || 'global').trim();
    if (!sessionId) return;

    const config = await getOrCreateHelixConfig();
    const rawPlayers = Array.isArray(payload.activePlayers) ? payload.activePlayers : [];
    const normalizedPlayers = rawPlayers.map(p => ({
      foundryId: String(p.foundryId || ''),
      discordId: String(p.discordId || p.discordUserId || ''),
      name: String(p.name || p.characterName || p.discordName || p.foundryId || '')
    }));

    const playerMap = new Map();
    for (const p of normalizedPlayers) {
      if (p.discordId) {
        playerMap.set(p.discordId, p);
      }
    }

    // Upsert target Project with genre: "shadowrun"
    const existingProject = await Project.findOne({ id: projectId }).lean();
    await Project.findOneAndUpdate(
      { id: projectId },
      {
        $set: {
          id: projectId,
          name: (existingProject && existingProject.name) || payload.projectName || projectId,
          genre: 'shadowrun'
        }
      },
      { upsert: true, new: true }
    );

    const startedAt = new Date().toISOString();
    const guildId = payload.guildId || config.guildId;
    const channelId = payload.channelId || config.channelId;
    activeSession = {
      sessionId,
      projectId,
      guildId: guildId ? String(guildId) : '',
      channelId: channelId ? String(channelId) : '',
      startedAt,
      endedAt: null,
      dossier: String(payload.dossier || ''),
      language: payload.language || config.language || 'de-DE',
      activePlayers: normalizedPlayers,
      playerMap,
      entries: [],
      markers: [],
      userStreams: new Map(),
      voiceConnection: null,
      writeChain: Promise.resolve()
    };

    await queueTranscriptSave(activeSession);
    updateBotPresence('recording');

    // Connect Discord voice channel

    if (voiceDeps.joinVoiceChannel) {
      try {
        const conn = voiceDeps.joinVoiceChannel({
          guildId,
          channelId
        });
        activeSession.voiceConnection = conn;
        attachVoiceReceiver(activeSession, conn);
      } catch (err) {
        console.warn('[Helix] Injected joinVoiceChannel error:', err.message);
      }
    } else if (discordClient && discordReady && guildId && channelId) {
      try {
        const guild = discordClient.guilds.cache.get(String(guildId));
        if (guild && guild.voiceAdapterCreator) {
          const conn = discordJoinVoiceChannel({
            channelId: String(channelId),
            guildId: String(guildId),
            adapterCreator: guild.voiceAdapterCreator,
            selfDeaf: false,
            selfMute: true
          });
          activeSession.voiceConnection = conn;
          attachVoiceReceiver(activeSession, conn);
        }
      } catch (err) {
        console.warn('[Helix] Discord joinVoiceChannel error:', err.message);
      }
    }
  }

  async function handleSessionMarker(payload) {
    const sessionId = String(payload.sessionId || (activeSession && activeSession.sessionId) || '').trim();
    if (!sessionId) return;

    const timestamp = payload.timestamp || new Date().toISOString();
    const markerType = String(payload.markerType || 'note').trim();
    const label = String(payload.label || payload.text || '').trim();
    const metadata = payload.metadata && typeof payload.metadata === 'object' ? payload.metadata : {};

    const markerRecord = {
      timestamp,
      markerType,
      label,
      metadata
    };
    const entryRecord = {
      kind: 'marker',
      timestamp,
      markerType,
      text: label,
      label,
      metadata
    };

    if (activeSession && activeSession.sessionId === sessionId) {
      activeSession.markers.push(markerRecord);
      activeSession.entries.push(entryRecord);
      await queueTranscriptSave(activeSession);
    } else {
      const artifactId = `transcript-${sessionId}`;
      const doc = await Artifact.findOne({ id: artifactId });
      if (doc) {
        const attrs = doc.attributes instanceof Map ? Object.fromEntries(doc.attributes) : (doc.attributes || {});
        const entries = Array.isArray(attrs.entries) ? [...attrs.entries, entryRecord] : [entryRecord];
        const markers = Array.isArray(attrs.markers) ? [...attrs.markers, markerRecord] : [markerRecord];
        const rendered = renderTranscriptFromEntries(entries);
        doc.attributes = {
          ...attrs,
          entries,
          markers,
          transcript: rendered
        };
        doc.content = '';
        doc.markModified('attributes');
        await doc.save();
      }
    }
  }

  async function handleSessionEnd(payload) {
    const sessionId = String(payload.sessionId || (activeSession && activeSession.sessionId) || '').trim();
    if (!sessionId) return;

    const session = activeSession && activeSession.sessionId === sessionId ? activeSession : null;
    const endedAt = new Date().toISOString();

    let projectId = session ? session.projectId : (payload.projectId || 'global');
    let dossier = session ? session.dossier : (payload.dossier || '');
    let language = session ? session.language : 'de-DE';
    let transcriptText = '';

    if (session) {
      if (typeof session._detachSpeakingListeners === 'function') {
        session._detachSpeakingListeners();
      }
      for (const dId of Array.from(session.userStreams.keys())) {
        cleanupUserStream(session, dId);
      }
      if (session.voiceConnection && typeof session.voiceConnection.destroy === 'function') {
        try {
          session.voiceConnection.destroy();
        } catch (err) {
          console.warn('[Helix] Error destroying voice connection:', err.message);
        }
      }
      session.endedAt = endedAt;
      await queueTranscriptSave(session);
      const rendered = renderTranscriptFromEntries(session.entries);
      transcriptText = rendered.text;
      activeSession = null;
      updateBotPresence('idle');
    } else {
      const doc = await Artifact.findOne({ id: `transcript-${sessionId}` });
      if (doc) {
        projectId = doc.projectId || projectId;
        const attrs = doc.attributes instanceof Map ? Object.fromEntries(doc.attributes) : (doc.attributes || {});
        const rendered = renderTranscriptFromEntries(attrs.entries || []);
        transcriptText = rendered.text || (attrs.transcript && attrs.transcript.text) || '';
        doc.attributes = {
          ...attrs,
          endedAt,
          transcript: rendered
        };
        doc.content = '';
        doc.markModified('attributes');
        await doc.save();
      }
    }

    // Call Flask Gemini summarizer
    const flaskBase = process.env.FLASK_INTERNAL_URL || 'http://app:5000';
    let summaryList = [];
    let nextStepsList = [];

    try {
      const resp = await fetch(`${flaskBase}/admin/api/internal/helix/summarize`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': process.env.MCP_API_KEY || ''
        },
        body: JSON.stringify({
          sessionId,
          projectId,
          dossier,
          transcript: transcriptText,
          language
        })
      });
      if (resp.ok) {
        const resultData = await resp.json();
        const parsedSummary = arrayToStructuredList(resultData.summary);
        const parsedNextSteps = arrayToStructuredList(resultData.next_steps);
        summaryList = parsedSummary.list;
        nextStepsList = parsedNextSteps.list;
      }
    } catch (err) {
      console.warn('[Helix] Summarizer HTTP call failed, using fallback summary:', err.message);
    }

    const structuredSummary = arrayToStructuredList(summaryList);
    const structuredNextSteps = arrayToStructuredList(nextStepsList);

    // Persist summary Note obeying Structured Object Storage
    const summaryId = `summary-${sessionId}`;
    const summaryTitle = `Run Summary (${sessionId})`;
    let noteDoc = await Note.findOne({ projectId, id: summaryId });
    if (!noteDoc) {
      noteDoc = await Note.findOne({ id: summaryId });
    }
    if (!noteDoc) {
      noteDoc = new Note({ projectId, id: summaryId });
    }
    noteDoc.projectId = projectId;
    noteDoc.name = summaryTitle;
    noteDoc.title = summaryTitle;
    noteDoc.type = 'summary';
    noteDoc.subtypeTag = 'summary';
    noteDoc.content = '';
    noteDoc.attributes = {
      type: 'summary',
      subtypeTag: 'summary',
      sessionId,
      summary: {
        text: structuredSummary.text,
        html: structuredSummary.html
      },
      next_steps: {
        text: structuredNextSteps.text,
        html: structuredNextSteps.html
      }
    };
    noteDoc.markModified('attributes');
    noteDoc.lastEdited = new Date();
    await noteDoc.save();

    // Emit session_summary over WebSocket
    broadcastWs({
      action: 'session_summary',
      sessionId,
      summary: summaryList,
      next_steps: nextStepsList
    });
  }

  async function dispatchWsAction(ws, rawMessage) {
    let payload;
    try {
      payload = typeof rawMessage === 'string' ? JSON.parse(rawMessage) : JSON.parse(rawMessage.toString());
    } catch (err) {
      return;
    }
    if (!payload || typeof payload !== 'object') return;
    const action = payload.action || payload.type;

    if (action === 'session_start') {
      await handleSessionStart(payload);
    } else if (action === 'session_marker') {
      await handleSessionMarker(payload);
    } else if (action === 'session_end') {
      await handleSessionEnd(payload);
    }
  }

  if (server) {
    const wss = new WebSocketServer({ server, path: '/helix/ws' });

    wss.on('connection', async (ws, req) => {
      let authResolved = false;
      let isAuthorized = false;
      const pendingMessages = [];

      ws.on('message', (data) => {
        if (!authResolved) {
          pendingMessages.push(data);
          return;
        }
        if (isAuthorized) {
          dispatchWsAction(ws, data).catch(err => {
            console.error('[Helix] Error handling WS action:', err);
          });
        }
      });

      ws.on('close', () => {
        authenticatedClients.delete(ws);
      });

      try {
        const reqUrl = new URL(req.url || '/helix/ws', 'http://localhost');
        const queryKey = reqUrl.searchParams.get('apiKey');
        const headerKey = req.headers['x-api-key'];
        const candidateKey = queryKey || headerKey || '';

        const valid = await verifyApiKey(candidateKey);
        authResolved = true;

        if (!valid) {
          pendingMessages.length = 0;
          ws.close(4001, 'Unauthorized');
          return;
        }

        isAuthorized = true;
        authenticatedClients.add(ws);

        while (pendingMessages.length > 0) {
          const msg = pendingMessages.shift();
          await dispatchWsAction(ws, msg);
        }
      } catch (err) {
        authResolved = true;
        pendingMessages.length = 0;
        ws.close(4001, 'Unauthorized');
      }
    });
  }

  const engine = {
    setMockDiscordState(state) {
      mockDiscordState = state;
    },
    setVoiceDependencies(deps = {}) {
      voiceDeps = {
        ...voiceDeps,
        ...deps
      };
    },
    getActiveSession() {
      return activeSession;
    }
  };

  return engine;
}

module.exports = {
  setupHelixEngine,
  renderTranscriptFromEntries,
  arrayToStructuredList
};
