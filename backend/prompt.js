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
    // Attempt to call agy cli
    if (!fsSync.existsSync('.agents')) {
      fsSync.mkdirSync('.agents');
    }

    console.log('Spawning agy CLI...');
    const { spawn } = require('child_process');
    const args = ['--print', `Context: ${contextStr}\n\nPrompt: ${message}`];

    const agyProcess = spawn('agy', args);
    let output = '';
    let errOutput = '';

    // Explicitly close stdin so agy doesn't hang waiting for piped input
    agyProcess.stdin.end();

    agyProcess.stdout.on('data', (data) => {
      console.log(`[AGY STDOUT]: ${data}`);
      output += data.toString();
    });

    agyProcess.stderr.on('data', (data) => {
      console.error(`[AGY STDERR]: ${data}`);
      errOutput += data.toString();
    });

    agyProcess.on('close', async (code) => {
      console.log(`agy child process exited with code ${code}`);
      if (code === 0) {
        await updateJob('complete', `Response: ${output.trim()}`);
        res.json({ reply: output.trim() || 'No response' });
      } else {
        await updateJob('error', `Error Code ${code}: ${errOutput}`);
        res.status(500).json({ error: 'Failed to process AI chat via agy cli' });
      }
    });

  } catch (error) {
    console.error('Antigravity CLI error:', error.message);
    if (error.message.includes('command not found') || error.code === 127) {
      await updateJob('error', 'agy CLI not installed');
      res.json({ reply: 'Antigravity CLI (agy) not installed or mounted yet. Waiting for installation to process AI chat.' });
    } else {
      await updateJob('error', `CLI Error: ${error.message}`);
      res.status(500).json({ error: 'Failed to process AI chat via agy cli' });
    }
  }
});

module.exports = router;
