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
  constructMarkdownFromAttributes,
  toStructuredAttrObject,
  normalizeAttributesToStructuredObjects,
  extractString
} = require('./mongoDB');
const {
  generateContent,
  DEFAULT_FLASH_MODEL,
  DEFAULT_PRO_MODEL
} = require('./geminiClient');

const router = express.Router();

function stripEditorialHtmlToPlainText(rawInput) {
  if (!rawInput || typeof rawInput !== 'string') return '';
  let s = rawInput.replace(/\r\n/g, '\n').trim();
  if (!s) return '';

  if (/<div\b|<br\b|<span\b|<p\b|<hr\b/i.test(s)) {
    s = s.replace(/<span[^>]*class=["']?[^"'>]*(?:issue-highlight|accepted-flash)[^"'>]*["']?[^>]*>([\s\S]*?)<\/span>/gi, '$1');
    s = s.replace(/<hr\b[^>]*>/gi, '\n\n');
    s = s.replace(/<div>\s*<br\s*\/?>\s*<\/div>/gi, '\n\n');
    s = s.replace(/<br\s*\/?>/gi, '\n');
    s = s.replace(/<\/div>\s*<div[^>]*>/gi, '\n');
    s = s.replace(/<\/p>\s*<p[^>]*>/gi, '\n\n');
    s = s.replace(/<\/?(?:div|p|span)[^>]*>/gi, '');
    s = s.replace(/&nbsp;/gi, ' ')
         .replace(/&amp;/gi, '&')
         .replace(/&lt;/gi, '<')
         .replace(/&gt;/gi, '>')
         .replace(/&quot;/gi, '"');
  }
  return s.replace(/\n{3,}/g, '\n\n').trim();
}

function parseStructuredEditorialInput(rawInput, existingScenes = null) {
  if (rawInput && typeof rawInput === 'object' && !Array.isArray(rawInput)) {
    if (rawInput.manuscript || rawInput.scenes) {
      const mObj = toStructuredAttrObject(rawInput.manuscript || rawInput.text || rawInput.html || '');
      const sObj = (rawInput.scenes && typeof rawInput.scenes === 'object') ? rawInput.scenes : {};
      const sceneAttrs = {};
      for (const [sKey, sVal] of Object.entries(sObj)) {
        if (sVal && typeof sVal === 'object' && sVal.beats) {
          const beatTexts = Object.values(sVal.beats).map(b => (b && (b.text || b.html)) || '').filter(Boolean);
          const joined = beatTexts.join('\n\n');
          sceneAttrs[sKey] = toStructuredAttrObject(joined);
        }
      }
      if (Object.keys(sObj).length > 0) {
        return { manuscript: mObj, scenes: sObj, sceneAttributes: sceneAttrs };
      }
      return parseStructuredEditorialInput(mObj.text || mObj.html || '', existingScenes);
    }
    rawInput = rawInput.text || rawInput.html || '';
  }

  let plain = stripEditorialHtmlToPlainText(String(rawInput || ''));
  if (!plain && existingScenes && typeof existingScenes === 'object' && Object.keys(existingScenes).length > 0) {
    const scenesPlain = existingScenes instanceof Map ? Object.fromEntries(existingScenes) : existingScenes;
    const allSceneTexts = [];
    const sceneAttributes = {};
    for (const [sId, sRaw] of Object.entries(scenesPlain)) {
      const sData = sRaw instanceof Map ? Object.fromEntries(sRaw) : (sRaw || {});
      const bObj = sData.beats instanceof Map ? Object.fromEntries(sData.beats) : (sData.beats || {});
      const beatTexts = Object.values(bObj).map(b => (b && (b.text || b.html)) || '').filter(Boolean);
      const joined = beatTexts.join('\n\n');
      if (joined) {
        allSceneTexts.push(joined);
        sceneAttributes[sId] = toStructuredAttrObject(joined);
      }
    }
    const fullText = allSceneTexts.join('\n\n');
    return {
      manuscript: toStructuredAttrObject(fullText),
      scenes: scenesPlain,
      sceneAttributes
    };
  }

  // Parse scenes & beats without keeping Markdown # headings or *** dividers in prose
  const lines = plain.split('\n');
  const rawScenes = [];
  let currentTitle = 'Scene 1';
  let currentLines = [];

  for (const line of lines) {
    const trimmed = line.trim();
    if (/^(?:\*\*\*|---|_{3,})$/.test(trimmed)) {
      if (currentLines.join('\n').trim()) {
        rawScenes.push({ title: currentTitle, body: currentLines.join('\n').trim() });
        currentLines = [];
        currentTitle = `Scene ${rawScenes.length + 1}`;
      }
      continue;
    }
    const sceneMatch = trimmed.match(/^(?:#+\s*)?((?:Scene|Szene)\s*\d+\b.*)$/i);
    if (sceneMatch) {
      if (currentLines.join('\n').trim()) {
        rawScenes.push({ title: currentTitle, body: currentLines.join('\n').trim() });
        currentLines = [];
      }
      currentTitle = sceneMatch[1].replace(/^#+\s*/, '').trim();
      continue;
    }
    // Strip leading Chapter H1/H2 if duplicated at very top of prose
    if (rawScenes.length === 0 && currentLines.length === 0 && /^#+\s*(?:Kapitel|Chapter)\s*\d+/i.test(trimmed)) {
      continue;
    }
    currentLines.push(line);
  }
  if (currentLines.join('\n').trim()) {
    rawScenes.push({ title: currentTitle, body: currentLines.join('\n').trim() });
  }

  const scenes = {};
  const sceneAttributes = {};
  const sceneProseBlocks = [];

  rawScenes.forEach((sc, idx) => {
    const sceneKey = `scene_${idx + 1}`;
    const bodyText = sc.body.trim();
    if (!bodyText) return;
    const paragraphs = bodyText.split(/\n\s*\n/).map(p => p.trim()).filter(Boolean);
    const beats = {};
    paragraphs.forEach((p, bIdx) => {
      const beatKey = `beat_${bIdx + 1}`;
      beats[beatKey] = { id: beatKey, text: p, html: p };
    });
    if (Object.keys(beats).length === 0) {
      beats.beat_1 = { id: 'beat_1', text: bodyText, html: bodyText };
    }
    scenes[sceneKey] = {
      id: sceneKey,
      title: sc.title || `Scene ${idx + 1}`,
      beats
    };
    sceneAttributes[sceneKey] = toStructuredAttrObject(bodyText);
    sceneProseBlocks.push(bodyText);
  });

  const cleanManuscriptText = sceneProseBlocks.join('\n\n').trim();
  return {
    manuscript: toStructuredAttrObject(cleanManuscriptText),
    scenes,
    sceneAttributes
  };
}

function normalizeEditorialHtmlToMarkdown(rawInput) {
  const parsed = parseStructuredEditorialInput(rawInput);
  return parsed.manuscript.text;
}

async function upsertChapterRecord(pId, id, { name, content, manuscript, scenes: reqScenes, attributes: reqAttributes, clearPendingDiff } = {}) {
  const match = String(id).match(/\d+/);
  const orderIndex = match ? parseInt(match[0], 10) : 999;

  const updateData = { orderIndex, lastEdited: new Date() };

  if (name || (reqAttributes && reqAttributes.name)) {
    updateData.name = extractString(name || reqAttributes.name);
  }

  const rawProseSource = manuscript || content || (reqAttributes && (reqAttributes.description || reqAttributes.manuscript));
  if (rawProseSource || (reqScenes && Object.keys(reqScenes).length > 0) || (reqAttributes && Object.keys(reqAttributes).length > 0)) {
    const parsed = parseStructuredEditorialInput(rawProseSource || '', reqScenes);
    const mergedRawAttrs = {
      ...(reqAttributes || {}),
      ...parsed.sceneAttributes
    };
    if (parsed.manuscript && parsed.manuscript.text) {
      mergedRawAttrs.description = parsed.manuscript;
    }
    if (reqAttributes && reqAttributes.name && !updateData.name) {
      updateData.name = extractString(reqAttributes.name);
    }

    const structuredAttrs = normalizeAttributesToStructuredObjects(mergedRawAttrs, 'chapters');
    structuredAttrs.type = 'chapters';
    structuredAttrs.subtypeTag = 'chapters';

    if (Object.keys(parsed.scenes).length > 0) {
      updateData.scenes = parsed.scenes;
    }
    updateData.content = '';
    updateData.attributes = structuredAttrs;
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

function reconstructChapterProse(chapterDoc, chapAttrs, { asMarkdown = false } = {}) {
  if (!chapterDoc && !chapAttrs) return '';
  if (chapterDoc && chapterDoc.scenes) {
    const scenesObj = chapterDoc.scenes instanceof Map ? Object.fromEntries(chapterDoc.scenes) : chapterDoc.scenes;
    const sceneIds = Object.keys(scenesObj || {});
    if (sceneIds.length > 0) {
      const sceneParts = [];
      sceneIds.forEach((sId, idx) => {
        const sRaw = scenesObj[sId];
        const sData = sRaw instanceof Map ? Object.fromEntries(sRaw) : (sRaw || {});
        const bRaw = sData.beats || {};
        const bObj = bRaw instanceof Map ? Object.fromEntries(bRaw) : (bRaw || {});
        const beatParts = [];
        for (const bId of Object.keys(bObj)) {
          const bVal = bObj[bId] || {};
          beatParts.push(bVal.text || bVal.html || '');
        }
        const joinedBeats = beatParts.filter(Boolean).join('\n\n');
        if (!joinedBeats) return;
        if (asMarkdown) {
          const sTitle = sData.title || `Scene ${idx + 1}`;
          sceneParts.push(`## ${sTitle}\n\n${joinedBeats}`);
        } else {
          sceneParts.push(joinedBeats);
        }
      });
      return sceneParts.filter(Boolean).join(asMarkdown ? '\n\n***\n\n' : '\n\n').trim();
    }
  }
  if (chapAttrs && chapAttrs.description) {
    const descText = extractString(chapAttrs.description).trim();
    if (descText) return descText;
  }
  if (chapterDoc && chapterDoc.content && String(chapterDoc.content).trim()) {
    return stripEditorialHtmlToPlainText(String(chapterDoc.content));
  }
  return '';
}

function reconstructChapterMarkdown(chapterDoc, chapAttrs) {
  return reconstructChapterProse(chapterDoc, chapAttrs, { asMarkdown: false });
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
  manuscript: reqManuscript,
  scenes: reqScenes,
  currentPhase = '1. Logik',
  suggestions = [],
  stats = null,
  existingAttrs = {},
  extraAttributes = {},
  syncChapter = true
} = {}) {
  const sessionId = `editorial-session-${cleanChapterId}`;
  const rawInput = reqManuscript || content || existingAttrs.manuscript || '';
  const parsed = parseStructuredEditorialInput(rawInput, reqScenes || existingAttrs.scenes);
  const cleanProse = parsed.manuscript.text;
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

  const cleanedExisting = { ...existingAttrs };
  delete cleanedExisting.unstructured;
  delete cleanedExisting.legacyRawHtml;

  const cleanedExtra = { ...extraAttributes };
  delete cleanedExtra.unstructured;
  delete cleanedExtra.legacyRawHtml;

  const mergedAttrs = {
    ...cleanedExisting,
    ...cleanedExtra,
    type: 'editorial_session',
    subtypeTag: 'editorial_session',
    chapterId: cleanChapterId,
    title: resolvedTitle,
    currentPhase,
    suggestions: resolvedSuggestions,
    stats: normalizedStats,
    manuscript: parsed.manuscript,
    scenes: parsed.scenes
  };

  const savedArtifact = await Artifact.findOneAndUpdate(
    { projectId: pId, id: sessionId },
    {
      $set: {
        projectId: pId,
        id: sessionId,
        name: resolvedTitle,
        type: 'editorial_session',
        content: '',
        attributes: mergedAttrs,
        lastEdited: new Date()
      }
    },
    { upsert: true, new: true }
  );

  if (cleanProse && syncChapter !== false) {
    await upsertChapterRecord(pId, cleanChapterId, {
      name: resolvedTitle,
      manuscript: parsed.manuscript,
      scenes: parsed.scenes,
      attributes: {
        type: 'chapters',
        subtypeTag: 'chapters',
        editorialPhase: currentPhase,
        description: parsed.manuscript,
        ...parsed.sceneAttributes
      }
    });
  }

  return {
    id: sessionId,
    projectId: pId,
    chapterId: cleanChapterId,
    title: resolvedTitle,
    type: 'editorial_session',
    content: cleanProse,
    manuscript: parsed.manuscript,
    scenes: parsed.scenes,
    currentPhase,
    suggestions: resolvedSuggestions,
    stats: normalizedStats,
    attributes: mergedAttrs,
    lastEdited: savedArtifact.lastEdited
  };
}

function extractNoteFullText(doc, attrs) {
  if (!doc && !attrs) return '';
  const a = attrs || (doc ? sanitizeAttributesObj(doc.attributes) : {});
  const constructed = constructMarkdownFromAttributes(doc ? (doc.name || doc.id) : 'Document', doc ? doc.type : a.type, a);
  if (constructed) return constructed;
  const parts = [];
  for (const [k, v] of Object.entries(a)) {
    if (['type', 'subtypeTag', 'sourceDriveDocId', 'editorialPhase', 'chapterId', 'title', 'currentPhase', 'suggestions', 'stats', 'scenes'].includes(k)) continue;
    const s = extractString(v).trim();
    if (s) parts.push(s);
  }
  if (parts.length > 0) return parts.join('\n\n');
  return (doc && doc.content) || '';
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
    masterplanText = extractNoteFullText(cleaned, attrs);
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
    outlineText = extractNoteFullText(cleaned, attrs);
  }

  // 3. Characters ('Character' collection)
  const charList = await Character.find({ projectId: pId });
  const charBlocks = [];
  for (const ch of charList) {
    const cleaned = await ensureCleanDocumentOnRead(ch, 'character');
    const attrs = sanitizeAttributesObj(cleaned.attributes);
    const body = extractNoteFullText(cleaned, attrs);
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
      const attrLines = [];
      for (const [k, v] of Object.entries(oAttrs)) {
        if (['type', 'subtypeTag', 'sourceDriveDocId'].includes(k)) continue;
        const valStr = extractString(v).trim();
        if (/^(kapitel|chapter|band)_\d+/i.test(k)) {
          const firstLine = (valStr.split('\n')[0] || '').trim();
          const numMatch = k.match(/\d+/);
          const prefix = numMatch ? `Kapitel ${numMatch[0]}` : k.replace(/_/g, ' ');
          if (/^(Kapitel|Chapter|Band)\s*\d+/i.test(firstLine)) {
            attrLines.push(firstLine);
          } else if (firstLine) {
            attrLines.push(`${prefix}: ${firstLine}`);
          } else {
            attrLines.push(prefix);
          }
        }
        if (valStr) {
          attrLines.push(valStr);
        }
      }
      const outlineText = [cleanedOutline.content || '', ...attrLines].filter(Boolean).join('\n');
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

    const chapterProse = reconstructChapterProse(chapter, chapAttrs, { asMarkdown: false });
    const artManuscriptText = extractString(artAttrs.manuscript).trim();
    const rawContent = artManuscriptText
      || chapterProse
      || (artifact && artifact.content)
      || '';
    const existingScenes = artAttrs.scenes
      || (chapter && chapter.scenes ? (chapter.scenes instanceof Map ? Object.fromEntries(chapter.scenes) : chapter.scenes) : null);
    const parsed = parseStructuredEditorialInput(rawContent, existingScenes);

    const title = (artifact && artifact.name)
      || artAttrs.title
      || (chapter && chapter.name)
      || extractString(chapAttrs.title)
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

    const cleanArtAttrs = {
      ...artAttrs,
      manuscript: parsed.manuscript,
      scenes: parsed.scenes
    };
    delete cleanArtAttrs.unstructured;
    delete cleanArtAttrs.legacyRawHtml;

    const sessionObj = {
      id: sessionId,
      projectId: pId,
      chapterId: cleanChapterId,
      title,
      type: 'editorial_session',
      content: parsed.manuscript.text,
      manuscript: parsed.manuscript,
      scenes: parsed.scenes,
      currentPhase,
      suggestions,
      stats,
      attributes: cleanArtAttrs,
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

router.get('/api/editor/export-markdown/:projectId/:chapterId', async (req, res) => {
  const { projectId, chapterId } = req.params;
  const pId = projectId || 'global';
  const cleanChapterId = chapterId.replace(/^editorial-session-/, '');

  try {
    const chapter = await Chapter.findOne({ projectId: pId, id: cleanChapterId });
    const chapAttrs = chapter ? sanitizeAttributesObj(chapter.attributes) : {};
    const title = (chapter && chapter.name) || cleanChapterId;
    const mdBody = reconstructChapterProse(chapter, chapAttrs, { asMarkdown: true });
    const fullMarkdown = `# ${title}\n\n${mdBody}`.trim();
    res.json({
      projectId: pId,
      chapterId: cleanChapterId,
      title,
      markdown: fullMarkdown
    });
  } catch (err) {
    console.error('Error exporting chapter markdown:', err);
    res.status(500).json({ error: 'Failed to export chapter markdown' });
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
    const rawContent = body.manuscript !== undefined
      ? body.manuscript
      : (body.content !== undefined
          ? body.content
          : (body.current_text !== undefined ? body.current_text : (existingAttrs.manuscript || (existing ? existing.content : ''))));

    const title = body.title || body.name || existingAttrs.title || (existing && existing.name) || cleanChapterId;
    const currentPhase = body.currentPhase || body.current_step || existingAttrs.currentPhase || '1. Logik';
    const suggestions = Array.isArray(body.suggestions)
      ? body.suggestions
      : (Array.isArray(existingAttrs.suggestions) ? existingAttrs.suggestions : []);

    const session = await persistEditorialSession(pId, cleanChapterId, {
      title,
      content: rawContent,
      manuscript: body.manuscript,
      scenes: body.scenes || existingAttrs.scenes,
      currentPhase,
      suggestions,
      stats: body.stats || existingAttrs.stats,
      existingAttrs,
      extraAttributes: body.attributes || {},
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

    let content = extractString(existingAttrs.manuscript).trim()
      || reconstructChapterProse(chapter, chapAttrs, { asMarkdown: false })
      || (existing && existing.content)
      || '';
    content = stripEditorialHtmlToPlainText(content);

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
      : (extractString(existingAttrs.manuscript).trim()
          || reconstructChapterProse(chapter, chapAttrs, { asMarkdown: false })
          || (existing && existing.content)
          || '');
    const parsedInput = parseStructuredEditorialInput(rawText, existingAttrs.scenes);
    const manuscriptText = parsedInput.manuscript.text;

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
      manuscript: parsedInput.manuscript,
      scenes: parsedInput.scenes,
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
  stripEditorialHtmlToPlainText,
  parseStructuredEditorialInput,
  normalizeEditorialHtmlToMarkdown,
  upsertChapterRecord,
  reconstructChapterProse,
  reconstructChapterMarkdown,
  slugifyChapterHeading,
  persistEditorialSession,
  loadEditorialProjectContext,
  buildHeuristicEditorialSuggestions,
  normalizeEditorialSuggestions
};
