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
const NOVELS_DIR = path.join(__dirname, 'novels');
const git = simpleGit(NOVELS_DIR);

// Ensure novels dir exists
if (!fsSync.existsSync(NOVELS_DIR)) {
  fsSync.mkdirSync(NOVELS_DIR, { recursive: true });
}

// Ensure git is initialized in the novels dir
async function initGit() {
  const isRepo = await git.checkIsRepo();
  if (!isRepo) {
    await git.init();
    console.log('Initialized local git repository in novels directory.');
  }
}
initGit();

// API to save a chapter
app.post('/api/save-chapter', async (req, res) => {
  try {
    const { projectId, chapterId, title, content } = req.body;
    
    if (!projectId || !chapterId || !content) {
      return res.status(400).json({ error: 'Missing required fields' });
    }

    const projectDir = path.join(NOVELS_DIR, projectId);
    await fs.mkdir(projectDir, { recursive: true });
    
    const filePath = path.join(projectDir, `${chapterId}.md`);
    
    // Write markdown file
    let fileContent = `# ${title || chapterId}\n\n${content}`;
    await fs.writeFile(filePath, fileContent, 'utf-8');

    // Git operations
    await git.add(filePath);
    const commitResult = await git.commit(`Update chapter: ${chapterId} in project: ${projectId}`);
    
    // Attempt push if a remote is configured (ignore errors if no remote)
    try {
      await git.push();
    } catch (pushErr) {
      console.log('Skipping push, no remote configured or push failed.', pushErr.message);
    }

    // TODO: Notify shadow-mcp here with commit details
    // We can make an HTTP request to the MCP server API
    
    res.json({ success: true, commit: commitResult.commit });
  } catch (err) {
    console.error('Error saving chapter:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// API to fetch a chapter
app.get('/api/chapter/:projectId/:chapterId', async (req, res) => {
    try {
        const { projectId, chapterId } = req.params;
        const filePath = path.join(NOVELS_DIR, projectId, `${chapterId}.md`);
        
        if (!fsSync.existsSync(filePath)) {
             return res.status(404).json({ error: 'Chapter not found' });
        }
        
        const content = await fs.readFile(filePath, 'utf-8');
        res.json({ content });
    } catch (err) {
        res.status(500).json({ error: 'Failed to read chapter' });
    }
});

// Serve frontend static files in production
app.use(express.static(path.join(__dirname, 'public')));
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => {
  console.log(`Shadow Writer backend listening on port ${PORT}`);
});
