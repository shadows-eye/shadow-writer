const express = require('express');
const cors = require('cors');
const path = require('path');

const app = express();
app.use(cors());
app.use(express.json());

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
  Chapter,
  Character,
  Note,
  ContextFile,
  parseCharacterAttributes
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
  ContextFile
};

// API Key Middleware
app.use((req, res, next) => {
  if (req.path.startsWith('/api/')) {
    const apiKey = req.headers['x-api-key'];
    const expectedKey = process.env.MCP_API_KEY;
    if (expectedKey && apiKey !== expectedKey) {
      return res.status(401).json({ error: 'Unauthorized: Invalid API Key' });
    }
  }
  next();
});

// --- PROJECTS API ---
app.get('/api/project-status', async (req, res) => {
  const { projectId } = req.query;
  if (!projectId) return res.status(400).json({ error: 'Missing projectId' });

  const projects = await readDB('projects.json');
  const project = findProject(projects, projectId);
  if (!project) return res.status(404).json({ error: 'Project not found' });

  try {
    const dossierNote = await Note.findOne({ projectId: project.id, id: { $in: ['dossier', 'story_dossier'] } });
    const dossierFile = await ContextFile.findOne({ projectId: project.id, destination: 'worldbuilding', path: /dossier/i });
    const hasDossier = !!dossierNote || !!dossierFile;

    const hasCharacters = await Character.exists({ projectId: project.id });
    
    const outlineNote = await Note.findOne({ projectId: project.id, id: 'outline' });
    const outlineFile = await ContextFile.findOne({ projectId: project.id, destination: 'worldbuilding', path: /outline/i });
    const hasOutline = !!outlineNote || !!outlineFile;

    let chapters = [];
    if (hasOutline) {
      const outlineContent = (outlineNote ? outlineNote.content : (outlineFile ? outlineFile.content : '')) || '';
      const chapterRegex = /^\s*#+\s*Chapter\s+(\d+)/gm;
      let match;
      const chaptersSet = new Set();
      while ((match = chapterRegex.exec(outlineContent)) !== null) {
        chaptersSet.add(parseInt(match[1]));
      }
      chapters = Array.from(chaptersSet).sort((a, b) => a - b);
    } else {
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

app.get('/api/projects', async (req, res) => {
  res.json({ projects: await readDB('projects.json') });
});

app.post('/api/projects', async (req, res) => {
  const { id, name, folderPath, templates, writingPOV, writingTense } = req.body;
  if (!id || !name || !folderPath) return res.status(400).json({ error: 'Missing fields' });

  try {
    const newProject = { id, name, folderPath, templates: templates || [], writingPOV: writingPOV || '', writingTense: writingTense || '' };
    await Project.findOneAndUpdate({ id }, newProject, { upsert: true });
    res.json({ success: true, project: newProject });
  } catch (error) {
    console.error('Error saving project:', error);
    res.status(500).json({ error: 'Failed to save project' });
  }
});

app.get('/api/projects/:projectId/export', async (req, res) => {
  const { projectId } = req.params;
  const projects = await readDB('projects.json');
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

  const projects = await readDB('projects.json');
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

  const projects = await readDB('projects.json');
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

  const projects = await readDB('projects.json');
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

  const projects = await readDB('projects.json');
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
  const templates = await readDB('templates.json');

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
});

app.post('/api/templates', async (req, res) => {
  const userId = req.headers['x-user-id'];
  const userRole = req.headers['x-user-role'] || 'creator';
  const { id, name, genre, templateType, content, templateBehavior, nextTemplateId } = req.body;
  if (!id || !name || !genre || !templateType) return res.status(400).json({ error: 'Missing fields' });

  const isOverride = userRole !== 'admin';

  try {
    let t = await Template.findOne({ id });
    if (t) {
      if (isOverride && userId) {
        if (!t.overrides) t.overrides = new Map();
        t.overrides.set(userId, content);
      } else {
        t.name = name;
        t.genre = genre;
        t.templateType = templateType;
        t.content = content;
        t.templateBehavior = templateBehavior;
        t.nextTemplateId = nextTemplateId;
      }
      await t.save();
    } else {
      const overrides = {};
      if (isOverride && userId) {
        overrides[userId] = content;
      }
      await Template.create({
        id, name, genre, templateType, templateBehavior, nextTemplateId,
        content: isOverride ? '' : content,
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
        await t.save();
      }
    } else {
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
  const { projectId } = req.query;
  if (!projectId) return res.status(400).json({ error: 'Missing projectId' });

  const projects = await readDB('projects.json');
  const project = findProject(projects, projectId);
  if (!project) return res.status(404).json({ error: 'Project not found' });

  try {
    const list = await History.find({ projectId: project.id }).sort({ timestamp: -1 }).lean();
    const formatted = list.map(item => ({
      hash: item._id.toString(),
      date: item.timestamp ? item.timestamp.toISOString() : new Date().toISOString(),
      message: item.log || `${item.type || 'Agent'} run`,
      author_name: item.userId || 'AI Agent'
    }));
    res.json({ history: formatted });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to read history from DB' });
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
    const existing = await CharacterElement.findOne({ id: newElement.id });
    if (existing) {
      return res.status(400).json({ error: 'Character element key already defined' });
    }
    const element = await CharacterElement.create(newElement);
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
    const list = await Character.find({ projectId: pId });
    const formatted = list.map(c => ({
      id: c.id,
      name: c.name || c.id,
      species: c.species || 'Unknown',
      age: c.age || 'Unknown',
      attributes: c.attributes || {},
      content: c.content
    }));
    res.json({ characters: formatted });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.post('/api/characters/:id', async (req, res) => {
  const { id } = req.params;
  const { content, projectId } = req.body;
  if (!content) return res.status(400).json({ error: 'Missing content' });
  const pId = projectId || 'global';

  try {
    const parsedAttrs = await parseCharacterAttributes(content);
    const nameMatch = content.match(/^\s*#\s+(.+)$/m);
    const charName = nameMatch ? nameMatch[1].trim() : id;

    await Character.findOneAndUpdate(
      { projectId: pId, id },
      { 
        content,
        name: charName,
        species: parsedAttrs['species'] || 'Unknown',
        age: parsedAttrs['age'] || 'Unknown',
        attributes: parsedAttrs,
        lastEdited: new Date()
      },
      { upsert: true }
    );

    // Save to History
    await History.create({
      projectId: pId,
      type: 'manual_edit',
      status: 'complete',
      progress: 1.0,
      log: `Update character: ${id}`
    });

    res.json({ success: true, commit: 'db_' + Math.random().toString(36).substring(2, 10) });
  } catch (err) {
    console.error('Error saving character:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// --- CHAPTERS API ---
app.get('/api/chapters', async (req, res) => {
  const { projectId } = req.query;
  const pId = projectId || 'global';

  try {
    const list = await Chapter.find({ projectId: pId }).sort({ orderIndex: 1 });
    const formatted = list.map(c => ({ id: c.id, content: c.content }));
    res.json({ chapters: formatted });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.post('/api/chapters/:id', async (req, res) => {
  const { id } = req.params;
  const { content, projectId } = req.body;
  if (!content) return res.status(400).json({ error: 'Missing content' });
  const pId = projectId || 'global';

  try {
    const match = id.match(/\d+/);
    const orderIndex = match ? parseInt(match[0]) : 999;

    await Chapter.findOneAndUpdate(
      { projectId: pId, id },
      { content, orderIndex, lastEdited: new Date() },
      { upsert: true }
    );

    // Save to History
    await History.create({
      projectId: pId,
      type: 'manual_edit',
      status: 'complete',
      progress: 1.0,
      log: `Update chapter: ${id}`
    });

    res.json({ success: true, commit: 'db_' + Math.random().toString(36).substring(2, 10) });
  } catch (err) {
    console.error('Error saving chapter:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// --- NOTES API ---
app.get('/api/notes', async (req, res) => {
  const { projectId } = req.query;
  const pId = projectId || 'global';

  try {
    const list = await Note.find({ projectId: pId });
    const formatted = list.map(n => ({ id: n.id, content: n.content }));
    res.json({ notes: formatted });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.post('/api/notes/:id', async (req, res) => {
  const { id } = req.params;
  const { content, projectId } = req.body;
  if (!content) return res.status(400).json({ error: 'Missing content' });
  const pId = projectId || 'global';

  try {
    await Note.findOneAndUpdate(
      { projectId: pId, id },
      { content, lastEdited: new Date() },
      { upsert: true }
    );

    // Save to History
    await History.create({
      projectId: pId,
      type: 'manual_edit',
      status: 'complete',
      progress: 1.0,
      log: `Update note: ${id}`
    });

    res.json({ success: true, commit: 'db_' + Math.random().toString(36).substring(2, 10) });
  } catch (err) {
    console.error('Error saving note:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.delete('/api/notes/:id', async (req, res) => {
  const { id } = req.params;
  const { projectId } = req.query;
  const pId = projectId || 'global';

  try {
    const result = await Note.deleteOne({ projectId: pId, id });
    if (result.deletedCount === 0) {
      return res.status(404).json({ error: 'Note not found' });
    }

    // Save to History
    await History.create({
      projectId: pId,
      type: 'manual_edit',
      status: 'complete',
      progress: 1.0,
      log: `Delete note: ${id}`
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
