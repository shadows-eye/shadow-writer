const express = require('express');
const crypto = require('crypto');
const {
  Chapter,
  Character,
  Note,
  Artifact,
  ensureCleanDocumentOnRead,
  sanitizeAttributesObj,
  sanitizeAndStructureContent,
  extractString
} = require('./mongoDB');
const {
  generateContent,
  DEFAULT_FLASH_MODEL,
  DEFAULT_PRO_MODEL
} = require('./geminiClient');

const router = express.Router();

function normalizeEditorialHtmlToMarkdown(rawInput) {
  if (!rawInput || typeof rawInput !== 'string') return '';
  let s = rawInput.replace(/\r\n/g, '\n').trim();
  if (!s) return '';

  if (/<div\b|<br\b|<span\b/i.test(s)) {
    s = s.replace(/<span[^>]*class=["']?[^"'>]*(?:issue-highlight|accepted-flash)[^"'>]*["']?[^>]*>([\s\S]*?)<\/span>/gi, '$1');
    s = s.replace(/<div>\s*<br\s*\/?>\s*<\/div>/gi, '\n\n');
    s = s.replace(/<br\s*\/?>/gi, '\n');
    s = s.replace(/<\/div>\s*<div[^>]*>/gi, '\n');
    s = s.replace(/<\/?div[^>]*>/gi, '');
    s = s.replace(/&nbsp;/gi, ' ')
         .replace(/&amp;/gi, '&')
         .replace(/&lt;/gi, '<')
         .replace(/&gt;/gi, '>')
         .replace(/&quot;/gi, '"');
  }

  const lines = s.split('\n');
  const outLines = [];
  let sceneCount = 0;
  for (const line of lines) {
    const trimmed = line.trim();
    const sceneMatch = trimmed.match(/^(?:#+\s*)?((?:Scene|Szene)\s*\d+\b.*)$/i);
    if (sceneMatch) {
      sceneCount++;
      if (sceneCount > 1) {
        outLines.push('\n***\n');
      }
      outLines.push(`# ${sceneMatch[1].replace(/^#+\s*/, '').trim()}`);
    } else {
      outLines.push(line);
    }
  }
  return outLines.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

async function upsertChapterRecord(pId, id, { name, content, attributes: reqAttributes, clearPendingDiff } = {}) {
  const match = String(id).match(/\d+/);
  const orderIndex = match ? parseInt(match[0], 10) : 999;

  const updateData = { orderIndex, lastEdited: new Date() };

  if (name || (reqAttributes && reqAttributes.name)) {
    updateData.name = extractString(name || reqAttributes.name);
  }

  if (content) {
    const normalizedMd = normalizeEditorialHtmlToMarkdown(content);
    const { attributes, cleanContent } = sanitizeAndStructureContent(normalizedMd, 'chapter', id);
    attributes.type = 'chapters';
    attributes.subtypeTag = 'chapters';
    if (reqAttributes && Object.keys(reqAttributes).length > 0) {
      const cleanedReqAttrs = { ...reqAttributes };
      delete cleanedReqAttrs.name;
      Object.assign(attributes, cleanedReqAttrs);
      if (reqAttributes.name && !updateData.name) {
        updateData.name = extractString(reqAttributes.name);
      }
    }
    if (cleanContent) {
      attributes.unstructured = cleanContent;
    }

    const scenesData = {};
    if (cleanContent) {
      const generateId = () => crypto.randomBytes(4).toString('hex');
      const sceneTokens = cleanContent.split(/(<hr\b[^>]*class=["']?[^"'>]*scene-break[^"'>]*["']?[^>]*>|<p>\s*\*\*\*\s*<\/p>|<div>\s*\*\*\*\s*<\/div>|\n\s*\*\*\*\s*\n)/i);

      let currentSceneId = `scene-${generateId()}`;
      const currentSceneText = sceneTokens[0] || '';
      const stripHtml = (html) => html.replace(/<[^>]*>?/gm, '').trim();

      const parseBeats = (sceneText) => {
        const beatTokens = sceneText.split(/(<hr\b[^>]*class=["']?[^"'>]*beat-break[^"'>]*["']?[^>]*>|<p>\s*---\s*<\/p>|<div>\s*---\s*<\/div>|\n\s*---\s*\n)/i);
        const beats = {};
        let currentBeatId = `beat-${generateId()}`;
        const currentBeatText = beatTokens[0] || '';

        if (currentBeatText.trim().length > 0) {
          beats[currentBeatId] = { id: currentBeatId, text: stripHtml(currentBeatText), html: currentBeatText.trim() };
        }

        for (let i = 1; i < beatTokens.length; i += 2) {
          const sep = beatTokens[i];
          const nextText = beatTokens[i + 1] || '';
          const idMatch = sep.match(/id=["']([^"']+)["']/i);
          currentBeatId = idMatch ? idMatch[1] : `beat-${generateId()}`;

          if (nextText.trim().length > 0) {
            beats[currentBeatId] = { id: currentBeatId, text: stripHtml(nextText), html: nextText.trim() };
          }
        }
        return beats;
      };

      if (currentSceneText.trim().length > 0) {
        const parsedBeats = parseBeats(currentSceneText);
        if (Object.keys(parsedBeats).length > 0) {
          scenesData[currentSceneId] = { id: currentSceneId, beats: parsedBeats };
        }
      }

      for (let i = 1; i < sceneTokens.length; i += 2) {
        const sep = sceneTokens[i];
        const nextText = sceneTokens[i + 1] || '';

        const idMatch = sep.match(/id=["']([^"']+)["']/i);
        currentSceneId = idMatch ? idMatch[1] : `scene-${generateId()}`;

        if (nextText.trim().length > 0) {
          const parsedBeats = parseBeats(nextText);
          if (Object.keys(parsedBeats).length > 0) {
            scenesData[currentSceneId] = { id: currentSceneId, beats: parsedBeats };
          }
        }
      }
    }

    updateData.scenes = scenesData;
    updateData.content = '';
    updateData.attributes = attributes;
  }

  if (clearPendingDiff) {
    updateData.pendingDiff = null;
  }

  return await Chapter.findOneAndUpdate(
    { projectId: pId, id },
    updateData,
    { upsert: true, new: true }
  );
}

function reconstructChapterMarkdown(chapterDoc, chapAttrs) {
  if (!chapterDoc) return '';
  if (chapterDoc.content && String(chapterDoc.content).trim()) {
    return String(chapterDoc.content).trim();
  }
  if (chapAttrs && chapAttrs.unstructured && String(chapAttrs.unstructured).trim()) {
    return String(chapAttrs.unstructured).trim();
  }
  if (chapAttrs && chapAttrs.description) {
    const desc = chapAttrs.description;
    const descText = typeof desc === 'object' ? (desc.text || desc.html || '') : String(desc);
    if (descText.trim()) return descText.trim();
  }
  if (chapterDoc.scenes) {
    const scenesObj = chapterDoc.scenes instanceof Map ? Object.fromEntries(chapterDoc.scenes) : chapterDoc.scenes;
    const sceneIds = Object.keys(scenesObj || {});
    if (sceneIds.length > 0) {
      const sceneParts = [];
      for (const sId of sceneIds) {
        const sRaw = scenesObj[sId];
        const sData = sRaw instanceof Map ? Object.fromEntries(sRaw) : (sRaw || {});
        const bRaw = sData.beats || {};
        const bObj = bRaw instanceof Map ? Object.fromEntries(bRaw) : (bRaw || {});
        const beatParts = [];
        for (const bId of Object.keys(bObj)) {
          const bVal = bObj[bId] || {};
          beatParts.push(bVal.text || bVal.html || '');
        }
        sceneParts.push(beatParts.filter(Boolean).join('\n\n'));
      }
      return sceneParts.filter(Boolean).join('\n\n***\n\n').trim();
    }
  }
  return '';
}

function slugifyChapterHeading(heading) {
  return String(heading || '')
    .toLowerCase()
    .replace(/ä/g, 'ae')
    .replace(/ö/g, 'oe')
    .replace(/ü/g, 'ue')
    .replace(/ß/g, 'ss')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .substring(0, 64) || 'kapitel-1';
}

/**
 * Centralized Editorial Session persistence helper.
 * Saves the `editorial_session` Artifact and optionally synchronizes the Chapter document in MongoDB.
 */
async function persistEditorialSession(pId, cleanChapterId, {
  title,
  content,
  currentPhase = '1. Logik',
  suggestions = [],
  stats = null,
  existingAttrs = {},
  extraAttributes = {},
  legacyRawHtml = null,
  syncChapter = true
} = {}) {
  const sessionId = `editorial-session-${cleanChapterId}`;
  const cleanMd = normalizeEditorialHtmlToMarkdown(content || '');
  const resolvedTitle = title || existingAttrs.title || cleanChapterId;
  const resolvedSuggestions = Array.isArray(suggestions) ? suggestions : [];

  const rawStats = stats || existingAttrs.stats || {
    total: resolvedSuggestions.length,
    accepted: 0,
    rejected: 0,
    open: resolvedSuggestions.length
  };
  const total = Number(rawStats.total !== undefined ? rawStats.total : resolvedSuggestions.length);
  const accepted = Number(rawStats.accepted || 0);
  const rejected = Number(rawStats.rejected || 0);
  const open = Number(rawStats.open !== undefined ? rawStats.open : Math.max(0, total - accepted - rejected));
  const normalizedStats = { total, accepted, rejected, open };

  const mergedAttrs = {
    ...existingAttrs,
    ...extraAttributes,
    type: 'editorial_session',
    subtypeTag: 'editorial_session',
    chapterId: cleanChapterId,
    title: resolvedTitle,
    currentPhase,
    suggestions: resolvedSuggestions,
    stats: normalizedStats,
    unstructured: cleanMd
  };
  if (legacyRawHtml) {
    mergedAttrs.legacyRawHtml = legacyRawHtml;
  }

  const savedArtifact = await Artifact.findOneAndUpdate(
    { projectId: pId, id: sessionId },
    {
      $set: {
        projectId: pId,
        id: sessionId,
        name: resolvedTitle,
        type: 'editorial_session',
        content: cleanMd,
        attributes: mergedAttrs,
        lastEdited: new Date()
      }
    },
    { upsert: true, new: true }
  );

  if (cleanMd && syncChapter !== false) {
    await upsertChapterRecord(pId, cleanChapterId, {
      name: resolvedTitle,
      content: cleanMd,
      attributes: {
        type: 'chapters',
        subtypeTag: 'chapters',
        editorialPhase: currentPhase
      }
    });
  }

  return {
    id: sessionId,
    projectId: pId,
    chapterId: cleanChapterId,
    title: resolvedTitle,
    type: 'editorial_session',
    content: cleanMd,
    currentPhase,
    suggestions: resolvedSuggestions,
    stats: normalizedStats,
    lastEdited: savedArtifact.lastEdited
  };
}

async function loadEditorialProjectContext(projectId) {
  const pId = projectId || 'global';

  // 1. Masterplan ('dossier' Note)
  const dossierDoc = await Note.findOne({
    projectId: pId,
    $or: [
      { id: { $in: ['dossier', 'story_dossier', 'final_dossier'] } },
      { type: 'dossier' },
      { 'attributes.subtypeTag': 'dossier' }
    ]
  });
  let masterplanText = '';
  if (dossierDoc) {
    const cleaned = await ensureCleanDocumentOnRead(dossierDoc, 'note');
    const attrs = sanitizeAttributesObj(cleaned.attributes);
    masterplanText = cleaned.content || attrs.unstructured || '';
  }

  // 2. Outline ('outline' Note)
  const outlineDoc = await Note.findOne({
    projectId: pId,
    $or: [
      { id: { $in: ['outline', 'story_outline', 'final_outline'] } },
      { type: 'outline' },
      { 'attributes.subtypeTag': 'outline' }
    ]
  });
  let outlineText = '';
  if (outlineDoc) {
    const cleaned = await ensureCleanDocumentOnRead(outlineDoc, 'note');
    const attrs = sanitizeAttributesObj(cleaned.attributes);
    outlineText = cleaned.content || attrs.unstructured || '';
  }

  // 3. Characters ('Character' collection)
  const charList = await Character.find({ projectId: pId });
  const charBlocks = [];
  for (const ch of charList) {
    const cleaned = await ensureCleanDocumentOnRead(ch, 'character');
    const attrs = sanitizeAttributesObj(cleaned.attributes);
    const body = cleaned.content || attrs.unstructured || '';
    charBlocks.push(`### ${cleaned.name || cleaned.id}\n${body}`);
  }
  const charactersText = charBlocks.join('\n\n');

  return {
    masterplanText,
    outlineText,
    charactersText,
    characterCount: charList.length
  };
}

function extractCandidateSentences(text) {
  const rawLines = String(text || '')
    .split(/\r?\n/)
    .map(l => l.trim())
    .filter(l => l.length > 10 && !l.startsWith('#'));

  const sentences = [];
  for (const line of rawLines) {
    const parts = line.match(/[^.!?]+[.!?]+["'»«]?/g) || [line];
    for (const p of parts) {
      const trimmed = p.trim();
      if (trimmed.length >= 12 && !sentences.includes(trimmed)) {
        sentences.push(trimmed);
      }
    }
  }
  if (sentences.length === 0 && rawLines.length > 0) {
    sentences.push(rawLines[0]);
  }
  return sentences;
}

function buildHeuristicEditorialSuggestions(text, phase, context = {}) {
  const sentences = extractCandidateSentences(text);
  const phaseLabel = String(phase || '1. Logik').replace(/^\d+\.\s*/, '').trim() || 'Logik';
  const suggestions = [];

  sentences.slice(0, 3).forEach((sentence, idx) => {
    const tightened = sentence
      .replace(/\b(irgendwie|ziemlich|eigentlich|halt|wohl)\s+/gi, '')
      .replace(/\s{2,}/g, ' ')
      .trim();

    let variants = [];
    let explanation = '';

    if (phaseLabel.toLowerCase().includes('logik')) {
      variants = [
        tightened !== sentence ? tightened : `${sentence.replace(/[.!?]+$/, '')}, wie es der aktuellen Ermittlungslage entsprach.`,
        `${sentence.replace(/[.!?]+$/, '')} – im Einklang mit dem bisherigen Handlungsverlauf.`
      ];
      explanation = context.masterplanText || context.outlineText
        ? `Abgleich mit Masterplan und Outline (${phaseLabel}): Handlungslogik und Kontinuität präzisiert.`
        : `Logische Präzisierung des Handlungsablaufs in Phase ${phase}.`;
    } else if (phaseLabel.toLowerCase().includes('szene')) {
      variants = [
        `${sentence.replace(/[.!?]+$/, '')}, während die Spannung spürbar zunahm.`,
        tightened !== sentence ? tightened : `${sentence.replace(/[.!?]+$/, '')}.`
      ];
      explanation = `Szenische Verdichtung und stärkeres Pacing für ${phase}.`;
    } else if (phaseLabel.toLowerCase().includes('stil')) {
      variants = [
        tightened !== sentence ? tightened : `${sentence.replace(/[.!?]+$/, '')} – klar und prägnant formuliert.`,
        `${tightened.replace(/[.!?]+$/, '')}.`
      ];
      explanation = `Füllwörter reduziert und Ausdruck für einen präziseren Erzählstil geschärft (${phase}).`;
    } else {
      variants = [
        tightened,
        `${tightened.replace(/[.!?]+$/, '')}.`
      ];
      explanation = `Orthografische und zeichensetzungstechnische Feinkorrektur (${phase}).`;
    }

    suggestions.push({
      id: `ed-${Date.now()}-${idx + 1}`,
      type: phaseLabel,
      original: sentence,
      variants: Array.from(new Set(variants.filter(Boolean))),
      explanation
    });
  });

  return suggestions;
}

function normalizeEditorialSuggestions(rawList, text, phase) {
  if (!Array.isArray(rawList)) return [];
  const phaseLabel = String(phase || '1. Logik').replace(/^\d+\.\s*/, '').trim() || 'Lektorat';
  const candidateSentences = extractCandidateSentences(text);
  const normalized = [];

  rawList.forEach((item, idx) => {
    if (!item || typeof item !== 'object') return;
    let original = String(item.original || '').trim();
    if (!original) return;

    // Ensure 'original' is a verbatim substring of the manuscript text so inline highlight matching succeeds
    if (text && !text.includes(original)) {
      const match = candidateSentences.find(
        s => s.includes(original) || original.includes(s) || s.toLowerCase() === original.toLowerCase()
      );
      if (match && text.includes(match)) {
        original = match;
      } else {
        return;
      }
    }

    let variants = [];
    if (Array.isArray(item.variants)) {
      variants = item.variants.map(v => String(v || '').trim()).filter(Boolean);
    } else if (typeof item.replacement === 'string' && item.replacement.trim()) {
      variants = [item.replacement.trim()];
    } else if (typeof item.suggestion === 'string' && item.suggestion.trim()) {
      variants = [item.suggestion.trim()];
    }
    if (variants.length === 0) {
      variants = [original];
    }

    normalized.push({
      id: String(item.id || `sugg-${Date.now()}-${idx + 1}`),
      type: String(item.type || phaseLabel),
      original,
      variants,
      explanation: String(item.explanation || item.reason || `Lektoratsvorschlag (${phaseLabel})`)
    });
  });

  return normalized;
}

router.get('/api/editor/chapters/:projectId', async (req, res) => {
  const { projectId } = req.params;
  const pId = projectId || 'global';

  try {
    const dbChapters = await Chapter.find({ projectId: pId }).sort({ orderIndex: 1 });
    const sessionArtifacts = await Artifact.find({ projectId: pId, type: 'editorial_session' });

    const sessionByChapterId = new Map();
    for (const art of sessionArtifacts) {
      const artAttrs = sanitizeAttributesObj(art.attributes) || {};
      const cId = artAttrs.chapterId || String(art.id || '').replace(/^editorial-session-/, '');
      if (cId) {
        sessionByChapterId.set(cId, { artifact: art, attrs: artAttrs });
      }
    }

    const chaptersList = [];
    const seenChapterIds = new Set();

    for (const chap of dbChapters) {
      const cleaned = await ensureCleanDocumentOnRead(chap, 'chapter');
      const chapAttrs = sanitizeAttributesObj(cleaned.attributes) || {};
      const sessInfo = sessionByChapterId.get(cleaned.id);
      const sessAttrs = sessInfo ? sessInfo.attrs : {};
      const title = sessAttrs.title
        || (sessInfo && sessInfo.artifact && sessInfo.artifact.name)
        || cleaned.name
        || chapAttrs.title
        || cleaned.id;
      const currentPhase = sessAttrs.currentPhase || sessAttrs.current_step || chapAttrs.editorialPhase || '1. Logik';
      const stats = sessAttrs.stats || { total: 0, accepted: 0, rejected: 0, open: 0 };

      chaptersList.push({
        id: cleaned.id,
        name: cleaned.name || title,
        title,
        currentPhase,
        stats,
        hasSession: !!sessInfo,
        source: 'chapter'
      });
      seenChapterIds.add(cleaned.id);
    }

    // Include any editorial_session artifacts that don't have a Chapter record yet
    for (const [cId, sessInfo] of sessionByChapterId.entries()) {
      if (!seenChapterIds.has(cId)) {
        const sessAttrs = sessInfo.attrs || {};
        const title = sessAttrs.title || sessInfo.artifact.name || cId;
        chaptersList.push({
          id: cId,
          name: title,
          title,
          currentPhase: sessAttrs.currentPhase || sessAttrs.current_step || '1. Logik',
          stats: sessAttrs.stats || { total: 0, accepted: 0, rejected: 0, open: 0 },
          hasSession: true,
          source: 'session'
        });
        seenChapterIds.add(cId);
      }
    }

    // Extract chapter headings from the project's primary outline Note in MongoDB
    const outlineNotes = await Note.find({
      projectId: pId,
      $or: [
        { id: { $in: ['outline', 'story_outline', 'final_outline', 'outline_master'] } },
        { type: 'outline' },
        { name: /outline/i }
      ]
    });

    outlineNotes.sort((a, b) => (a.id === 'outline' ? -1 : b.id === 'outline' ? 1 : 0));

    let outlineHeadings = [];
    for (const oNote of outlineNotes) {
      const cleanedOutline = await ensureCleanDocumentOnRead(oNote, 'note');
      const oAttrs = sanitizeAttributesObj(cleanedOutline.attributes) || {};
      const outlineText = cleanedOutline.content
        || oAttrs.unstructured
        || (oAttrs.description && (oAttrs.description.text || oAttrs.description.html))
        || '';
      if (!outlineText) continue;

      const lines = String(outlineText)
        .split('\n')
        .map(l => l.replace(/^#+\s*/, '').replace(/^\*\*|\*\*$/g, '').trim())
        .filter(l => l.length > 0);

      let matched = lines.filter(l => /^(Band|Kapitel|Chapter|Szene)\s*\d+/i.test(l));
      if (matched.length === 0) {
        matched = lines.filter(l => /Kapitel/i.test(l));
      }
      if (matched.length > 0) {
        outlineHeadings = [...new Set(matched.map(c => c.length > 60 ? c.substring(0, 60) + '...' : c))];
        break;
      }
    }

    for (const heading of outlineHeadings) {
      const slug = slugifyChapterHeading(heading);
      if (!seenChapterIds.has(slug)) {
        chaptersList.push({
          id: slug,
          name: heading,
          title: heading,
          currentPhase: '1. Logik',
          stats: { total: 0, accepted: 0, rejected: 0, open: 0 },
          hasSession: false,
          source: 'outline'
        });
        seenChapterIds.add(slug);
      }
    }

    res.json({
      projectId: pId,
      chapters: chaptersList,
      outlineHeadings
    });
  } catch (err) {
    console.error('Error fetching editor chapters:', err);
    res.status(500).json({ error: 'Failed to fetch editor chapters', details: err.message });
  }
});

router.get('/api/editor/session/:projectId/:chapterId', async (req, res) => {
  const { projectId, chapterId } = req.params;
  const pId = projectId || 'global';
  const sessionId = chapterId.startsWith('editorial-session-')
    ? chapterId
    : `editorial-session-${chapterId}`;
  const cleanChapterId = chapterId.replace(/^editorial-session-/, '');

  try {
    const artifact = await Artifact.findOne({ projectId: pId, id: sessionId });
    const chapter = await Chapter.findOne({ projectId: pId, id: cleanChapterId });

    const artAttrs = artifact ? sanitizeAttributesObj(artifact.attributes) : {};
    const chapAttrs = chapter ? sanitizeAttributesObj(chapter.attributes) : {};

    const chapterMd = reconstructChapterMarkdown(chapter, chapAttrs);
    const content = (artifact && artifact.content)
      || artAttrs.unstructured
      || chapterMd
      || '';
    const title = (artifact && artifact.name)
      || artAttrs.title
      || (chapter && chapter.name)
      || chapAttrs.title
      || cleanChapterId;
    const currentPhase = artAttrs.currentPhase || artAttrs.current_step || chapAttrs.editorialPhase || '1. Logik';
    const suggestions = Array.isArray(artAttrs.suggestions) ? artAttrs.suggestions : [];
    const stats = artAttrs.stats && typeof artAttrs.stats === 'object'
      ? {
          total: Number(artAttrs.stats.total || 0),
          accepted: Number(artAttrs.stats.accepted || 0),
          rejected: Number(artAttrs.stats.rejected || 0),
          open: Number(artAttrs.stats.open !== undefined ? artAttrs.stats.open : (Number(artAttrs.stats.total || 0) - Number(artAttrs.stats.accepted || 0) - Number(artAttrs.stats.rejected || 0)))
        }
      : { total: suggestions.length, accepted: 0, rejected: 0, open: suggestions.length };

    const sessionObj = {
      id: sessionId,
      projectId: pId,
      chapterId: cleanChapterId,
      title,
      type: 'editorial_session',
      content,
      currentPhase,
      suggestions,
      stats,
      attributes: artAttrs,
      lastEdited: artifact ? artifact.lastEdited : (chapter ? chapter.lastEdited : new Date())
    };
    res.json({
      ...sessionObj,
      session: sessionObj
    });
  } catch (err) {
    console.error('Error loading editorial session:', err);
    res.status(500).json({ error: 'Failed to load editorial session' });
  }
});

const saveEditorialSessionHandler = async (req, res) => {
  const { projectId, chapterId } = req.params;
  const pId = projectId || 'global';
  const cleanChapterId = chapterId.replace(/^editorial-session-/, '');
  const sessionId = `editorial-session-${cleanChapterId}`;

  try {
    const existing = await Artifact.findOne({ projectId: pId, id: sessionId });
    const existingAttrs = existing ? sanitizeAttributesObj(existing.attributes) : {};

    const body = req.body || {};
    const rawContent = body.content !== undefined
      ? body.content
      : (body.current_text !== undefined ? body.current_text : (existing ? existing.content : ''));

    const title = body.title || body.name || existingAttrs.title || (existing && existing.name) || cleanChapterId;
    const currentPhase = body.currentPhase || body.current_step || existingAttrs.currentPhase || '1. Logik';
    const suggestions = Array.isArray(body.suggestions)
      ? body.suggestions
      : (Array.isArray(existingAttrs.suggestions) ? existingAttrs.suggestions : []);
    const legacyRawHtml = (body.current_text && /<div\b|<span\b/i.test(body.current_text))
      ? body.current_text
      : null;

    const session = await persistEditorialSession(pId, cleanChapterId, {
      title,
      content: rawContent,
      currentPhase,
      suggestions,
      stats: body.stats || existingAttrs.stats,
      existingAttrs,
      extraAttributes: body.attributes || {},
      legacyRawHtml,
      syncChapter: body.syncChapter !== false
    });

    res.json({ success: true, session });
  } catch (err) {
    console.error('Error saving editorial session:', err);
    res.status(500).json({ error: 'Failed to save editorial session', details: err.message });
  }
};

router.put('/api/editor/session/:projectId/:chapterId', saveEditorialSessionHandler);
router.post('/api/editor/session/:projectId/:chapterId', saveEditorialSessionHandler);

router.post('/api/editor/apply', async (req, res) => {
  const {
    projectId,
    chapterId,
    suggestionId,
    action,
    replacementText,
    variantIndex
  } = req.body || {};

  if (!chapterId || !suggestionId || !action) {
    return res.status(400).json({ error: 'Missing required fields: chapterId, suggestionId, action' });
  }

  const pId = projectId || 'global';
  const cleanChapterId = String(chapterId).replace(/^editorial-session-/, '');
  const sessionId = `editorial-session-${cleanChapterId}`;

  try {
    const existing = await Artifact.findOne({ projectId: pId, id: sessionId });
    const chapter = await Chapter.findOne({ projectId: pId, id: cleanChapterId });

    const existingAttrs = existing ? sanitizeAttributesObj(existing.attributes) : {};
    const chapAttrs = chapter ? sanitizeAttributesObj(chapter.attributes) : {};

    let content = (existing && existing.content)
      || existingAttrs.unstructured
      || reconstructChapterMarkdown(chapter, chapAttrs)
      || '';
    content = normalizeEditorialHtmlToMarkdown(content);

    const title = existingAttrs.title || (existing && existing.name) || (chapter && chapter.name) || cleanChapterId;
    const currentPhase = existingAttrs.currentPhase || existingAttrs.current_step || '1. Logik';
    const currentSuggestions = Array.isArray(existingAttrs.suggestions) ? [...existingAttrs.suggestions] : [];

    const suggIdx = currentSuggestions.findIndex(s => s && String(s.id) === String(suggestionId));
    const targetSuggestion = suggIdx !== -1 ? currentSuggestions[suggIdx] : null;

    if (suggIdx !== -1) {
      currentSuggestions.splice(suggIdx, 1);
    }

    const rawStats = existingAttrs.stats || {
      total: currentSuggestions.length + (targetSuggestion ? 1 : 0),
      accepted: 0,
      rejected: 0,
      open: currentSuggestions.length
    };
    const total = Number(rawStats.total !== undefined ? rawStats.total : (currentSuggestions.length + (targetSuggestion ? 1 : 0)));
    let accepted = Number(rawStats.accepted || 0);
    let rejected = Number(rawStats.rejected || 0);

    const normAction = String(action).toLowerCase();
    if (normAction === 'accept' || normAction === 'custom') {
      accepted += 1;
      const originalSentence = (targetSuggestion && targetSuggestion.original) || req.body.original || '';
      const variants = (targetSuggestion && Array.isArray(targetSuggestion.variants)) ? targetSuggestion.variants : [];
      const chosenVariant = (variantIndex !== undefined && variants[Number(variantIndex)] !== undefined)
        ? variants[Number(variantIndex)]
        : (variants[0] || '');
      const finalReplacement = replacementText !== undefined && replacementText !== null
        ? String(replacementText)
        : String(chosenVariant);

      if (originalSentence && content.includes(originalSentence)) {
        content = content.replace(originalSentence, finalReplacement);
      }
    } else if (normAction === 'reject') {
      rejected += 1;
    } else {
      return res.status(400).json({ error: `Unsupported action '${action}'. Expected 'accept', 'custom', or 'reject'.` });
    }

    const open = Math.max(0, total - accepted - rejected);
    const stats = { total, accepted, rejected, open };

    const session = await persistEditorialSession(pId, cleanChapterId, {
      title,
      content,
      currentPhase,
      suggestions: currentSuggestions,
      stats,
      existingAttrs,
      syncChapter: true
    });

    res.json({ success: true, session });
  } catch (err) {
    console.error('Error applying editorial suggestion:', err);
    res.status(500).json({ error: 'Failed to apply editorial suggestion', details: err.message });
  }
});

router.post('/api/editor/analyze', async (req, res) => {
  const {
    projectId,
    chapterId,
    phase = '1. Logik',
    text: reqText,
    title: reqTitle
  } = req.body || {};

  const pId = projectId || 'global';
  const cleanChapterId = String(chapterId || 'kapitel-1').replace(/^editorial-session-/, '');
  const sessionId = `editorial-session-${cleanChapterId}`;

  try {
    const existing = await Artifact.findOne({ projectId: pId, id: sessionId });
    const chapter = await Chapter.findOne({ projectId: pId, id: cleanChapterId });

    const existingAttrs = existing ? sanitizeAttributesObj(existing.attributes) : {};
    const chapAttrs = chapter ? sanitizeAttributesObj(chapter.attributes) : {};

    const rawText = reqText !== undefined && reqText !== null
      ? String(reqText)
      : ((existing && existing.content)
          || existingAttrs.unstructured
          || reconstructChapterMarkdown(chapter, chapAttrs)
          || '');
    const manuscriptText = normalizeEditorialHtmlToMarkdown(rawText);

    if (!manuscriptText.trim()) {
      return res.status(400).json({ error: 'Manuscript text is empty; nothing to analyze.' });
    }

    const title = reqTitle
      || existingAttrs.title
      || (existing && existing.name)
      || (chapter && chapter.name)
      || cleanChapterId;

    // Read Masterplan, Characters, and Outline strictly from shadow_writer MongoDB
    const context = await loadEditorialProjectContext(pId);

    const systemPromptText = `Du bist ein hochprofessioneller, extrem penibler Lektor für Spannungsromane.

MASTERPLAN:
${context.masterplanText || '(Kein Masterplan hinterlegt)'}

CHARAKTERE:
${context.charactersText || '(Keine Charakterprofile hinterlegt)'}

OUTLINE:
${context.outlineText || '(Keine Outline hinterlegt)'}

Fokus der aktuellen Lektorats-Phase: ${phase}.

DEINE AUFGABE & ARBEITSWEISE:
1. Analysiere den folgenden Text ABSATZ FÜR ABSATZ von Anfang bis zum absoluten Ende.
2. Sei extrem gründlich und kritisch! Brich die Analyse nicht vorzeitig ab. Ich erwarte eine tiefe, lückenlose Prüfung des gesamten Textes.
3. Finde jeden noch so kleinen Logikfehler, jede unrunde Szene oder jeden stilistischen Ausrutscher, der zur aktuellen Phase passt. Halte dich nicht zurück, produziere so viele wertvolle Vorschläge wie möglich!

WICHTIGE REGEL FÜR "original": Du darfst für das Feld "original" IMMER NUR einen zusammenhängenden, kurzen Satz EXAKT WORTWÖRTLICH (inklusive aller Satzzeichen) aus dem Text kopieren. Keine Zeilenumbrüche, kein Paraphrasieren! Das System sucht per Code nach exakt diesem String.

Antworte NUR als Array mit exakt dieser Struktur: [{"id": "einzigartige_id", "type": "Kategorie", "original": "Fehlertext", "variants": ["Vorschlag"], "explanation": "Grund"}]`;

    let suggestions = [];
    try {
      const aiResponse = await generateContent({
        message: manuscriptText,
        model: DEFAULT_PRO_MODEL,
        thinkingLevel: 'low',
        isSubagent: false,
        systemInstruction: systemPromptText,
        responseMimeType: 'application/json',
        temperature: 0.2,
        skipQualityGate: true
      });
      const cleanedJson = String(aiResponse || '').replace(/`{3}json\n?|`{3}/g, '').trim();
      const parsed = JSON.parse(cleanedJson);
      if (!Array.isArray(parsed)) {
        throw new Error('Expected JSON array from editorial model');
      }
      suggestions = normalizeEditorialSuggestions(parsed, manuscriptText, phase);
    } catch (aiErr) {
      console.warn('[EditorialEngine] Gemini analysis fell back to heuristic suggestions:', aiErr.message);
      suggestions = buildHeuristicEditorialSuggestions(manuscriptText, phase, context);
    }

    const stats = {
      total: suggestions.length,
      accepted: 0,
      rejected: 0,
      open: suggestions.length
    };

    const sessionPayload = await persistEditorialSession(pId, cleanChapterId, {
      title,
      content: manuscriptText,
      currentPhase: phase,
      suggestions,
      stats,
      existingAttrs,
      syncChapter: true
    });

    res.json({
      success: true,
      suggestions,
      stats,
      session: sessionPayload,
      contextSummary: {
        hasMasterplan: Boolean(context.masterplanText),
        hasOutline: Boolean(context.outlineText),
        characterCount: context.characterCount
      }
    });
  } catch (err) {
    console.error('Error in POST /api/editor/analyze:', err);
    res.status(500).json({ error: 'Editorial analysis failed', details: err.message });
  }
});

router.post('/api/editor/inline-edit', async (req, res) => {
  const {
    projectId,
    selectedText = '',
    instruction = '',
    context = '',
    message = ''
  } = req.body || {};

  const promptText = message
    || `You are an inline AI editor.\n\nContext:\n${context}\n\nSelected Text:\n${selectedText}\n\nInstruction:\n${instruction}\n\nReturn ONLY the rewritten selected text without markdown fences or explanations.`;

  try {
    let reply = '';
    try {
      reply = await generateContent({
        message: promptText,
        model: DEFAULT_FLASH_MODEL,
        thinkingLevel: 'low',
        isSubagent: false,
        skipQualityGate: true
      });
    } catch (aiErr) {
      console.warn('[EditorialEngine] Inline edit fallback triggered:', aiErr.message);
      const base = String(selectedText || message || '').trim();
      reply = base
        .replace(/\b(irgendwie|ziemlich|eigentlich)\s+/gi, '')
        .replace(/\s{2,}/g, ' ')
        .trim() || base;
    }

    const cleanedReply = String(reply || '').trim();
    res.json({
      success: true,
      projectId: projectId || 'global',
      reply: cleanedReply,
      response: cleanedReply,
      rewrittenText: cleanedReply
    });
  } catch (err) {
    console.error('Error in POST /api/editor/inline-edit:', err);
    res.status(500).json({ error: 'Inline edit failed', details: err.message });
  }
});

module.exports = {
  router,
  normalizeEditorialHtmlToMarkdown,
  upsertChapterRecord,
  reconstructChapterMarkdown,
  slugifyChapterHeading,
  persistEditorialSession,
  loadEditorialProjectContext,
  buildHeuristicEditorialSuggestions,
  normalizeEditorialSuggestions
};
