const express = require('express');
const cors = require('cors');
const simpleGit = require('simple-git');
const path = require('path');
const fs = require('fs/promises');
const fsSync = require('fs');

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 4000;
const NOVELS_DIR = process.env.NOVELS_DIR || path.join(__dirname, 'novels');
const DB_DIR = path.join(__dirname, 'db');

// Ensure DB and Novel dirs exist
if (!fsSync.existsSync(NOVELS_DIR)) fsSync.mkdirSync(NOVELS_DIR, { recursive: true });
if (!fsSync.existsSync(DB_DIR)) fsSync.mkdirSync(DB_DIR, { recursive: true });

// Helper to read/write JSON DBs
async function readDB(filename) {
  const filepath = path.join(DB_DIR, filename);
  if (!fsSync.existsSync(filepath)) return [];
  try {
    const data = await fs.readFile(filepath, 'utf-8');
    return JSON.parse(data);
  } catch (e) { return []; }
}
async function writeDB(filename, data) {
  await fs.writeFile(path.join(DB_DIR, filename), JSON.stringify(data, null, 2));
}

function findProject(projects, projectId) {
  if (!projects || projects.length === 0) return null;
  let p = projects.find(proj => proj.id === projectId);
  if (!p && projects.length === 1) {
    p = projects[0];
  }
  return p;
}

const { exec } = require('child_process');
const util = require('util');
const execAsync = util.promisify(exec);

const jobs = new Map(); // jobId -> Response stream (for SSE)

module.exports = {
  readDB,
  writeDB,
  NOVELS_DIR,
  DB_DIR,
  execAsync,
  jobs,
  findProject
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

  const projectDir = project.folderPath;
  const status = {
    hasDossier: false,
    hasCharacters: false,
    hasOutline: false,
    chapters: []
  };

  try {
    // Check for Story Dossier (Dossier.md) or assume true for now if any notes exist?
    // Let's check for specific files or just anything in notes?
    // Actually, we'll just check if Dossier.md exists.
    status.hasDossier = fsSync.existsSync(path.join(projectDir, 'Dossier.md')) || fsSync.existsSync(path.join(projectDir, 'Story Dossier.md'));

    // Check for characters
    const charsDir = path.join(projectDir, 'characters');
    if (fsSync.existsSync(charsDir)) {
      const charFiles = await fs.readdir(charsDir);
      status.hasCharacters = charFiles.length > 0;
    }

    // Check for Outline and parse chapters
    const outlinePath = path.join(projectDir, 'Outline.md');
    if (fsSync.existsSync(outlinePath)) {
      status.hasOutline = true;
      const outlineContent = await fs.readFile(outlinePath, 'utf-8');

      // Parse chapter headings, e.g., "### Chapter 1: The Seed of Doubt"
      const chapterRegex = /^\s*#+\s*Chapter\s+(\d+)/gm;
      let match;
      const chaptersSet = new Set();
      while ((match = chapterRegex.exec(outlineContent)) !== null) {
        chaptersSet.add(parseInt(match[1]));
      }
      status.chapters = Array.from(chaptersSet).sort((a, b) => a - b);
    }

    res.json(status);
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

  const projects = await readDB('projects.json');
  const index = projects.findIndex(p => p.id === id);
  const newProject = { id, name, folderPath, templates: templates || [], writingPOV: writingPOV || '', writingTense: writingTense || '' };

  if (index >= 0) projects[index] = newProject;
  else projects.push(newProject);

  await writeDB('projects.json', projects);

  // Ensure the folder exists and git is initialized
  if (!fsSync.existsSync(folderPath)) await fs.mkdir(folderPath, { recursive: true });
  const git = simpleGit(folderPath);
  if (!(await git.checkIsRepo())) await git.init();

  res.json({ success: true, project: newProject });
});

app.post('/api/context-files', async (req, res) => {
  const { projectId, destination, files } = req.body;
  if (!projectId || !destination || !files || !Array.isArray(files)) {
    return res.status(400).json({ error: 'Missing or invalid fields' });
  }

  const projects = await readDB('projects.json');
  const project = findProject(projects, projectId);
  if (!project) return res.status(404).json({ error: 'Project not found' });

  // destination should be 'braindump' or 'worldbuilding'
  const targetDir = path.join(project.folderPath, destination);

  try {
    for (const file of files) {
      // file.path is relative path from the uploaded folder (e.g., 'my_folder/sub/file.md')
      // file.content is text
      const filePath = path.join(targetDir, file.path);
      // Ensure path is safe and inside targetDir
      if (!filePath.startsWith(targetDir)) continue;

      const dirPath = path.dirname(filePath);
      if (!fsSync.existsSync(dirPath)) {
        await fs.mkdir(dirPath, { recursive: true });
      }
      await fs.writeFile(filePath, file.content, 'utf8');
    }
    res.json({ success: true, count: files.length });
  } catch (error) {
    console.error('Error saving context files:', error);
    res.status(500).json({ error: 'Failed to save context files' });
  }
});

async function getFilesRecursively(dir) {
  let results = [];
  try {
    const list = await fs.readdir(dir);
    for (const file of list) {
      const filePath = path.join(dir, file);
      const stat = await fs.stat(filePath);
      if (stat && stat.isDirectory()) {
        results = results.concat(await getFilesRecursively(filePath));
      } else if (filePath.endsWith('.md')) {
        results.push(filePath);
      }
    }
  } catch (e) {
    if (e.code !== 'ENOENT') throw e;
  }
  return results;
}

app.get('/api/context-files', async (req, res) => {
  const { projectId, destination } = req.query;
  if (!projectId || !destination) return res.status(400).json({ error: 'Missing fields' });

  const projects = await readDB('projects.json');
  const project = findProject(projects, projectId);
  if (!project) return res.status(404).json({ error: 'Project not found' });

  const targetDir = path.join(project.folderPath, destination);
  try {
    const filePaths = await getFilesRecursively(targetDir);
    const files = await Promise.all(filePaths.map(async (fp) => {
      const content = await fs.readFile(fp, 'utf-8');
      return {
        path: path.relative(targetDir, fp).replace(/\\/g, '/'),
        content
      };
    }));
    res.json({ success: true, files });
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

  const targetDir = path.join(project.folderPath, destination);
  const filePath = path.join(targetDir, relPath);
  if (!filePath.startsWith(targetDir)) return res.status(403).json({ error: 'Invalid path' });

  try {
    await fs.writeFile(filePath, content, 'utf8');
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

  const targetDir = path.join(project.folderPath, destination);
  const filePath = path.join(targetDir, relPath);
  if (!filePath.startsWith(targetDir)) return res.status(403).json({ error: 'Invalid path' });

  try {
    await fs.unlink(filePath);
    res.json({ success: true });
  } catch (error) {
    console.error('Error deleting context file:', error);
    res.status(500).json({ error: 'Failed to delete context file' });
  }
});

// --- TEMPLATES API ---
app.get('/api/templates', async (req, res) => {
  const userId = req.headers['x-user-id']; // Optional, could be admin
  const templates = await readDB('templates.json');

  // Apply overrides if a specific creator is fetching
  if (userId) {
    const customizedTemplates = templates.map(t => {
      if (t.overrides && t.overrides[userId]) {
        return { ...t, content: t.overrides[userId], isOverride: true };
      }
      return { ...t, isOverride: false };
    });
    res.json({ templates: customizedTemplates });
  } else {
    // Admin view
    res.json({ templates });
  }
});

app.post('/api/templates', async (req, res) => {
  const userId = req.headers['x-user-id'];
  const userRole = req.headers['x-user-role'] || 'creator';
  const { id, name, genre, templateType, content, templateBehavior, nextTemplateId } = req.body;
  if (!id || !name || !genre || !templateType) return res.status(400).json({ error: 'Missing fields' });

  const templates = await readDB('templates.json');
  const index = templates.findIndex(t => t.id === id);

  const isOverride = userRole !== 'admin';

  if (index >= 0) {
    if (isOverride && userId) {
      // Creator is saving an override for this template
      templates[index].overrides = templates[index].overrides || {};
      templates[index].overrides[userId] = content;
    } else {
      // Admin is updating the global template
      templates[index].name = name;
      templates[index].genre = genre;
      templates[index].templateType = templateType;
      templates[index].content = content;
      templates[index].templateBehavior = templateBehavior;
      templates[index].nextTemplateId = nextTemplateId;
    }
  } else {
    // New template
    templates.push({ id, name, genre, templateType, templateBehavior, nextTemplateId, content: isOverride ? '' : content, overrides: isOverride && userId ? { [userId]: content } : {} });
  }

  await writeDB('templates.json', templates);
  res.json({ success: true });
});

app.delete('/api/templates/:id', async (req, res) => {
  const userId = req.headers['x-user-id'];
  const { id } = req.params;
  const isOverrideDelete = req.query.override === 'true';

  const templates = await readDB('templates.json');
  const index = templates.findIndex(t => t.id === id);

  if (index >= 0) {
    if (isOverrideDelete && userId && templates[index].overrides) {
      delete templates[index].overrides[userId];
    } else {
      templates.splice(index, 1);
    }
    await writeDB('templates.json', templates);
  }

  res.json({ success: true });
});

// --- HISTORY API ---
app.get('/api/history', async (req, res) => {
  const { projectId } = req.query;
  if (!projectId) return res.status(400).json({ error: 'Missing projectId' });

  const projects = await readDB('projects.json');
  const project = findProject(projects, projectId);
  if (!project) return res.status(404).json({ error: 'Project not found' });

  try {
    const git = simpleGit(project.folderPath);
    if (!(await git.checkIsRepo())) return res.json({ history: [] });
    const log = await git.log();
    res.json({ history: log.all });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to read git history' });
  }
});

// --- CHARACTERS API ---
app.get('/api/character-elements', async (req, res) => {
  res.json({ elements: await readDB('characterElements.json') });
});

app.post('/api/character-elements', async (req, res) => {
  const newElement = req.body;
  if (!newElement || !newElement.id || !newElement.name) {
    return res.status(400).json({ error: 'Missing required fields' });
  }

  const elements = await readDB('characterElements.json');
  const index = elements.findIndex(e => e.id === newElement.id);
  if (index >= 0) {
    elements[index] = newElement;
  } else {
    elements.push(newElement);
  }

  await writeDB('characterElements.json', elements);
  res.json({ success: true, element: newElement });
});

app.get('/api/characters', async (req, res) => {
  const { projectId } = req.query;
  let charsDir;

  if (projectId) {
    const projects = await readDB('projects.json');
    const project = findProject(projects, projectId);
    if (!project) return res.status(404).json({ error: 'Project not found' });
    charsDir = path.join(project.folderPath, 'characters');
  } else {
    charsDir = path.join(NOVELS_DIR, 'characters');
  }

  try {
    if (!fsSync.existsSync(charsDir)) return res.json({ characters: [] });
    const files = await fs.readdir(charsDir);
    const mdFiles = files.filter(f => f.endsWith('.md'));

    const characters = [];
    for (const file of mdFiles) {
      const content = await fs.readFile(path.join(charsDir, file), 'utf-8');
      characters.push({ id: file.replace('.md', ''), content });
    }
    res.json({ characters });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.post('/api/characters/:id', async (req, res) => {
  const { id } = req.params;
  const { content, projectId } = req.body;
  if (!content) return res.status(400).json({ error: 'Missing content' });

  let charsDir, gitDir;
  if (projectId) {
    const projects = await readDB('projects.json');
    const project = findProject(projects, projectId);
    if (!project) return res.status(404).json({ error: 'Project not found' });
    charsDir = path.join(project.folderPath, 'characters');
    gitDir = project.folderPath;
  } else {
    charsDir = path.join(NOVELS_DIR, 'characters');
    gitDir = NOVELS_DIR;
  }

  try {
    if (!fsSync.existsSync(charsDir)) await fs.mkdir(charsDir, { recursive: true });
    const filePath = path.join(charsDir, `${id}.md`);
    await fs.writeFile(filePath, content, 'utf-8');

    const git = simpleGit(gitDir);
    if (!(await git.checkIsRepo())) await git.init();
    await git.add(filePath);
    const commitResult = await git.commit(`Update character: ${id}`);

    try { await git.push(); } catch (e) { }
    res.json({ success: true, commit: commitResult.commit });
  } catch (err) {
    console.error('Error saving character:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// --- CHAPTERS API ---
app.get('/api/chapters', async (req, res) => {
  const { projectId } = req.query;
  let chapsDir;

  if (projectId) {
    const projects = await readDB('projects.json');
    const project = findProject(projects, projectId);
    if (!project) return res.status(404).json({ error: 'Project not found' });
    chapsDir = project.folderPath; // Root directory
  } else {
    chapsDir = NOVELS_DIR; // Root directory
  }

  try {
    if (!fsSync.existsSync(chapsDir)) return res.json({ chapters: [] });
    const files = await fs.readdir(chapsDir);
    const mdFiles = files.filter(f => f.toLowerCase().endsWith('.md') && !f.toLowerCase().endsWith('.note.md'));

    const chapters = [];
    for (const file of mdFiles) {
      const content = await fs.readFile(path.join(chapsDir, file), 'utf-8');
      chapters.push({ id: file.substring(0, file.length - 3), content }); // Remove .md
    }
    res.json({ chapters });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.post('/api/chapters/:id', async (req, res) => {
  const { id } = req.params;
  const { content, projectId } = req.body;
  if (!content) return res.status(400).json({ error: 'Missing content' });

  let chapsDir, gitDir;
  if (projectId) {
    const projects = await readDB('projects.json');
    const project = findProject(projects, projectId);
    if (!project) return res.status(404).json({ error: 'Project not found' });
    chapsDir = project.folderPath;
    gitDir = project.folderPath;
  } else {
    chapsDir = NOVELS_DIR;
    gitDir = NOVELS_DIR;
  }

  try {
    if (!fsSync.existsSync(chapsDir)) await fs.mkdir(chapsDir, { recursive: true });
    const filePath = path.join(chapsDir, `${id}.md`);
    await fs.writeFile(filePath, content, 'utf-8');

    const git = simpleGit(gitDir);
    if (!(await git.checkIsRepo())) await git.init();
    await git.add(filePath);
    const commitResult = await git.commit(`Update chapter: ${id}`);

    try { await git.push(); } catch (e) { }
    res.json({ success: true, commit: commitResult.commit });
  } catch (err) {
    console.error('Error saving chapter:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// --- NOTES API ---
app.get('/api/notes', async (req, res) => {
  const { projectId } = req.query;
  let notesDir;

  if (projectId) {
    const projects = await readDB('projects.json');
    const project = findProject(projects, projectId);
    if (!project) return res.status(404).json({ error: 'Project not found' });
    notesDir = project.folderPath;
  } else {
    notesDir = NOVELS_DIR;
  }

  try {
    if (!fsSync.existsSync(notesDir)) return res.json({ notes: [] });
    const files = await fs.readdir(notesDir);
    const mdFiles = files.filter(f => f.toLowerCase().endsWith('.note.md'));

    const notes = [];
    for (const file of mdFiles) {
      const content = await fs.readFile(path.join(notesDir, file), 'utf-8');
      notes.push({ id: file.substring(0, file.length - 8), content }); // Remove .note.md
    }
    res.json({ notes });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.post('/api/notes/:id', async (req, res) => {
  const { id } = req.params;
  const { content, projectId } = req.body;
  if (!content) return res.status(400).json({ error: 'Missing content' });

  let notesDir, gitDir;
  if (projectId) {
    const projects = await readDB('projects.json');
    const project = findProject(projects, projectId);
    if (!project) return res.status(404).json({ error: 'Project not found' });
    notesDir = project.folderPath;
    gitDir = project.folderPath;
  } else {
    notesDir = NOVELS_DIR;
    gitDir = NOVELS_DIR;
  }

  try {
    if (!fsSync.existsSync(notesDir)) await fs.mkdir(notesDir, { recursive: true });
    const filePath = path.join(notesDir, `${id}.note.md`);
    await fs.writeFile(filePath, content, 'utf-8');

    const git = simpleGit(gitDir);
    if (!(await git.checkIsRepo())) await git.init();
    await git.add(filePath);
    const commitResult = await git.commit(`Update note: ${id}`);

    try { await git.push(); } catch (e) { }
    res.json({ success: true, commit: commitResult.commit });
  } catch (err) {
    console.error('Error saving note:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Register modular routers
app.use(require('./prompt'));
app.use(require('./agentEngine'));

app.get(/(.*)/, (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

app.listen(PORT, () => console.log(`Shadow Writer backend listening on port ${PORT}`));
