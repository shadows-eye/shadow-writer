const express = require('express');
const { WebSocketServer, WebSocket } = require('ws');
const { Client, GatewayIntentBits, ChannelType, ActivityType } = require('discord.js');
const { joinVoiceChannel: discordJoinVoiceChannel, EndBehaviorType, VoiceConnectionStatus } = require('@discordjs/voice');
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

const VOICE_STATE_KEYS = ['channelId', 'mute', 'selfMute', 'serverMute', 'deaf', 'selfDeaf', 'serverDeaf'];

function isBotMember(member) {
  if (!member) return false;
  return Boolean((member.user && member.user.bot === true) || member.bot || member.isBot);
}

function normalizeVoiceState(state) {
  return {
    channelId: state && state.channelId ? String(state.channelId) : null,
    mute: Boolean(state && state.mute),
    selfMute: Boolean(state && state.selfMute),
    serverMute: Boolean(state && state.serverMute),
    deaf: Boolean(state && state.deaf),
    selfDeaf: Boolean(state && state.selfDeaf),
    serverDeaf: Boolean(state && state.serverDeaf)
  };
}

function extractVoiceStateIds(oldState, newState) {
  const pick = (s, fn) => (s ? fn(s) : '');
  const guildId = pick(newState, s => (s.guild && s.guild.id) || s.guildId)
    || pick(oldState, s => (s.guild && s.guild.id) || s.guildId)
    || '';
  const discordId = pick(newState, s => s.id || (s.member && (s.member.id || (s.member.user && s.member.user.id))))
    || pick(oldState, s => s.id || (s.member && (s.member.id || (s.member.user && s.member.user.id))))
    || '';
  return {
    guildId: guildId ? String(guildId) : null,
    discordId: discordId ? String(discordId) : null
  };
}

function hasVoiceStateChanged(prev, next) {
  return VOICE_STATE_KEYS.some((key) => prev[key] !== next[key]);
}

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
  const activeSpeakers = new Set();
  const voiceConnectionState = {
    connection: null,
    guildId: '',
    channelId: '',
    detachSpeakingListeners: null,
    detachLifecycleListeners: null
  };
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
          GatewayIntentBits.GuildVoiceStates,
          GatewayIntentBits.GuildMembers
        ]
      });
      discordClient.once('clientReady', () => {
        discordReady = true;
        console.log(`[Helix] Discord bot logged in as ${discordClient.user ? discordClient.user.tag : 'unknown'}`);
        updateBotPresence('idle');
      });
      discordClient.on('voiceStateUpdate', (oldState, newState) => handleVoiceStateUpdate(oldState, newState));
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

  function getHelixUserContext(req) {
    const headers = (req && req.headers) || {};
    const userId = String(headers['x-user-id'] || '').trim();
    const userEmail = String(headers['x-user-email'] || '').trim();
    const configId = userId ? `user:${userId}` : 'default';
    return { userId, userEmail, configId };
  }

  function getGuildRoles(guildId) {
    if (!guildId) return [];
    let rawRoles = [];
    if (mockDiscordState !== null) {
      if (Array.isArray(mockDiscordState.guilds)) {
        const guild = mockDiscordState.guilds.find(g => String(g.id) === String(guildId));
        if (guild && Array.isArray(guild.roles)) {
          rawRoles = guild.roles;
        }
      }
      if (rawRoles.length === 0 && Array.isArray(mockDiscordState.roles)) {
        rawRoles = mockDiscordState.roles;
      }
    } else if (discordClient && discordReady && discordClient.guilds && discordClient.guilds.cache) {
      const guild = discordClient.guilds.cache.get(String(guildId));
      if (guild && guild.roles && guild.roles.cache) {
        rawRoles = Array.from(guild.roles.cache.values());
      }
    }
    return rawRoles
      .filter(r => r && String(r.name) !== '@everyone')
      .map(r => ({
        id: String(r.id),
        name: String(r.name || ''),
        color: typeof r.color === 'number' || typeof r.color === 'string' ? r.color : 0,
        position: Number(r.position || 0)
      }))
      .sort((a, b) => b.position - a.position);
  }

  function memberHasRole(member, roleId) {
    if (!roleId) return true;
    if (!member || !member.roles) return false;
    const targetId = String(roleId);
    if (member.roles.cache && typeof member.roles.cache.has === 'function') {
      return member.roles.cache.has(targetId);
    }
    if (typeof member.roles.has === 'function') {
      return member.roles.has(targetId);
    }
    if (Array.isArray(member.roles)) {
      return member.roles.some(r => String(typeof r === 'object' && r !== null ? r.id : r) === targetId);
    }
    return false;
  }

  const guildMemberFetchTimestamps = new Map();
  const GUILD_MEMBER_FETCH_TTL_MS = 60 * 1000;

  function findVoiceChannelInCollection(channels, targetId) {
    if (!channels || !targetId) return null;
    const idStr = String(targetId);
    const collection = channels.cache || channels;
    const ch = typeof collection.get === 'function'
      ? (collection.get(idStr) || null)
      : (Array.isArray(collection) ? (collection.find((item) => item && String(item.id) === idStr) || null) : null);
    return ch && VOICE_CHANNEL_TYPES.has(ch.type) ? ch : null;
  }

  function resolveVoiceChannelName(voiceState, channelId, guildId = '') {
    if (!channelId) return null;
    const targetChannelId = String(channelId);

    const directChannel = voiceState && voiceState.channel;
    if (
      directChannel &&
      (!directChannel.id || String(directChannel.id) === targetChannelId) &&
      (directChannel.type === undefined || VOICE_CHANNEL_TYPES.has(directChannel.type)) &&
      directChannel.name
    ) {
      return String(directChannel.name);
    }

    const guildChannels = voiceState && voiceState.guild && voiceState.guild.channels;
    const foundInGuild = findVoiceChannelInCollection(guildChannels, targetChannelId);
    if (foundInGuild && foundInGuild.name) {
      return String(foundInGuild.name);
    }

    const resolvedGuildId = guildId
      || (voiceState && voiceState.guild && voiceState.guild.id)
      || (voiceState && voiceState.guildId)
      || '';
    if (resolvedGuildId) {
      const voiceChannels = getVoiceChannelsForGuild(resolvedGuildId);
      const matched = voiceChannels.find((ch) => String(ch.id) === targetChannelId);
      if (matched && matched.name) {
        return String(matched.name);
      }
    }

    return null;
  }

  function formatVoiceFlags(voiceState, guildId = '') {
    const norm = normalizeVoiceState(voiceState);
    return {
      inVoice: Boolean(norm.channelId),
      channelId: norm.channelId,
      channelName: resolveVoiceChannelName(voiceState, norm.channelId, guildId),
      muted: Boolean(norm.mute || norm.selfMute || norm.serverMute),
      selfMute: norm.selfMute,
      serverMute: norm.serverMute,
      deaf: Boolean(norm.deaf || norm.selfDeaf || norm.serverDeaf)
    };
  }

  function serializeGuildMember(member, guildId = '') {
    const user = (member && member.user) || {};
    const discordId = String((member && member.id) || '');
    const name = (member && member.displayName) || user.username || (member && member.name) || discordId;
    const tag = user.tag || user.username || (member && member.tag) || (member && member.displayName) || (member && member.name) || discordId;
    const voiceFlags = formatVoiceFlags(member && member.voice, guildId);

    return {
      id: discordId,
      name: String(name),
      tag: String(tag),
      isBot: false,
      ...voiceFlags,
      speaking: activeSpeakers.has(discordId)
    };
  }

  async function getGuildMembers(guildId, channelId, roleId = '') {
    const targetRoleId = String(roleId || '').trim();
    if (mockDiscordState !== null) {
      let rawMembers = [];
      if (Array.isArray(mockDiscordState.guilds) && guildId) {
        const guild = mockDiscordState.guilds.find(g => String(g.id) === String(guildId));
        if (guild && Array.isArray(guild.members) && guild.members.length > 0) {
          rawMembers = guild.members;
        }
      }
      if (rawMembers.length === 0 && Array.isArray(mockDiscordState.members)) {
        rawMembers = mockDiscordState.members;
      }
      return rawMembers
        .filter(m => Boolean(m) && !isBotMember(m))
        .filter(m => !targetRoleId || memberHasRole(m, targetRoleId))
        .map(m => serializeGuildMember(m, guildId));
    }

    if (discordClient && discordReady && discordClient.guilds && discordClient.guilds.cache) {
      if (!guildId) return [];
      const guild = discordClient.guilds.cache.get(String(guildId));
      if (!guild) return [];

      let memberCollection = null;
      const gKey = String(guildId);
      const lastFetch = guildMemberFetchTimestamps.get(gKey) || 0;
      const cacheHasMembers = guild.members && guild.members.cache && guild.members.cache.size > 0;
      if (!cacheHasMembers || (Date.now() - lastFetch > GUILD_MEMBER_FETCH_TTL_MS)) {
        try {
          if (guild.members && typeof guild.members.fetch === 'function') {
            memberCollection = await guild.members.fetch();
            guildMemberFetchTimestamps.set(gKey, Date.now());
          }
        } catch (err) {
          console.warn('[Helix] Failed to fetch guild members:', err.message);
        }
      }
      if (!memberCollection && guild.members && guild.members.cache) {
        memberCollection = guild.members.cache;
      }
      if (memberCollection) {
        return Array.from(memberCollection.values())
          .filter(m => Boolean(m) && !isBotMember(m))
          .filter(m => !targetRoleId || memberHasRole(m, targetRoleId))
          .map(m => serializeGuildMember(m, guildId));
      }
    }
    return [];
  }

  async function getOrCreateHelixConfig(userId = '') {
    const cleanUserId = String(userId || '').trim();
    const configId = cleanUserId ? `user:${cleanUserId}` : 'default';
    let cfg = await HelixConfig.findOne({ id: configId }).lean();
    if (!cfg) {
      const created = await HelixConfig.findOneAndUpdate(
        { id: configId },
        {
          $setOnInsert: {
            id: configId,
            userId: cleanUserId,
            guildId: '',
            guildName: '',
            channelId: '',
            channelName: '',
            roleId: '',
            roleName: '',
            language: 'de-DE',
            updatedAt: new Date()
          }
        },
        { upsert: true, new: true, lean: true }
      );
      cfg = created;
    }
    return {
      id: configId,
      userId: cfg.userId || cleanUserId,
      guildId: cfg.guildId || '',
      guildName: cfg.guildName || '',
      channelId: cfg.channelId || '',
      channelName: cfg.channelName || '',
      roleId: cfg.roleId || '',
      roleName: cfg.roleName || '',
      language: cfg.language || 'de-DE',
      updatedAt: cfg.updatedAt ? new Date(cfg.updatedAt).toISOString() : new Date().toISOString()
    };
  }

  // --- REST ENDPOINTS ---
  router.get('/api/helix/status', async (req, res) => {
    try {
      const { userId } = getHelixUserContext(req);
      const config = await getOrCreateHelixConfig(userId);
      const online = isBotOnline();
      const botTag = getBotTag();
      const guilds = getGuildsList();
      const installedGuildIds = guilds.map(g => String(g.id));
      const connectedGuildId = (activeSession && activeSession.guildId)
        || (voiceConnectionState.connection && voiceConnectionState.guildId)
        || config.guildId
        || null;
      const connectedChannelId = (activeSession && activeSession.channelId)
        || (voiceConnectionState.connection && voiceConnectionState.channelId)
        || config.channelId
        || null;
      const members = await getGuildMembers(connectedGuildId, connectedChannelId, config.roleId);
      const roles = getGuildRoles(connectedGuildId);
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
        roles,
        members,
        config: {
          id: config.id,
          userId: config.userId,
          guildId: config.guildId,
          guildName: config.guildName,
          channelId: config.channelId,
          channelName: config.channelName,
          roleId: config.roleId,
          roleName: config.roleName,
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

  router.get('/api/helix/guilds/:guildId/roles', async (req, res) => {
    try {
      const { guildId } = req.params;
      if (!guildId) {
        return res.status(400).json({ error: 'Missing guildId' });
      }
      const roles = getGuildRoles(guildId);
      res.json({ roles });
    } catch (err) {
      console.error('[Helix] Error in GET /api/helix/guilds/:guildId/roles:', err);
      res.status(500).json({ error: 'Failed to fetch guild roles' });
    }
  });

  router.post('/api/helix/config', async (req, res) => {
    try {
      const { userId, configId } = getHelixUserContext(req);
      const { guildId, guildName, channelId, channelName, roleId, roleName, language } = req.body || {};
      const existing = await getOrCreateHelixConfig(userId);

      const nextLanguage = language !== undefined ? String(language).trim() : existing.language;
      if (!VALID_LANGUAGES.has(nextLanguage)) {
        return res.status(400).json({
          error: `Invalid language '${nextLanguage}'. Allowed values are 'de-DE' or 'en-US'.`
        });
      }

      const nextGuildId = guildId !== undefined ? String(guildId).trim() : existing.guildId;
      const nextChannelId = channelId !== undefined ? String(channelId).trim() : existing.channelId;
      const nextRoleId = roleId !== undefined ? String(roleId).trim() : (existing.roleId || '');

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

      let resolvedRoleName = roleName !== undefined
        ? String(roleName).trim()
        : (roleId !== undefined && !nextRoleId ? '' : (existing.roleName || ''));
      if (nextGuildId && nextRoleId) {
        const roles = getGuildRoles(nextGuildId);
        const foundRole = roles.find(r => r.id === nextRoleId);
        if (foundRole && foundRole.name) {
          resolvedRoleName = foundRole.name;
        }
      }

      const updatedAt = new Date();
      const updated = await HelixConfig.findOneAndUpdate(
        { id: configId },
        {
          $set: {
            id: configId,
            userId,
            guildId: nextGuildId,
            guildName: resolvedGuildName,
            channelId: nextChannelId,
            channelName: resolvedChannelName,
            roleId: nextRoleId,
            roleName: resolvedRoleName,
            language: nextLanguage,
            updatedAt
          }
        },
        { upsert: true, new: true, lean: true }
      );

      const formattedConfig = {
        id: configId,
        userId: updated.userId || userId,
        guildId: updated.guildId || '',
        guildName: updated.guildName || '',
        channelId: updated.channelId || '',
        channelName: updated.channelName || '',
        roleId: updated.roleId || '',
        roleName: updated.roleName || '',
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

  router.post('/api/helix/session/start', async (req, res) => {
    try {
      const payload = req.body || {};
      const sessionId = String(payload.sessionId || '').trim();
      if (!sessionId) {
        return res.status(400).json({ error: 'Missing sessionId' });
      }
      const { userId, userEmail } = getHelixUserContext(req);
      const result = await handleSessionStart({
        ...payload,
        userId: payload.userId || userId,
        userEmail: payload.userEmail || userEmail
      });
      if (result && result.forbidden) {
        return res.status(result.status || 403).json(result);
      }
      if (result && result.conflict) {
        return res.status(409).json(result);
      }
      const startedAt = (result && result.startedAt)
        || (activeSession && activeSession.sessionId === sessionId && activeSession.startedAt)
        || new Date().toISOString();
      const projectId = (result && result.projectId)
        || String(payload.projectId || payload.bookId || 'global').trim()
        || 'global';
      res.json({
        success: true,
        sessionId,
        projectId,
        status: 'active',
        startedAt
      });
    } catch (err) {
      console.error('[Helix] Error in POST /api/helix/session/start:', err);
      res.status(500).json({ error: 'Failed to start Helix session' });
    }
  });

  router.post('/api/helix/session/end', async (req, res) => {
    try {
      const payload = req.body || {};
      const sessionId = String(payload.sessionId || (activeSession && activeSession.sessionId) || '').trim();
      if (!sessionId) {
        return res.status(400).json({ error: 'Missing sessionId' });
      }
      const { userId, userEmail } = getHelixUserContext(req);
      const result = await handleSessionEnd({
        ...payload,
        userId: userId || payload.userId || '',
        userEmail: userEmail || payload.userEmail || ''
      });
      const endedAt = (result && result.endedAt) || new Date().toISOString();
      const projectId = (result && result.projectId)
        || String(payload.projectId || payload.bookId || 'global').trim()
        || 'global';
      res.json({
        success: true,
        sessionId,
        projectId,
        status: 'ended',
        endedAt
      });
    } catch (err) {
      console.error('[Helix] Error in POST /api/helix/session/end:', err);
      res.status(500).json({ error: 'Failed to end Helix session' });
    }
  });

  router.get('/api/helix/summary/:jobId', async (req, res) => {
    try {
      const { jobId } = req.params;
      const cleanId = String(jobId || '').trim();
      if (!cleanId) {
        return res.json({ status: 'processing', jobId: '' });
      }
      const { userId } = getHelixUserContext(req);
      const projectId = String(req.query.projectId || req.query.bookId || '').trim();
      const baseFilter = {};
      if (projectId) {
        baseFilter.projectId = projectId;
      }
      if (userId) {
        baseFilter.userId = userId;
      }
      const targetId = cleanId.startsWith('summary-') ? cleanId : `summary-${cleanId}`;
      let noteDoc = await Note.findOne({ ...baseFilter, id: targetId }).lean();
      if (!noteDoc && !cleanId.startsWith('summary-')) {
        noteDoc = await Note.findOne({ ...baseFilter, id: cleanId }).lean();
      }
      if (noteDoc) {
        const attrs = (noteDoc.attributes instanceof Map ? Object.fromEntries(noteDoc.attributes) : noteDoc.attributes) || {};
        return res.json({
          status: 'completed',
          jobId: cleanId,
          projectId: noteDoc.projectId || projectId || '',
          sessionId: attrs.sessionId || cleanId,
          summary: attrs.summary || null,
          nextSteps: attrs.next_steps || attrs.nextSteps || null
        });
      }
      return res.json({
        status: 'processing',
        jobId: cleanId
      });
    } catch (err) {
      console.error('[Helix] Error in GET /api/helix/summary/:jobId:', err);
      res.status(500).json({ error: 'Failed to retrieve summary' });
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

  function handleVoiceStateUpdate(oldState, newState) {
    if (!oldState && !newState) return;
    const member = (newState && newState.member) || (oldState && oldState.member) || null;
    if (isBotMember(member) || isBotMember(oldState && oldState.member)) return;

    const prev = normalizeVoiceState(oldState);
    const next = normalizeVoiceState(newState);
    if (!hasVoiceStateChanged(prev, next)) return;

    const { guildId, discordId } = extractVoiceStateIds(oldState, newState);
    if (!discordId) return;

    if (!next.channelId) {
      activeSpeakers.delete(discordId);
    }

    broadcastWs({
      action: 'voice_state_update',
      guildId,
      discordId,
      ...formatVoiceFlags(newState, guildId)
    });
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
    if (session.userId) {
      doc.userId = session.userId;
    }
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
      }
    } catch (e) {}
  }

  function destroyVoiceConnection() {
    if (typeof voiceConnectionState.detachSpeakingListeners === 'function') {
      voiceConnectionState.detachSpeakingListeners();
    }
    voiceConnectionState.detachSpeakingListeners = null;

    if (typeof voiceConnectionState.detachLifecycleListeners === 'function') {
      voiceConnectionState.detachLifecycleListeners();
    }
    voiceConnectionState.detachLifecycleListeners = null;

    if (voiceConnectionState.connection && typeof voiceConnectionState.connection.destroy === 'function') {
      try {
        voiceConnectionState.connection.destroy();
      } catch (err) {
        console.warn('[Helix] Error destroying voice connection:', err.message);
      }
    }
    voiceConnectionState.connection = null;
    voiceConnectionState.guildId = '';
    voiceConnectionState.channelId = '';
    activeSpeakers.clear();
  }

  function attachVoiceConnectionLifecycle(voiceConnection) {
    if (!voiceConnection || typeof voiceConnection.on !== 'function') return null;

    const onStateChange = (oldState, newState) => {
      const oldStatus = oldState && oldState.status;
      const newStatus = newState && newState.status;
      if (oldStatus !== undefined || newStatus !== undefined) {
        console.log(`[Helix] Voice connection state: ${oldStatus} -> ${newStatus}`);
      }
      if (
        newStatus === VoiceConnectionStatus.Disconnected ||
        newStatus === VoiceConnectionStatus.Destroyed ||
        newStatus === 'disconnected' ||
        newStatus === 'destroyed'
      ) {
        activeSpeakers.clear();
      }
    };

    const onDisconnect = () => {
      activeSpeakers.clear();
    };

    const onError = (err) => {
      console.error('[Helix] Voice connection error:', err.message);
    };

    voiceConnection.on('stateChange', onStateChange);
    voiceConnection.on(VoiceConnectionStatus.Disconnected, onDisconnect);
    voiceConnection.on(VoiceConnectionStatus.Destroyed, onDisconnect);
    voiceConnection.on('error', onError);

    return () => {
      const off = typeof voiceConnection.off === 'function'
        ? voiceConnection.off.bind(voiceConnection)
        : (typeof voiceConnection.removeListener === 'function'
            ? voiceConnection.removeListener.bind(voiceConnection)
            : null);
      if (!off) return;
      try {
        off('stateChange', onStateChange);
        off(VoiceConnectionStatus.Disconnected, onDisconnect);
        off(VoiceConnectionStatus.Destroyed, onDisconnect);
        off('error', onError);
      } catch (e) {}
    };
  }

  function startUserSttPipeline(session, receiver, discordId, playerInfo) {
    const foundryId = playerInfo ? playerInfo.foundryId : null;
    const speakerName = (playerInfo && (playerInfo.name || playerInfo.foundryId)) || discordId;
    console.log(`[Helix] Speaking start: ${speakerName} (${discordId})`);

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
          if (!result || result.isFinal === false) continue;
          const alt = Array.isArray(result.alternatives) && result.alternatives[0];
          const transcriptText = alt && alt.transcript ? String(alt.transcript).trim() : '';
          if (!transcriptText) continue;

          console.log(`[Helix] Transcript (${speakerName}): ${transcriptText}`);
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
  }

  function attachVoiceReceiver(voiceConnection) {
    if (!voiceConnection || !voiceConnection.receiver || !voiceConnection.receiver.speaking) {
      return null;
    }
    const receiver = voiceConnection.receiver;

    const onSpeakingStart = (userId) => {
      const session = activeSession;
      if (!session) {
        return;
      }
      const discordId = String(userId);
      activeSpeakers.add(discordId);
      const playerInfo = session.playerMap ? (session.playerMap.get(discordId) || null) : null;
      const foundryId = playerInfo ? playerInfo.foundryId : null;

      broadcastWs({
        action: 'speaking_start',
        sessionId: session.sessionId,
        discordId,
        foundryId
      });

      startUserSttPipeline(session, receiver, discordId, playerInfo);
    };

    const onSpeakingEnd = (userId) => {
      const discordId = String(userId);
      activeSpeakers.delete(discordId);
      const session = activeSession;
      if (!session) {
        return;
      }
      const playerInfo = session.playerMap ? (session.playerMap.get(discordId) || null) : null;
      const foundryId = playerInfo ? playerInfo.foundryId : null;

      broadcastWs({
        action: 'speaking_stop',
        sessionId: session.sessionId,
        discordId,
        foundryId
      });
    };

    receiver.speaking.on('start', onSpeakingStart);
    receiver.speaking.on('end', onSpeakingEnd);
    return () => {
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

  function ensureVoiceConnection(guildId, channelId, logLabel = '') {
    const targetGuildId = guildId ? String(guildId).trim() : '';
    const targetChannelId = channelId ? String(channelId).trim() : '';

    if (voiceConnectionState.connection) {
      const sameTarget = Boolean(
        targetGuildId &&
        targetChannelId &&
        voiceConnectionState.guildId === targetGuildId &&
        voiceConnectionState.channelId === targetChannelId &&
        !voiceConnectionState.connection.destroyed
      );
      if (sameTarget) {
        return voiceConnectionState.connection;
      }
      destroyVoiceConnection();
    }

    let conn = null;
    if (voiceDeps.joinVoiceChannel) {
      try {
        conn = voiceDeps.joinVoiceChannel({
          guildId: targetGuildId || guildId,
          channelId: targetChannelId || channelId
        });
      } catch (err) {
        console.warn('[Helix] Injected joinVoiceChannel error:', err.message);
      }
    } else if (discordClient && discordReady && targetGuildId && targetChannelId) {
      try {
        const guild = discordClient.guilds.cache.get(targetGuildId);
        if (guild && guild.voiceAdapterCreator) {
          console.log(`[Helix] Joining voice channel ${targetChannelId} in guild ${targetGuildId}${logLabel ? ` (${logLabel})` : ''}`);
          conn = discordJoinVoiceChannel({
            channelId: targetChannelId,
            guildId: targetGuildId,
            adapterCreator: guild.voiceAdapterCreator,
            selfDeaf: false,
            selfMute: true
          });
        } else {
          console.warn(`[Helix] Could not join voice: guild ${targetGuildId} not found in cache or missing voiceAdapterCreator`);
        }
      } catch (err) {
        console.warn('[Helix] Discord joinVoiceChannel error:', err.message);
      }
    } else {
      console.warn(`[Helix] Voice join skipped: discordReady=${discordReady}, guildId=${targetGuildId || 'none'}, channelId=${targetChannelId || 'none'}`);
    }

    if (!conn) return null;

    voiceConnectionState.connection = conn;
    voiceConnectionState.guildId = targetGuildId;
    voiceConnectionState.channelId = targetChannelId;
    voiceConnectionState.detachLifecycleListeners = attachVoiceConnectionLifecycle(conn);
    voiceConnectionState.detachSpeakingListeners = attachVoiceReceiver(conn);
    return conn;
  }

  async function handleSessionStart(payload) {
    const sessionId = String(payload.sessionId || '').trim();
    const projectId = String(payload.projectId || payload.bookId || 'global').trim() || 'global';
    if (!sessionId) return;

    if (activeSession && activeSession.sessionId !== sessionId) {
      return {
        conflict: true,
        error: 'Another live recording session is already active',
        activeSessionId: activeSession.sessionId
      };
    }

    const sessionUserId = String(payload.userId || '').trim();
    const sessionUserEmail = String(payload.userEmail || '').trim();
    const config = await getOrCreateHelixConfig(sessionUserId);
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

    // Upsert target Project with genre: "shadowrun" (never overwrite a project owned by another user)
    const existingProject = await Project.findOne({ id: projectId }).lean();
    const isOwnedByOther = Boolean(existingProject && existingProject.userId && sessionUserId && existingProject.userId !== sessionUserId);
    if (isOwnedByOther) {
      return {
        forbidden: true,
        status: 403,
        error: 'Forbidden: project belongs to another user'
      };
    }
    {
      const projectSet = {
        id: projectId,
        name: (existingProject && existingProject.name) || payload.projectName || projectId,
        genre: (existingProject && existingProject.genre) || 'shadowrun'
      };
      const updateOp = { $set: projectSet };
      if (existingProject && !existingProject.userId) {
        if (sessionUserId) projectSet.userId = sessionUserId;
        if (sessionUserEmail) projectSet.userEmail = sessionUserEmail;
      } else if (!existingProject) {
        const onInsert = {};
        if (sessionUserId) onInsert.userId = sessionUserId;
        if (sessionUserEmail) onInsert.userEmail = sessionUserEmail;
        if (Object.keys(onInsert).length > 0) {
          updateOp.$setOnInsert = onInsert;
        }
      }
      await Project.findOneAndUpdate(
        { id: projectId },
        updateOp,
        { upsert: true, new: true }
      );
    }

    const startedAt = new Date().toISOString();
    const guildId = payload.guildId || config.guildId;
    const channelId = payload.channelId || config.channelId;
    activeSession = {
      sessionId,
      projectId,
      userId: sessionUserId,
      userEmail: sessionUserEmail,
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

    // Connect or reuse Discord voice channel
    const conn = ensureVoiceConnection(guildId, channelId, `session ${sessionId}`);
    if (conn) {
      activeSession.voiceConnection = conn;
    }

    return {
      sessionId,
      projectId,
      startedAt
    };
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

    const explicitProjectId = String((session && session.projectId) || payload.projectId || payload.bookId || '').trim();
    let projectId = explicitProjectId || 'global';
    let dossier = session ? session.dossier : (payload.dossier || '');
    let language = session ? session.language : 'de-DE';
    let sessionUserId = session ? (session.userId || '') : String(payload.userId || '').trim();
    let transcriptText = '';

    if (session) {
      // Clear activeSession before awaiting transcript persistence so speaking events cannot open new STT streams during teardown.
      activeSession = null;
      for (const dId of Array.from(session.userStreams.keys())) {
        cleanupUserStream(session, dId);
      }

      const previousStateConn = voiceConnectionState.connection;
      destroyVoiceConnection();
      if (
        session.voiceConnection &&
        session.voiceConnection !== previousStateConn &&
        typeof session.voiceConnection.destroy === 'function'
      ) {
        try {
          session.voiceConnection.destroy();
        } catch (err) {
          console.warn('[Helix] Error destroying voice connection:', err.message);
        }
      }
      activeSpeakers.clear();
      session.endedAt = endedAt;
      await queueTranscriptSave(session);
      const rendered = renderTranscriptFromEntries(session.entries);
      transcriptText = rendered.text;
      updateBotPresence('idle');
    } else {
      const doc = await Artifact.findOne({ id: `transcript-${sessionId}` });
      if (doc) {
        if (!explicitProjectId && doc.projectId) {
          projectId = doc.projectId;
        }
        sessionUserId = sessionUserId || doc.userId || '';
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
    if (!noteDoc && projectId === 'global') {
      noteDoc = await Note.findOne({
        id: summaryId,
        $or: [{ projectId: 'global' }, { projectId: '' }, { projectId: { $exists: false } }]
      });
    }
    const noteOwnedByOther = Boolean(noteDoc && noteDoc.userId && sessionUserId && noteDoc.userId !== sessionUserId);
    if (!noteOwnedByOther) {
      if (!noteDoc) {
        noteDoc = new Note({ projectId, id: summaryId });
      }
      noteDoc.projectId = projectId;
      if (sessionUserId) {
        noteDoc.userId = sessionUserId;
      }
      noteDoc.name = summaryTitle;
      noteDoc.title = summaryTitle;
      noteDoc.type = 'summary';
      noteDoc.subtypeTag = 'summary';
      noteDoc.content = '';
      noteDoc.attributes = {
        type: 'summary',
        subtypeTag: 'summary',
        sessionId,
        projectId,
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
    }

    // Emit session_summary over WebSocket
    broadcastWs({
      action: 'session_summary',
      sessionId,
      projectId,
      summary: summaryList,
      next_steps: nextStepsList
    });

    return {
      sessionId,
      projectId,
      endedAt
    };
  }

  async function dispatchWsAction(ws, rawMessage, wsUserContext = {}) {
    let payload;
    try {
      payload = typeof rawMessage === 'string' ? JSON.parse(rawMessage) : JSON.parse(rawMessage.toString());
    } catch (err) {
      return;
    }
    if (!payload || typeof payload !== 'object') return;
    const action = payload.action || payload.type;
    const enrichedPayload = {
      ...payload,
      userId: payload.userId || wsUserContext.userId || '',
      userEmail: payload.userEmail || wsUserContext.userEmail || ''
    };

    if (action === 'session_start') {
      const result = await handleSessionStart(enrichedPayload);
      if (result && result.forbidden && ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({
          action: 'session_error',
          type: 'session_error',
          ...result
        }));
      } else if (result && result.conflict && ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({
          action: 'session_conflict',
          type: 'session_error',
          ...result
        }));
      }
    } else if (action === 'session_marker') {
      await handleSessionMarker(enrichedPayload);
    } else if (action === 'session_end') {
      await handleSessionEnd(enrichedPayload);
    }
  }

  if (server) {
    const wss = new WebSocketServer({ server, path: '/helix/ws' });

    wss.on('connection', async (ws, req) => {
      let authResolved = false;
      let isAuthorized = false;
      let authTimeout = null;
      const wsUserContext = getHelixUserContext(req);
      const pendingMessages = [];

      const closeUnauthorized = () => {
        if (authTimeout) {
          clearTimeout(authTimeout);
          authTimeout = null;
        }
        authResolved = true;
        isAuthorized = false;
        pendingMessages.length = 0;
        authenticatedClients.delete(ws);
        try {
          ws.close(4001, 'Unauthorized');
        } catch (_) {}
      };

      const authorizeConnection = async (candidateKey) => {
        const valid = await verifyApiKey(candidateKey);
        if (!valid) {
          closeUnauthorized();
          return false;
        }
        if (authTimeout) {
          clearTimeout(authTimeout);
          authTimeout = null;
        }
        authResolved = true;
        isAuthorized = true;
        authenticatedClients.add(ws);
        return true;
      };

      ws.on('message', async (data) => {
        if (!authResolved) {
          // Await first-frame auth when no handshake key was supplied
          let frame;
          try {
            frame = typeof data === 'string' ? JSON.parse(data) : JSON.parse(data.toString());
          } catch (_) {
            closeUnauthorized();
            return;
          }
          const frameAction = frame && (frame.action || frame.type);
          const frameKey = frame && typeof frame.apiKey === 'string' ? frame.apiKey.trim() : '';
          if (frameAction !== 'auth' || !frameKey) {
            closeUnauthorized();
            return;
          }
          const ok = await authorizeConnection(frameKey);
          if (ok && ws.readyState === WebSocket.OPEN) {
            try {
              ws.send(JSON.stringify({ action: 'auth_ok' }));
            } catch (_) {}
          }
          return;
        }
        if (isAuthorized) {
          dispatchWsAction(ws, data, wsUserContext).catch(err => {
            console.error('[Helix] Error handling WS action:', err);
          });
        }
      });

      ws.on('close', () => {
        if (authTimeout) {
          clearTimeout(authTimeout);
          authTimeout = null;
        }
        authenticatedClients.delete(ws);
      });

      try {
        const reqUrl = new URL(req.url || '/helix/ws', 'http://localhost');
        const queryKey = reqUrl.searchParams.get('apiKey');
        const headerKey = req.headers['x-api-key'];
        const candidateKey = String(queryKey || headerKey || '').trim();

        if (candidateKey) {
          const ok = await authorizeConnection(candidateKey);
          if (!ok) return;
          while (pendingMessages.length > 0) {
            const msg = pendingMessages.shift();
            await dispatchWsAction(ws, msg, wsUserContext);
          }
        } else {
          // Allow browser clients to authenticate via first frame without exposing apiKey in URL
          authTimeout = setTimeout(() => {
            if (!isAuthorized) {
              closeUnauthorized();
            }
          }, 2000);
          authTimeout.unref?.();
        }
      } catch (err) {
        closeUnauthorized();
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
    },
    handleVoiceStateUpdate
  };

  return engine;
}

module.exports = {
  setupHelixEngine,
  renderTranscriptFromEntries,
  arrayToStructuredList
};
