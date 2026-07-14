const express = require('express');
const router = express.Router();
const crypto = require('crypto');
const fsSync = require('fs');

const { readDB, writeDB, execAsync } = require('./server');

router.post('/api/ai/chat', async (req, res) => {
  const { message, templateIds, projectId } = req.body;
  const userId = req.headers['x-user-id'] || 'system';
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

  // Create job history entry
  const jobId = crypto.randomUUID();
  const job = {
    id: jobId,
    userId,
    projectId: projectId || 'global',
    type: 'ai_chat',
    status: 'running',
    progress: 0,
    totalSteps: 1,
    logs: [`[${new Date().toISOString()}] Prompt: ${message}`],
    createdAt: new Date().toISOString()
  };

  const history = await readDB('history.json');
  history.push(job);
  await writeDB('history.json', history);

  const updateJob = async (status, log) => {
    job.status = status;
    if (status === 'complete' || status === 'error') job.progress = 1;
    if (log) job.logs.push(`[${new Date().toISOString()}] ${log}`);

    const hist = await readDB('history.json');
    const idx = hist.findIndex(j => j.id === jobId);
    if (idx >= 0) {
      hist[idx] = job;
      await writeDB('history.json', hist);
    }
  };

  try {
    const flaskUrl = 'http://app:5000/admin/api/internal/ai/chat';
    const payload = `Context: ${contextStr}\n\nPrompt: ${message}`;
    
    console.log('Sending chat request to internal AI API...');
    const response = await fetch(flaskUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-API-Key': process.env.GEMINI_API_KEY
      },
      body: JSON.stringify({
        message: payload,
        isSubagent: false
      })
    });

    if (!response.ok) {
      const errText = await response.text();
      throw new Error(`Flask internal chat returned status ${response.status}: ${errText}`);
    }

    const data = await response.json();
    const reply = data.reply || data.response || 'No response';
    await updateJob('complete', `Response: ${reply}`);
    res.json({ reply });

  } catch (error) {
    console.error('Internal AI Chat API error:', error.message);
    await updateJob('error', `API Error: ${error.message}`);
    res.status(500).json({ error: 'Failed to process AI chat via internal API' });
  }
});

module.exports = router;
