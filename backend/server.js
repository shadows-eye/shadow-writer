const express = require('express');
const cors = require('cors');
const path = require('path');
const mongoose = require('mongoose');

const app = express();

const allowedOrigins = process.env.ALLOWED_CORS_ORIGINS
  ? process.env.ALLOWED_CORS_ORIGINS.split(',').map(o => o.trim())
  : ['http://localhost:5000', 'http://127.0.0.1:5000'];

app.use(cors({
  origin: function (origin, callback) {
    if (!origin) return callback(null, true);
    if (allowedOrigins.indexOf(origin) !== -1 || allowedOrigins.includes('*')) {
      return callback(null, true);
    }
    return callback(new Error('CORS policy does not allow access from this origin.'), false);
  },
  credentials: true
}));
app.use(express.json({ limit: '50mb' }));

const PORT = process.env.PORT || 4000;

// Import all models and DB helpers from mongoDB.js
const {
  readDB,
  writeDB,
  findProject,
  Project,
  Template,
  CharacterElement,
  History,
  Job,
  Chapter,
  Character,
  Note,
  Artifact,
  ContextFile,
  parseCharacterAttributes,
  getDynamicAttributeKeys
} = require('./mongoDB');

const { exec } = require('child_process');
const util = require('util');
const execAsync = util.promisify(exec);

const jobs = new Map(); // jobId -> Response stream (for SSE)

module.exports = {
  readDB,
  writeDB,
  jobs,
  findProject,
  execAsync,
  Project,
  Template,
  CharacterElement,
  History,
  Chapter,
  Character,
  Note,
  Artifact,
  ContextFile
};

// API Key Middleware
app.use((req, res, next) => {
  if (req.path.startsWith('/api/')) {
    const apiKey = req.headers['x-api-key'];
    const expectedKey = process.env.MCP_API_KEY;
    if (!expectedKey || apiKey !== expectedKey) {
      return res.status(401).json({ error: 'Unauthorized: Invalid or missing API Key' });
    }
  }
  next();
});

// --- PROJECTS API ---
app.get('/api/project-status', async (req, res) => {
  const { projectId } = req.query;
  if (!projectId) return res.status(400).json({ error: 'Missing projectId' });

  const projects = await Project.find({}).lean();
  const project = findProject(projects, projectId);
  if (!project) return res.status(404).json({ error: 'Project not found' });

  try {
    const dossierNote = await Note.findOne({
      projectId: project.id,
      $or: [
        { id: { $in: ['dossier', 'story_dossier', 'final_dossier'] } },
        { type: 'dossier' },
        { name: /dossier/i }
      ]
    });
    const dossierFile = await ContextFile.findOne({ projectId: project.id, destination: 'worldbuilding', path: /dossier/i });
    const hasDossier = !!dossierNote || !!dossierFile;

    const hasCharacters = await Character.exists({ projectId: project.id });

    const outlineNote = await Note.findOne({
      projectId: project.id,
      $or: [
        { id: { $in: ['outline', 'story_outline', 'final_outline'] } },
        { type: 'outline' },
        { name: /outline/i }
      ]
    });
    const outlineFile = await ContextFile.findOne({ projectId: project.id, destination: 'worldbuilding', path: /outline/i });
    const hasOutline = !!outlineNote || !!outlineFile;

    let chapters = [];
    if (hasOutline) {
      const outlineUnstruct = outlineNote && outlineNote.attributes
        ? (typeof outlineNote.attributes.get === 'function' ? outlineNote.attributes.get('unstructured') : outlineNote.attributes.unstructured)
        : '';
      const outlineContent = (outlineNote ? (outlineNote.content || outlineUnstruct) : (outlineFile ? outlineFile.content : '')) || '';
      const chapterRegex = /^\s*#*\s*(?:Chapter|Kapitel|Band)\s+(\d+)/gmi;
      let match;
      const chaptersSet = new Set();
      while ((match = chapterRegex.exec(outlineContent)) !== null) {
        chaptersSet.add(parseInt(match[1]));
      }
      chapters = Array.from(chaptersSet).sort((a, b) => a - b);
    }
    if (chapters.length === 0) {
      const chaps = await Chapter.find({ projectId: project.id });
      chapters = chaps.map(c => {
        const num = parseInt(c.id.replace(/\D/g, ''));
        return isNaN(num) ? c.id : num;
      }).sort((a, b) => a - b);
    }

    res.json({
      hasDossier: !!hasDossier,
      hasCharacters: !!hasCharacters,
      hasOutline: !!hasOutline,
      chapters
    });
  } catch (error) {
    console.error('Error in /api/project-status:', error);
    res.status(500).json({ error: 'Failed to check project status' });
  }
});

app.get('/api/schema', async (req, res) => {
  try {
    const schema = await getDynamicAttributeKeys();
    res.json(schema);
  } catch (error) {
    console.error('Error in /api/schema:', error);
    res.status(500).json({ error: 'Failed to fetch dynamic schema' });
  }
});

app.get('/api/projects', async (req, res) => {
  const userId = req.headers['x-user-id'];
  const userEmail = req.headers['x-user-email'];
  const userRole = req.headers['x-user-role'];

  let query = {};
  if (userRole !== 'admin') {
    const filters = [];
    if (userId) filters.push({ userId });
    if (userEmail) filters.push({ userEmail });
    filters.push({ userId: { $exists: false }, userEmail: { $exists: false } });
    filters.push({ userId: '', userEmail: '' });
    query = { $or: filters };
  }

  res.json({ projects: await Project.find(query).lean() });
});

function extractDriveFolderId(rawInput) {
  if (!rawInput || typeof rawInput !== 'string') return '';
  const trimmed = rawInput.trim();
  if (!trimmed) return '';
  const folderMatch = trimmed.match(/\/folders\/([a-zA-Z0-9_-]+)/);
  if (folderMatch) return folderMatch[1];
  const idParamMatch = trimmed.match(/[?&]id=([a-zA-Z0-9_-]+)/);
  if (idParamMatch) return idParamMatch[1];
  if (/^[a-zA-Z0-9_-]{10,}$/.test(trimmed)) return trimmed;
  return '';
}

app.post('/api/projects', async (req, res) => {
  const { id, name, folderPath, googleDriveFolderId, templates, writingPOV, writingTense, genre, language, description } = req.body;
  const userId = req.headers['x-user-id'] || '';
  const userEmail = req.headers['x-user-email'] || '';

  if (!id || !name) return res.status(400).json({ error: 'Missing fields: id and name are required' });

  try {
    const resolvedFolderId = googleDriveFolderId || extractDriveFolderId(folderPath || '');
    const newProject = {
      id,
      name,
      userId,
      userEmail,
      folderPath: folderPath || resolvedFolderId || '',
      googleDriveFolderId: resolvedFolderId,
      language: language || 'en',
      description: description || '',
      templates: templates || [],
      writingPOV: writingPOV || '',
      writingTense: writingTense || '',
      genre: genre || 'Science Fiction'
    };
    await Project.findOneAndUpdate({ id }, newProject, { upsert: true, new: true });
    res.json({ success: true, project: newProject });
  } catch (error) {
    console.error('Error saving project:', error);
    res.status(500).json({ error: 'Failed to save project' });
  }
});

app.put('/api/projects/:projectId', async (req, res) => {
  const { projectId } = req.params;
  if (!projectId) return res.status(400).json({ error: 'Missing projectId' });

  try {
    const existing = await Project.findOne({ id: projectId }).lean();
    if (!existing) return res.status(404).json({ error: 'Project not found' });

    const { name, folderPath, googleDriveFolderId, templates, writingPOV, writingTense, genre, language, description } = req.body || {};
    const nextFolderPath = folderPath !== undefined ? folderPath : (existing.folderPath || '');
    const resolvedFolderId = googleDriveFolderId !== undefined
      ? (googleDriveFolderId || extractDriveFolderId(nextFolderPath))
      : (folderPath !== undefined ? extractDriveFolderId(nextFolderPath) : (existing.googleDriveFolderId || ''));

    const updateFields = {
      name: name !== undefined ? name : existing.name,
      folderPath: nextFolderPath,
      googleDriveFolderId: resolvedFolderId,
      language: language !== undefined ? language : (existing.language || 'en'),
      description: description !== undefined ? description : (existing.description || ''),
      templates: templates !== undefined ? templates : (existing.templates || []),
      writingPOV: writingPOV !== undefined ? writingPOV : (existing.writingPOV || ''),
      writingTense: writingTense !== undefined ? writingTense : (existing.writingTense || ''),
      genre: genre !== undefined ? genre : (existing.genre || 'Science Fiction')
    };

    const updated = await Project.findOneAndUpdate({ id: projectId }, { $set: updateFields }, { new: true }).lean();
    res.json({ success: true, project: updated });
  } catch (error) {
    console.error('Error updating project:', error);
    res.status(500).json({ error: 'Failed to update project' });
  }
});

app.get('/api/projects/:projectId/export', async (req, res) => {
  const { projectId } = req.params;
  const projects = await Project.find({}).lean();
  const project = findProject(projects, projectId);
  if (!project) return res.status(404).json({ error: 'Project not found' });

  try {
    const chapters = await Chapter.find({ projectId: project.id }).sort({ orderIndex: 1 });
    if (!chapters || chapters.length === 0) {
      return res.status(404).json({ error: 'No chapters found to export' });
    }

    const docx = require('docx');
    const { Document, Packer, Paragraph, TextRun, HeadingLevel } = docx;

    const docChildren = [];
    for (const chap of chapters) {
      const titleText = chap.id.replace(/-/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
      docChildren.push(new Paragraph({
        text: titleText,
        heading: HeadingLevel.HEADING_1,
        spacing: { before: 400, after: 200 }
      }));

      const lines = (chap.content || '').split(/\n\n+/);
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;

        if (trimmed.startsWith('# ')) {
          docChildren.push(new Paragraph({
            text: trimmed.substring(2),
            heading: HeadingLevel.HEADING_1,
            spacing: { before: 300, after: 200 }
          }));
        } else if (trimmed.startsWith('## ')) {
          docChildren.push(new Paragraph({
            text: trimmed.substring(3),
            heading: HeadingLevel.HEADING_2,
            spacing: { before: 200, after: 150 }
          }));
        } else if (trimmed.startsWith('### ')) {
          docChildren.push(new Paragraph({
            text: trimmed.substring(4),
            heading: HeadingLevel.HEADING_3,
            spacing: { before: 150, after: 100 }
          }));
        } else {
          const runs = [];
          const tokens = trimmed.split(/(\*\*.*?\*\*|\*.*?\*)/g);
          for (const token of tokens) {
            if (token.startsWith('**') && token.endsWith('**')) {
              runs.push(new TextRun({
                text: token.substring(2, token.length - 2),
                bold: true
              }));
            } else if (token.startsWith('*') && token.endsWith('*')) {
              runs.push(new TextRun({
                text: token.substring(1, token.length - 1),
                italic: true
              }));
            } else if (token) {
              runs.push(new TextRun({
                text: token
              }));
            }
          }

          docChildren.push(new Paragraph({
            children: runs,
            spacing: { after: 120 }
          }));
        }
      }
    }

    const doc = new Document({
      sections: [{
        properties: {},
        children: docChildren
      }]
    });

    const buffer = await Packer.toBuffer(doc);
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
    res.setHeader('Content-Disposition', `attachment; filename="${project.name.replace(/[^a-zA-Z0-9]/g, '_')}_manuscript.docx"`);
    res.send(buffer);
  } catch (err) {
    console.error('Error exporting DOCX:', err);
    res.status(500).json({ error: 'Failed to compile and export manuscript' });
  }
});

app.post('/api/context-files', async (req, res) => {
  const { projectId, destination, files } = req.body;
  if (!projectId || !destination || !files || !Array.isArray(files)) {
    return res.status(400).json({ error: 'Missing or invalid fields' });
  }

  const projects = await Project.find({}).lean();
  const project = findProject(projects, projectId);
  if (!project) return res.status(404).json({ error: 'Project not found' });

  try {
    for (const file of files) {
      await ContextFile.findOneAndUpdate(
        { projectId: project.id, destination, path: file.path },
        { content: file.content, lastEdited: new Date() },
        { upsert: true }
      );
    }
    res.json({ success: true, count: files.length });
  } catch (error) {
    console.error('Error saving context files:', error);
    res.status(500).json({ error: 'Failed to save context files' });
  }
});

app.get('/api/context-files', async (req, res) => {
  const { projectId, destination } = req.query;
  if (!projectId || !destination) return res.status(400).json({ error: 'Missing fields' });

  const projects = await Project.find({}).lean();
  const project = findProject(projects, projectId);
  if (!project) return res.status(404).json({ error: 'Project not found' });

  try {
    const files = await ContextFile.find({ projectId: project.id, destination });
    const formatted = files.map(f => ({
      path: f.path,
      content: f.content
    }));
    res.json({ success: true, files: formatted });
  } catch (e) {
    console.error('Error reading context files:', e);
    res.status(500).json({ error: 'Failed to read context files' });
  }
});

app.put('/api/context-files', async (req, res) => {
  const { projectId, destination, path: relPath, content } = req.body;
  if (!projectId || !destination || !relPath || content === undefined) {
    return res.status(400).json({ error: 'Missing fields' });
  }

  const projects = await Project.find({}).lean();
  const project = findProject(projects, projectId);
  if (!project) return res.status(404).json({ error: 'Project not found' });

  try {
    await ContextFile.findOneAndUpdate(
      { projectId: project.id, destination, path: relPath },
      { content, lastEdited: new Date() },
      { upsert: true }
    );
    res.json({ success: true });
  } catch (error) {
    console.error('Error updating context file:', error);
    res.status(500).json({ error: 'Failed to update context file' });
  }
});

app.delete('/api/context-files', async (req, res) => {
  const { projectId, destination, path: relPath } = req.query;
  if (!projectId || !destination || !relPath) return res.status(400).json({ error: 'Missing fields' });

  const projects = await Project.find({}).lean();
  const project = findProject(projects, projectId);
  if (!project) return res.status(404).json({ error: 'Project not found' });

  try {
    await ContextFile.deleteOne({ projectId: project.id, destination, path: relPath });
    res.json({ success: true });
  } catch (error) {
    console.error('Error deleting context file:', error);
    res.status(500).json({ error: 'Failed to delete context file' });
  }
});

// --- TEMPLATES API ---
app.get('/api/templates', async (req, res) => {
  const userId = req.headers['x-user-id'];
  try {
    const templates = await Template.find({}).lean();

    if (userId) {
      const customizedTemplates = templates.map(t => {
        if (t.overrides && (t.overrides[userId] || (t.overrides instanceof Map && t.overrides.get(userId)))) {
          const val = t.overrides instanceof Map ? t.overrides.get(userId) : t.overrides[userId];
          return { ...t, content: val, isOverride: true };
        }
        return { ...t, isOverride: false };
      });
      res.json({ templates: customizedTemplates });
    } else {
      res.json({ templates });
    }
  } catch (e) {
    console.error('Error fetching templates:', e);
    res.status(500).json({ error: 'Failed to fetch templates' });
  }
});

app.get('/api/templates/:id', async (req, res) => {
  const { id } = req.params;
  const userId = req.headers['x-user-id'];

  try {
    const t = await Template.findOne({ id }).lean();
    if (!t) return res.status(404).json({ error: 'Template not found' });

    if (userId && t.overrides && (t.overrides[userId] || (t.overrides instanceof Map && t.overrides.get(userId)))) {
      const val = t.overrides instanceof Map ? t.overrides.get(userId) : t.overrides[userId];
      return res.json({ ...t, content: val, isOverride: true });
    }
    res.json({ ...t, isOverride: false });
  } catch (err) {
    console.error('Error fetching template by id:', err);
    res.status(500).json({ error: 'Failed to fetch template' });
  }
});

app.post('/api/templates', async (req, res) => {
  const userId = req.headers['x-user-id'];
  const userRole = req.headers['x-user-role'] || 'creator';
  const { id, name, genre, templateType, content, templateBehavior, parentAgentId, parentAgent, nextTemplateId, model, thinkingLevel, contextTypes, subagents } = req.body;
  if (!id || !name || !genre || !templateType) return res.status(400).json({ error: 'Missing fields' });

  const isOverride = userRole !== 'admin';

  try {
    if (templateType === 'Dossier') {
      const existingDossier = await Template.findOne({ templateType: 'Dossier', genre, id: { $ne: id } });
      if (existingDossier) {
        return res.status(400).json({ error: `A Dossier template already exists for the "${genre}" genre ("${existingDossier.name}"). You cannot create more than one per genre.` });
      }
    }

    let t = await Template.findOne({ id });
    if (t) {
      if (isOverride && userId) {
        if (!t.overrides) t.overrides = new Map();
        t.overrides.set(userId, content);
        t.markModified('overrides');
      } else {
        t.name = name;
        t.genre = genre;
        t.templateType = templateType;
        t.content = content;
        t.templateBehavior = templateBehavior;
        t.parentAgentId = parentAgentId || t.parentAgentId || '';
        t.parentAgent = parentAgent || t.parentAgent || '';
        t.nextTemplateId = nextTemplateId || '';
        t.model = model || 'gemini-3.5-flash';
        t.thinkingLevel = thinkingLevel || 'high';
        t.contextTypes = contextTypes || [];
        t.subagents = subagents || [];
      }
      await t.save();
    } else {
      const overrides = {};
      if (isOverride && userId) {
        overrides[userId] = content;
      }
      await Template.create({
        id, name, genre, templateType, templateBehavior,
        parentAgentId: parentAgentId || '',
        parentAgent: parentAgent || '',
        nextTemplateId: nextTemplateId || '',
        content: isOverride ? '' : content,
        model: model || 'gemini-3.5-flash',
        thinkingLevel: thinkingLevel || 'high',
        contextTypes: contextTypes || [],
        subagents: subagents || [],
        overrides
      });
    }
    res.json({ success: true });
  } catch (e) {
    console.error('Error saving template:', e);
    res.status(500).json({ error: 'Failed to save template' });
  }
});

app.delete('/api/templates/:id', async (req, res) => {
  const userId = req.headers['x-user-id'];
  const { id } = req.params;
  const isOverrideDelete = req.query.override === 'true';

  try {
    if (isOverrideDelete && userId) {
      let t = await Template.findOne({ id });
      if (t && t.overrides) {
        t.overrides.delete(userId);
        t.markModified('overrides');
        await t.save();
      }
    } else {
      let t = await Template.findOne({ id });
      if (t && t.genre === 'General') {
        return res.status(400).json({ error: 'System templates in the General genre cannot be deleted.' });
      }
      await Template.deleteOne({ id });
    }
    res.json({ success: true });
  } catch (e) {
    console.error('Error deleting template:', e);
    res.status(500).json({ error: 'Failed to delete template' });
  }
});

app.post('/api/templates/:id/chat', async (req, res) => {
  const { id } = req.params;
  const { role, content } = req.body;
  if (!role || !content) return res.status(400).json({ error: 'Missing role or content' });

  try {
    let t = await Template.findOne({ id });
    if (!t) {
      t = await Template.create({ id, name: id, genre: 'Romantic Suspense', templateType: 'POV Guide', content: '' });
    }
    if (!t.chatHistory) t.chatHistory = [];
    t.chatHistory.push({ role, content, timestamp: new Date() });
    await t.save();
    res.json({ success: true });
  } catch (e) {
    console.error('Error saving template chat:', e);
    res.status(500).json({ error: 'Failed to save template chat' });
  }
});

// --- HISTORY API ---
app.get('/api/history', async (req, res) => {
  const { projectId, runId, jobId } = req.query;

  try {
    let query = {};
    if (runId || jobId) {
      const targetId = runId || jobId;
      query = { $or: [{ _id: mongoose.Types.ObjectId.isValid(targetId) ? new mongoose.Types.ObjectId(targetId) : null }, { jobId: targetId }, { 'payload.jobId': targetId }] };
    } else if (projectId && projectId !== 'all' && projectId !== 'global') {
      const projects = await Project.find({}).lean();
      const project = findProject(projects, projectId);
      const targetProjectId = project ? project.id : projectId;
      query = { $or: [{ projectId: targetProjectId }, { projectId: 'global' }, { projectId: projectId }] };
    }

    const list = await History.find(query).sort({ timestamp: -1 }).limit(100).lean();
    const formatted = list.map(item => {
      const payload = item.payload || {};
      return {
        id: item._id.toString(),
        hash: item._id.toString(),
        jobId: item.jobId || item._id.toString(),
        date: item.timestamp ? item.timestamp.toISOString() : new Date().toISOString(),
        message: payload.message || `${item.pipelineType || item.type || 'AI Agent'} run`,
        pipelineType: item.pipelineType || item.type || 'ai_chat',
        type: item.type || item.pipelineType || 'ai_chat',
        status: item.status || 'running',
        progress: item.progress !== undefined ? item.progress : 0.0,
        activeSubagentIndex: item.activeSubagentIndex || 0,
        activeTaskIndex: item.activeTaskIndex || 0,
        taskSequence: item.taskSequence || [],
        thinking: item.thinking || '',
        author_name: item.userId || 'AI Agent',
        userPrompt: payload.userPrompt || payload.prompt || '',
        aiResponse: payload.aiResponse || payload.response || payload.newDocText || '',
        logs: item.logs || [],
        modifiedDocs: item.modifiedDocs || [],
        docId: item.docId || '',
        diffHtml: item.diffHtml || '',
        payload: payload
      };
    });
    res.json({ history: formatted, runs: formatted });
  } catch (err) {
    console.error('Error fetching history:', err);
    res.status(500).json({ error: 'Failed to read history from DB' });
  }
});

app.post('/api/history', async (req, res) => {
  const { projectId, pipelineType, type, message, status, author_name, userPrompt, aiResponse, logs, payload, jobId, job_id, progress, activeSubagentIndex, activeTaskIndex, taskSequence, thinking, modifiedDocs, diffHtml, docId } = req.body || {};
  const targetProjectId = projectId || 'global';
  const finalJobId = jobId || job_id || `run_${Date.now()}_${Math.random().toString(36).substr(2, 6)}`;
  const resolvedType = pipelineType || type || 'ai_chat';

  try {
    const existingHistory = await History.findOne({ jobId: finalJobId });
    const fieldsToSet = {
      jobId: finalJobId,
      projectId: targetProjectId,
      userId: author_name || 'AI Agent',
      type: resolvedType,
      pipelineType: resolvedType,
      status: status || 'completed',
      progress: progress !== undefined ? progress : 1.0,
      activeSubagentIndex: activeSubagentIndex || 0,
      activeTaskIndex: activeTaskIndex || 0,
      taskSequence: taskSequence || [],
      thinking: thinking || '',
      logs: logs || [`[INFO] Executed ${pipelineType || 'AI Agent'} run`],
      modifiedDocs: modifiedDocs || [],
      diffHtml: diffHtml || '',
      docId: docId || '',
      payload: payload || { message: message || 'AI Run', userPrompt: userPrompt || '', aiResponse: aiResponse || '' },
      timestamp: new Date()
    };

    if (existingHistory) {
      Object.assign(existingHistory, fieldsToSet);
      await existingHistory.save();
      return res.json({ success: true, history: existingHistory });
    }

    const historyItem = await History.create(fieldsToSet);
    res.json({ success: true, history: historyItem });
  } catch (err) {
    console.error('Error creating history run:', err);
    res.status(500).json({ error: 'Failed to save history entry' });
  }
});

// --- JOBS API (Active Pipeline Job Storage) ---
app.get('/api/jobs', async (req, res) => {
  try {
    const { projectId } = req.query;
    let query = {};
    if (projectId && projectId !== 'all' && projectId !== 'global') {
      query = { projectId };
    }
    const jobsList = await Job.find(query).sort({ updatedAt: -1 }).lean();
    res.json({ jobs: jobsList });
  } catch (err) {
    console.error('Error listing jobs from DB:', err);
    res.status(500).json({ error: 'Failed to list jobs from DB' });
  }
});

app.get('/api/jobs/:jobId', async (req, res) => {
  try {
    const { jobId } = req.params;
    const job = await Job.findOne({ jobId }).lean();
    if (!job) {
      return res.status(404).json({ error: 'Job not found' });
    }
    res.json({ job });
  } catch (err) {
    console.error('Error fetching job from DB:', err);
    res.status(500).json({ error: 'Failed to read job from DB' });
  }
});

app.post('/api/jobs', async (req, res) => {
  const data = req.body || {};
  const jobId = data.jobId || data.id;
  if (!jobId) {
    return res.status(400).json({ error: 'jobId is required' });
  }

  try {
    const fieldsToSet = {
      jobId,
      projectId: data.projectId || 'global',
      pipelineType: data.pipelineType || 'braindump_to_dossier',
      status: data.status || 'running',
      progress: data.progress !== undefined ? data.progress : 0.0,
      activeSubagentIndex: data.activeSubagentIndex || 0,
      activeTaskIndex: data.activeTaskIndex || 0,
      taskSequence: data.taskSequence || [],
      thinking: data.thinking || '',
      logs: data.logs || [],
      modifiedDocs: data.modifiedDocs || [],
      diffHtml: data.diffHtml || '',
      payload: data.payload || {},
      lastUpdated: new Date()
    };

    const updatedJob = await Job.findOneAndUpdate(
      { jobId },
      { $set: fieldsToSet },
      { upsert: true, new: true, lean: true }
    );
    res.json({ success: true, job: updatedJob });
  } catch (err) {
    console.error('Error upserting job:', err);
    res.status(500).json({ error: 'Failed to save job entry' });
  }
});

app.delete('/api/jobs/:jobId', async (req, res) => {
  try {
    const { jobId } = req.params;
    await Job.deleteOne({ jobId });
    res.json({ success: true });
  } catch (err) {
    console.error('Error deleting job:', err);
    res.status(500).json({ error: 'Failed to delete job entry' });
  }
});

// --- CHARACTERS API ---
app.get('/api/character-elements', async (req, res) => {
  try {
    const elements = await CharacterElement.find({});
    res.json({ elements });
  } catch (e) {
    console.error('Error fetching character elements:', e);
    res.status(500).json({ error: 'Failed to fetch character elements' });
  }
});

app.post('/api/character-elements', async (req, res) => {
  const newElement = req.body;
  if (!newElement || !newElement.id || !newElement.name) {
    return res.status(400).json({ error: 'Missing required fields' });
  }

  try {
    let element = await CharacterElement.findOne({ id: newElement.id });
    if (element) {
      element.name = newElement.name || element.name;
      element.type = newElement.type || element.type;
      element.color = newElement.color !== undefined ? newElement.color : element.color;
      element.isTag = newElement.isTag !== undefined ? newElement.isTag : element.isTag;
      await element.save();
    } else {
      element = await CharacterElement.create(newElement);
    }
    res.json({ success: true, element });
  } catch (e) {
    console.error('Error saving character element:', e);
    res.status(500).json({ error: 'Failed to save character element' });
  }
});

app.get('/api/characters', async (req, res) => {
  const { projectId } = req.query;
  const pId = projectId || 'global';

  try {
    const { ensureCleanDocumentOnRead, sanitizeAttributesObj } = require('./mongoDB');
    const list = await Character.find({ projectId: pId });
    const formatted = [];
    for (const item of list) {
      const cleaned = await ensureCleanDocumentOnRead(item, 'character');
      formatted.push({
        id: cleaned.id,
        name: cleaned.name || cleaned.id,
        species: cleaned.species || 'Unknown',
        age: cleaned.age || 'Unknown',
        attributes: sanitizeAttributesObj(cleaned.attributes) || {},
        content: cleaned.content
      });
    }
    res.json({ characters: formatted });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.get('/api/characters/:id', async (req, res) => {
  const { id } = req.params;
  const { projectId } = req.query;
  const pId = projectId || 'global';

  try {
    const { ensureCleanDocumentOnRead, sanitizeAttributesObj } = require('./mongoDB');
    let doc = await Character.findOne({ projectId: pId, id });
    if (!doc) {
      doc = await Character.findOne({ id });
    }
    if (!doc) {
      return res.status(404).json({ error: 'Character not found' });
    }
    const cleaned = await ensureCleanDocumentOnRead(doc, 'character');
    res.json({
      id: cleaned.id,
      name: cleaned.name || cleaned.id,
      species: cleaned.species || 'Unknown',
      age: cleaned.age || 'Unknown',
      attributes: sanitizeAttributesObj(cleaned.attributes) || {},
      content: cleaned.content
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch character' });
  }
});

app.post('/api/characters/:id', async (req, res) => {
  const { id } = req.params;
  const { name: reqName, content, attributes: inputAttrs, projectId } = req.body;
  if (!content && !inputAttrs && !reqName) return res.status(400).json({ error: 'Missing content or attributes' });
  const pId = projectId || 'global';

  try {
    const { sanitizeAndStructureContent, constructMarkdownFromAttributes, sanitizeAttributesObj, updateDocumentAttributeKeys, extractString } = require('./mongoDB');
    const existingChar = await Character.findOne({ projectId: pId, id });
    const existingAttrs = existingChar ? sanitizeAttributesObj(existingChar.attributes) : {};

    let { name: charName, attributes: parsedAttrs, cleanContent } = sanitizeAndStructureContent(content || (existingChar ? existingChar.content : ''), 'character', id);
    if (!content && inputAttrs && Object.keys(inputAttrs).length > 0) {
      delete parsedAttrs.unstructured;
    }
    const mergedAttrs = { ...existingAttrs, ...parsedAttrs, ...(inputAttrs || {}) };
    if (content && cleanContent && !mergedAttrs.unstructured) {
      mergedAttrs.unstructured = cleanContent;
    }

    console.log(`[DEBUG] Updating character ${id}`);
    console.log(`[DEBUG] Input Attrs:`, inputAttrs);
    console.log(`[DEBUG] Merged Attrs:`, mergedAttrs);

    const updatedChar = await updateDocumentAttributeKeys(Character, pId, id, mergedAttrs);
    const finalCleanAttrs = sanitizeAttributesObj(mergedAttrs);
    const extractText = (val) => (val && typeof val === 'object' && val.text !== undefined) ? val.text : val;
    updatedChar.name = extractString(reqName || (inputAttrs && inputAttrs.name) || (charName !== id ? charName : '') || (existingChar ? existingChar.name : id));
    updatedChar.race = extractText(finalCleanAttrs['race']) || 'Unknown';
    updatedChar.age = extractText(finalCleanAttrs['age']) || 'Unknown';
    updatedChar.content = "";
    await updatedChar.save();

    // Save to History
    await History.create({
      jobId: 'manual_' + Math.random().toString(36).substring(2, 15),
      projectId: pId,
      type: 'manual_edit',
      status: 'complete',
      progress: 1.0,
      logs: [`Update character: ${id}`]
    });

    res.json({ success: true, commit: 'db_' + Math.random().toString(36).substring(2, 10) });
  } catch (err) {
    console.error('Error saving character:', err);
    res.status(500).json({ error: 'Internal server error', details: err.message, stack: err.stack });
  }
});

// --- CHAPTERS API ---
app.get('/api/chapters', async (req, res) => {
  const { projectId } = req.query;
  const pId = projectId || 'global';

  try {
    const { ensureCleanDocumentOnRead, sanitizeAttributesObj } = require('./mongoDB');
    const list = await Chapter.find({ projectId: pId }).sort({ orderIndex: 1 });
    const formatted = [];
    for (const item of list) {
      const cleaned = await ensureCleanDocumentOnRead(item, 'chapter');

      let reconstructedContent = cleaned.content || '';
      if (cleaned.scenes) {
        const scenesObj = cleaned.scenes instanceof Map ? Object.fromEntries(cleaned.scenes) : cleaned.scenes;
        if (Object.keys(scenesObj).length > 0) {
          let sceneHtmls = [];
          let sceneIds = Object.keys(scenesObj);
          for (let i = 0; i < sceneIds.length; i++) {
            const sId = sceneIds[i];
            const sceneDataRaw = scenesObj[sId];
            const sceneData = sceneDataRaw instanceof Map ? Object.fromEntries(sceneDataRaw) : sceneDataRaw;
            const bObjRaw = sceneData.beats || {};
            const bObj = bObjRaw instanceof Map ? Object.fromEntries(bObjRaw) : bObjRaw;

            let beatHtmls = [];
            let beatIds = Object.keys(bObj);
            for (let j = 0; j < beatIds.length; j++) {
              const bId = beatIds[j];
              const bContent = bObj[bId];
              if (j > 0) {
                beatHtmls.push(`\n<hr id="${bId}" class="beat-break border-dashed border-gray-600 my-4">\n`);
              }
              beatHtmls.push(bContent.html || bContent.text || '');
            }
            sceneHtmls.push(beatHtmls.join(''));
          }

          reconstructedContent = '';
          for (let i = 0; i < sceneHtmls.length; i++) {
            const sId = sceneIds[i];
            if (i > 0) {
              reconstructedContent += `\n<hr id="${sId}" class="scene-break border-2 border-cyan-700/50 my-8 w-1/2 mx-auto rounded-full">\n`;
            }
            reconstructedContent += sceneHtmls[i];
          }
        }
      }
      formatted.push({
        id: cleaned.id,
        name: cleaned.name,
        content: reconstructedContent,
        attributes: sanitizeAttributesObj(cleaned.attributes),
        pendingDiff: cleaned.pendingDiff || null
      });
    }
    res.json({ chapters: formatted });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

function normalizeEditorialHtmlToMarkdown(rawInput) {
  if (!rawInput || typeof rawInput !== 'string') return '';
  let s = rawInput.replace(/\r\n/g, '\n').trim();
  if (!s) return '';

  if (/<div\b|<br\b|<span\b/i.test(s)) {
    s = s.replace(/<span[^>]*class=["']?[^"'>]*issue-highlight[^"'>]*["']?[^>]*>([\s\S]*?)<\/span>/gi, '$1');
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
  const orderIndex = match ? parseInt(match[0]) : 999;
  const { sanitizeAndStructureContent, extractString } = require('./mongoDB');

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

    let scenesData = {};
    if (cleanContent) {
      const crypto = require('crypto');
      const generateId = () => crypto.randomBytes(4).toString('hex');

      const sceneTokens = cleanContent.split(/(<hr\b[^>]*class=["']?[^"'>]*scene-break[^"'>]*["']?[^>]*>|<p>\s*\*\*\*\s*<\/p>|<div>\s*\*\*\*\s*<\/div>|\n\s*\*\*\*\s*\n)/i);

      let currentSceneId = `scene-${generateId()}`;
      let currentSceneText = sceneTokens[0] || '';

      const stripHtml = (html) => html.replace(/<[^>]*>?/gm, '').trim();

      const parseBeats = (sceneText) => {
        const beatTokens = sceneText.split(/(<hr\b[^>]*class=["']?[^"'>]*beat-break[^"'>]*["']?[^>]*>|<p>\s*---\s*<\/p>|<div>\s*---\s*<\/div>|\n\s*---\s*\n)/i);
        let beats = {};
        let currentBeatId = `beat-${generateId()}`;
        let currentBeatText = beatTokens[0] || '';

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
    updateData.content = "";
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

app.post('/api/chapters/:id', async (req, res) => {
  const { id } = req.params;
  const { content, projectId, clearPendingDiff, name, attributes } = req.body;
  if (!content && clearPendingDiff !== true) return res.status(400).json({ error: 'Missing content' });
  const pId = projectId || 'global';

  try {
    await upsertChapterRecord(pId, id, { name, content, attributes, clearPendingDiff });
    res.json({ success: true, commit: 'db_' + Math.random().toString(36).substring(2, 10) });
  } catch (err) {
    console.error('Error saving chapter:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// --- EDITORIAL SESSION API ---
app.get('/api/editor/session/:projectId/:chapterId', async (req, res) => {
  const { projectId, chapterId } = req.params;
  const pId = projectId || 'global';
  const sessionId = chapterId.startsWith('editorial-session-')
    ? chapterId
    : `editorial-session-${chapterId}`;
  const cleanChapterId = chapterId.replace(/^editorial-session-/, '');

  try {
    const { sanitizeAttributesObj } = require('./mongoDB');
    const artifact = await Artifact.findOne({ projectId: pId, id: sessionId });
    const chapter = await Chapter.findOne({ projectId: pId, id: cleanChapterId });

    if (!artifact && !chapter) {
      return res.status(404).json({ error: 'Editorial session not found' });
    }

    const artAttrs = artifact ? sanitizeAttributesObj(artifact.attributes) : {};
    const chapAttrs = chapter ? sanitizeAttributesObj(chapter.attributes) : {};

    const content = (artifact && artifact.content)
      || artAttrs.unstructured
      || (chapter && chapter.content)
      || chapAttrs.unstructured
      || '';
    const title = (artifact && artifact.name)
      || artAttrs.title
      || (chapter && chapter.name)
      || cleanChapterId;
    const currentPhase = artAttrs.currentPhase || artAttrs.current_step || '1. Logik';
    const suggestions = Array.isArray(artAttrs.suggestions) ? artAttrs.suggestions : [];
    const stats = artAttrs.stats && typeof artAttrs.stats === 'object'
      ? {
          total: Number(artAttrs.stats.total || 0),
          accepted: Number(artAttrs.stats.accepted || 0),
          rejected: Number(artAttrs.stats.rejected || 0),
          open: Number(artAttrs.stats.open !== undefined ? artAttrs.stats.open : (Number(artAttrs.stats.total || 0) - Number(artAttrs.stats.accepted || 0) - Number(artAttrs.stats.rejected || 0)))
        }
      : { total: suggestions.length, accepted: 0, rejected: 0, open: suggestions.length };

    res.json({
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
    const { sanitizeAttributesObj } = require('./mongoDB');
    const existing = await Artifact.findOne({ projectId: pId, id: sessionId });
    const existingAttrs = existing ? sanitizeAttributesObj(existing.attributes) : {};

    const body = req.body || {};
    const rawContent = body.content !== undefined
      ? body.content
      : (body.current_text !== undefined ? body.current_text : (existing ? existing.content : ''));
    const cleanMd = normalizeEditorialHtmlToMarkdown(rawContent);

    const title = body.title || body.name || existingAttrs.title || (existing && existing.name) || cleanChapterId;
    const currentPhase = body.currentPhase || body.current_step || existingAttrs.currentPhase || '1. Logik';
    const suggestions = Array.isArray(body.suggestions)
      ? body.suggestions
      : (Array.isArray(existingAttrs.suggestions) ? existingAttrs.suggestions : []);

    const rawStats = body.stats || existingAttrs.stats || { total: suggestions.length, accepted: 0, rejected: 0, open: suggestions.length };
    const total = Number(rawStats.total !== undefined ? rawStats.total : suggestions.length);
    const accepted = Number(rawStats.accepted || 0);
    const rejected = Number(rawStats.rejected || 0);
    const open = Number(rawStats.open !== undefined ? rawStats.open : Math.max(0, total - accepted - rejected));
    const stats = { total, accepted, rejected, open };

    const mergedAttrs = {
      ...existingAttrs,
      ...(body.attributes || {}),
      type: 'editorial_session',
      subtypeTag: 'editorial_session',
      chapterId: cleanChapterId,
      title,
      currentPhase,
      suggestions,
      stats,
      unstructured: cleanMd
    };
    if (body.current_text && /<div\b|<span\b/i.test(body.current_text)) {
      mergedAttrs.legacyRawHtml = body.current_text;
    }

    const savedArtifact = await Artifact.findOneAndUpdate(
      { projectId: pId, id: sessionId },
      {
        $set: {
          projectId: pId,
          id: sessionId,
          name: title,
          type: 'editorial_session',
          content: cleanMd,
          attributes: mergedAttrs,
          lastEdited: new Date()
        }
      },
      { upsert: true, new: true }
    );

    if (cleanMd && body.syncChapter !== false) {
      await upsertChapterRecord(pId, cleanChapterId, {
        name: title,
        content: cleanMd,
        attributes: {
          type: 'chapters',
          subtypeTag: 'chapters',
          editorialPhase: currentPhase
        }
      });
    }

    res.json({
      success: true,
      session: {
        id: sessionId,
        projectId: pId,
        chapterId: cleanChapterId,
        title,
        type: 'editorial_session',
        content: cleanMd,
        currentPhase,
        suggestions,
        stats,
        lastEdited: savedArtifact.lastEdited
      }
    });
  } catch (err) {
    console.error('Error saving editorial session:', err);
    res.status(500).json({ error: 'Failed to save editorial session', details: err.message });
  }
};

app.put('/api/editor/session/:projectId/:chapterId', saveEditorialSessionHandler);
app.post('/api/editor/session/:projectId/:chapterId', saveEditorialSessionHandler);

// --- NOTES API ---
app.get('/api/notes', async (req, res) => {
  const { projectId } = req.query;
  const pId = projectId || 'global';

  try {
    const { ensureCleanDocumentOnRead, sanitizeAttributesObj } = require('./mongoDB');
    const list = await Note.find({ projectId: pId, type: { $ne: 'artifact' } });
    const formatted = [];
    for (const item of list) {
      const cleaned = await ensureCleanDocumentOnRead(item, 'note');
      formatted.push({ id: cleaned.id, content: cleaned.content, name: cleaned.name, type: cleaned.type, attributes: sanitizeAttributesObj(cleaned.attributes) });
    }
    res.json({ notes: formatted });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.get('/api/notes/:id', async (req, res) => {
  const { id } = req.params;
  const { projectId } = req.query;
  const pId = projectId || 'global';

  try {
    const { ensureCleanDocumentOnRead, sanitizeAttributesObj } = require('./mongoDB');
    let note = await Note.findOne({ projectId: pId, id });
    if (!note && (id === 'dossier' || id === 'story_dossier')) {
      note = await Note.findOne({ projectId: pId, id: { $in: ['final_dossier', 'story_dossier', 'dossier'] } });
    }
    if (!note) return res.status(404).json({ error: 'Note not found' });
    const cleaned = await ensureCleanDocumentOnRead(note, 'note');
    res.json({ id: cleaned.id, name: cleaned.name, content: cleaned.content, type: cleaned.type, attributes: sanitizeAttributesObj(cleaned.attributes) });
  } catch (err) {
    console.error('Error fetching single note:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.post('/api/notes/:id', async (req, res) => {
  const { id } = req.params;
  const { name, content, projectId, attributes: reqAttributes } = req.body;
  if (!content && !reqAttributes && !name) return res.status(400).json({ error: 'Missing content or attributes' });
  const pId = projectId || 'global';

  try {
    const { sanitizeAndStructureContent, constructMarkdownFromAttributes, sanitizeAttributesObj, extractString } = require('./mongoDB');
    const existingNote = await Note.findOne({ projectId: pId, id });
    const existingAttrsObj = existingNote ? sanitizeAttributesObj(existingNote.attributes) : {};

    let { id: normId, type: normType, name: normName, attributes: parsedAttrs, cleanContent } = sanitizeAndStructureContent(content || (existingNote ? existingNote.content : ''), 'note', id);
    if (!content && reqAttributes && Object.keys(reqAttributes).length > 0) {
      delete parsedAttrs.unstructured;
    }
    const targetType = (reqAttributes && (reqAttributes.subtypeTag || reqAttributes.type)) || (existingAttrsObj && (existingAttrsObj.subtypeTag || existingAttrsObj.type)) || normType || 'note';
    const mergedAttributes = { ...(existingAttrsObj || {}), ...(parsedAttrs || {}), ...(reqAttributes || {}), type: targetType, subtypeTag: targetType };
    if (content && cleanContent && !mergedAttributes.unstructured) {
      mergedAttributes.unstructured = cleanContent;
    }

    let note = existingNote || (await Note.findOne({ projectId: pId, id: normId }));
    if (!note) {
      note = new Note({ projectId: pId, id: normId });
    }
    if (!note.attributes) note.attributes = {};
    for (const [k, v] of Object.entries(mergedAttributes)) {
      if (v === '' || v === null || v === undefined) {
        if (note.attributes && typeof note.attributes.delete === 'function') {
          note.attributes.delete(k);
        } else {
          note.set(`attributes.${k}`, undefined);
        }
      } else {
        if (note.attributes && typeof note.attributes.set === 'function') {
          note.attributes.set(k, v);
        } else {
          note.set(`attributes.${k}`, v);
        }
      }
    }

    // Enforce unique subtypeTag for 'dossier' and 'outline' per project
    if (targetType === 'dossier' || targetType === 'outline') {
      try {
        const conflictingNotes = await Note.find({ projectId: pId, id: { $ne: normId } });
        for (const confNote of conflictingNotes) {
          const confTag = confNote.attributes && confNote.attributes.get ? confNote.attributes.get('subtypeTag') : (confNote.attributes || {}).subtypeTag;
          if (confTag === targetType) {
            if (confNote.attributes && typeof confNote.attributes.set === 'function') {
              confNote.attributes.set('subtypeTag', 'notes');
              confNote.attributes.set('type', 'notes');
            } else if (confNote.attributes) {
              confNote.attributes.subtypeTag = 'notes';
              confNote.attributes.type = 'notes';
            }
            confNote.type = 'notes';
            confNote.markModified('attributes');
            await confNote.save();
          }
        }
      } catch (errConf) {
        console.error('Error unsetting duplicate unique subtypeTag:', errConf);
      }
    }

    const reqName = name || (reqAttributes && reqAttributes.name);
    note.name = extractString(reqName) || extractString(normName) || note.name || id;
    note.type = targetType;
    note.content = "";
    note.markModified('attributes');
    note.lastEdited = new Date();
    await note.save();

    // Save to History
    await History.create({
      jobId: 'manual_' + Math.random().toString(36).substring(2, 15),
      projectId: pId,
      type: 'manual_edit',
      status: 'complete',
      progress: 1.0,
      logs: [`Update note: ${normId}`]
    });

    res.json({ success: true, commit: 'db_' + Math.random().toString(36).substring(2, 10) });
  } catch (err) {
    console.error('Error saving note:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.delete('/api/characters/:id', async (req, res) => {
  const { id } = req.params;
  const { projectId } = req.query;
  const pId = projectId || 'global';

  try {
    let result = await Character.deleteOne({ projectId: pId, id });
    if (result.deletedCount === 0) {
      result = await Character.deleteOne({ projectId: pId, $or: [{ id: new RegExp('^' + id + '$', 'i') }, { name: new RegExp('^' + id + '$', 'i') }] });
    }

    if (result.deletedCount === 0) {
      return res.status(404).json({ error: 'Character not found' });
    }

    await History.create({
      jobId: 'manual_' + Math.random().toString(36).substring(2, 15),
      projectId: pId,
      type: 'manual_edit',
      status: 'complete',
      progress: 1.0,
      logs: [`Delete character: ${id}`]
    });

    res.json({ success: true });
  } catch (err) {
    console.error('Error deleting character:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.delete('/api/chapters/:id', async (req, res) => {
  const { id } = req.params;
  const { projectId } = req.query;
  const pId = projectId || 'global';

  try {
    let result = await Chapter.deleteOne({ projectId: pId, id });
    if (result.deletedCount === 0) {
      result = await Chapter.deleteOne({ projectId: pId, $or: [{ id: new RegExp('^' + id + '$', 'i') }] });
    }

    if (result.deletedCount === 0) {
      return res.status(404).json({ error: 'Chapter not found' });
    }

    await History.create({
      jobId: 'manual_' + Math.random().toString(36).substring(2, 15),
      projectId: pId,
      type: 'manual_edit',
      status: 'complete',
      progress: 1.0,
      logs: [`Delete chapter: ${id}`]
    });

    res.json({ success: true });
  } catch (err) {
    console.error('Error deleting chapter:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.delete('/api/notes/:id', async (req, res) => {
  const { id } = req.params;
  const { projectId } = req.query;
  const pId = projectId || 'global';

  try {
    let result = await Note.deleteOne({ projectId: pId, id });

    // Fallback matching if exact id match returned 0
    if (result.deletedCount === 0) {
      if (id === 'dossier' || id === 'story_dossier' || id === 'final_dossier') {
        result = await Note.deleteMany({ projectId: pId, $or: [{ id: { $in: ['dossier', 'story_dossier', 'final_dossier'] } }, { type: 'dossier' }, { name: /dossier/i }] });
      } else if (id === 'outline' || id === 'story_outline' || id === 'final_outline') {
        result = await Note.deleteMany({ projectId: pId, $or: [{ id: { $in: ['outline', 'story_outline', 'final_outline'] } }, { type: 'outline' }, { name: /outline/i }] });
      } else {
        result = await Note.deleteOne({ projectId: pId, $or: [{ id: new RegExp('^' + id + '$', 'i') }, { name: new RegExp('^' + id + '$', 'i') }] });
      }
    }

    if (result.deletedCount === 0) {
      return res.status(404).json({ error: 'Note not found' });
    }

    // Save to History
    await History.create({
      jobId: 'manual_' + Math.random().toString(36).substring(2, 15),
      projectId: pId,
      type: 'manual_edit',
      status: 'complete',
      progress: 1.0,
      logs: [`Delete note: ${id}`]
    });

    res.json({ success: true });
  } catch (err) {
    console.error('Error deleting note:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Register modular routers
app.use(require('./prompt'));
app.use(require('./agentEngine'));

app.get(/(.*)/, (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

app.listen(PORT, () => console.log(`Shadow Writer backend listening on port ${PORT}`));
