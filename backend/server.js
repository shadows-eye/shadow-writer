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

// --- TEMPLATES API ---
app.get('/api/templates', async (req, res) => {
  res.json({ templates: await readDB('templates.json') });
});

app.post('/api/templates', async (req, res) => {
  const { id, name, genre, content } = req.body;
  if (!id || !name || !genre) return res.status(400).json({ error: 'Missing fields' });
  
  const templates = await readDB('templates.json');
  const index = templates.findIndex(t => t.id === id);
  const newTemplate = { id, name, genre, content: content || '' };
  
  if (index >= 0) templates[index] = newTemplate;
  else templates.push(newTemplate);
  
  await writeDB('templates.json', templates);
  res.json({ success: true, template: newTemplate });
});

app.delete('/api/templates/:id', async (req, res) => {
  const { id } = req.params;
  const templates = await readDB('templates.json');
  const newTemplates = templates.filter(t => t.id !== id);
  await writeDB('templates.json', newTemplates);
  res.json({ success: true });
});

// --- AI CHAT API ---
const { exec } = require('child_process');
const util = require('util');
const execAsync = util.promisify(exec);

app.post('/api/ai/chat', async (req, res) => {
  const { message, templateIds } = req.body;
  if (!message) return res.status(400).json({ error: 'Missing message' });

  // Get templates content if provided
  let contextStr = '';
  if (templateIds && Array.isArray(templateIds) && templateIds.length > 0) {
    const templates = await readDB('templates.json');
    const selectedTmpls = templates.filter(t => templateIds.includes(t.id));
    if (selectedTmpls.length > 0) {
      contextStr = '\nContext Templates:\n' + selectedTmpls.map(t => `--- ${t.name} ---\n${t.content}`).join('\n\n');
    }
  }

  // Escape message securely for shell
  const safeMessage = message.replace(/"/g, '\\"').replace(/\$/g, '\\$');
  const safeContext = contextStr.replace(/"/g, '\\"').replace(/\$/g, '\\$');

  try {
    // Attempt to call antigravity cli
    // Note: Since it's not installed yet, this will fail gracefully and we return the error.
    const { stdout, stderr } = await execAsync(`antigravity chat --message "${safeMessage}" --context "${safeContext}"`);
    res.json({ reply: stdout.trim() || 'No response' });
  } catch (error) {
    console.error('Antigravity CLI error:', error.message);
    if (error.message.includes('command not found') || error.code === 127) {
      res.json({ reply: 'Antigravity CLI not installed yet. Waiting for installation to process AI chat.' });
    } else {
      res.status(500).json({ error: 'Failed to process AI chat via antigravity cli' });
    }
  }
});

// --- HISTORY API ---
app.get('/api/history', async (req, res) => {
  const { projectId } = req.query;
  if (!projectId) return res.status(400).json({ error: 'Missing projectId' });
  
  const projects = await readDB('projects.json');
  const project = projects.find(p => p.id === projectId);
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
  // Update if exists, otherwise push
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
    const project = projects.find(p => p.id === projectId);
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
    const project = projects.find(p => p.id === projectId);
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
    
    try { await git.push(); } catch (e) {}
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
    const project = projects.find(p => p.id === projectId);
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
    const project = projects.find(p => p.id === projectId);
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
    
    try { await git.push(); } catch (e) {}
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
    const project = projects.find(p => p.id === projectId);
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
    const project = projects.find(p => p.id === projectId);
    if (!project) return res.status(404).json({ error: 'Project not found' });
    notesDir = project.folderPath;
    gitDir = project.folderPath;
  } else {
    notesDir = NOVELS_DIR;
    gitDir = NOVELS_DIR;
  }

  try {
    if (!fsSync.existsSync(notesDir)) await fs.mkdir(notesDir, { recursive: true });
    // Note suffix added here
    const filePath = path.join(notesDir, `${id}.note.md`);
    await fs.writeFile(filePath, content, 'utf-8');

    const git = simpleGit(gitDir);
    if (!(await git.checkIsRepo())) await git.init();
    await git.add(filePath);
    const commitResult = await git.commit(`Update note: ${id}`);
    
    try { await git.push(); } catch (e) {}
    res.json({ success: true, commit: commitResult.commit });
  } catch (err) {
    console.error('Error saving note:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Serve frontend static files
app.use(express.static(path.join(__dirname, 'public')));
app.get(/(.*)/, (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

app.listen(PORT, () => console.log(`Shadow Writer backend listening on port ${PORT}`));
