const express = require('express');
const router = express.Router();
const crypto = require('crypto');
const simpleGit = require('simple-git');
const path = require('path');
const fs = require('fs/promises');
const fsSync = require('fs');

const { readDB, writeDB, execAsync, jobs, Note, Chapter } = require('./server');

async function saveArtifact(projectId, type, id, content, orderIndex = null) {
  try {
    if (type === 'chapter') {
      await Chapter.findOneAndUpdate(
        { projectId, id },
        { content, orderIndex: orderIndex !== null ? orderIndex : 999, lastEdited: new Date() },
        { upsert: true }
      );
    } else {
      await Note.findOneAndUpdate(
        { projectId, id },
        { content, lastEdited: new Date() },
        { upsert: true }
      );
    }
  } catch (e) {
    console.error(`Error saving artifact ${id}:`, e);
  }
}

// --- SSE Endpoint ---
router.get('/sse', (req, res) => {
  const { jobId } = req.query;
  if (!jobId) return res.status(400).send('Missing jobId');

  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive'
  });

  jobs.set(jobId, res);
  req.on('close', () => {
    jobs.delete(jobId);
  });
});

// --- Automation Endpoints ---
router.post('/api/automation/start', async (req, res) => {
  const userId = req.headers['x-user-id'] || 'system';
  const { type, projectId, payload, resumeJobId } = req.body;

  if (resumeJobId) {
    const history = await readDB('history.json');
    const job = history.find(j => j.id === resumeJobId);
    if (!job) return res.status(404).json({ error: 'Job not found to resume' });

    job.status = 'running';
    job.logs.push(`[${new Date().toISOString()}] Resuming pipeline execution from step ${job.currentStep || 0}...`);
    await writeDB('history.json', history);

    runAutomationLoop(resumeJobId, job, job.payload || payload);
    return res.json({ success: true, jobId: resumeJobId });
  }

  if (!type || !projectId) return res.status(400).json({ error: 'Missing type or projectId' });

  const jobId = crypto.randomUUID();
  const job = {
    id: jobId,
    userId,
    projectId,
    type,
    status: 'running',
    progress: 0,
    totalSteps: type === 'braindump_to_dossier' ? 10 : 13,
    currentStep: 0,
    chatHistory: [],
    logs: [],
    payload,
    createdAt: new Date().toISOString()
  };

  const history = await readDB('history.json');
  history.push(job);
  await writeDB('history.json', history);

  runAutomationLoop(jobId, job, payload);

  res.json({ success: true, jobId });
});

router.get('/api/automation/history', async (req, res) => {
  const userId = req.headers['x-user-id'] || 'system';
  const history = await readDB('history.json');
  const userHistory = history.filter(j => j.userId === userId).sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  res.json({ history: userHistory });
});

router.post('/api/automation/log', async (req, res) => {
  const { jobId, userId, projectId, type, status, progress, log, createIfMissing } = req.body;
  if (!jobId) return res.status(400).json({ error: 'Missing jobId' });

  const history = await readDB('history.json');
  let jobIdx = history.findIndex(j => j.id === jobId);
  let job = jobIdx >= 0 ? history[jobIdx] : null;

  if (!job) {
    if (!createIfMissing) {
      return res.status(404).json({ error: 'Job not found' });
    }
    job = {
      id: jobId,
      userId: userId || 'system',
      projectId: projectId || 'global',
      type: type || 'agent_chat',
      status: status || 'running',
      progress: progress || 0,
      totalSteps: 1,
      logs: [],
      createdAt: new Date().toISOString()
    };
    history.push(job);
    jobIdx = history.length - 1;
  }

  if (status) job.status = status;
  if (progress !== undefined) job.progress = progress;
  if (log) job.logs.push(`[${new Date().toISOString()}] ${log}`);

  history[jobIdx] = job;
  await writeDB('history.json', history);

  res.json({ success: true, job });
});

// --- Automation Loop Execution ---
async function runAutomationLoop(jobId, jobData, payload) {
  jobData.chatHistory = jobData.chatHistory || [];
  jobData.currentStep = jobData.currentStep || 0;

  const updateJob = async (progress, log, status = 'running') => {
    jobData.progress = progress;
    jobData.status = status;
    if (log) jobData.logs.push(`[${new Date().toISOString()}] ${log}`);

    const history = await readDB('history.json');
    const index = history.findIndex(j => j.id === jobId);
    if (index >= 0) {
      history[index] = jobData;
      await writeDB('history.json', history);
    }

    const res = jobs.get(jobId);
    if (res) {
      res.write(`data: ${JSON.stringify(jobData)}\n\n`);
    }
  };

  try {
    const projects = await readDB('projects.json');
    const project = projects.find(p => p.id === jobData.projectId);
    const projectDir = project ? project.folderPath : '';

    const runAgy = async (prompt, isSubagent = true) => {
      if (!process.env.GEMINI_API_KEY) {
        throw new Error('GEMINI_API_KEY is not defined in environment');
      }
      try {
        const res = await fetch('http://app:5000/admin/api/internal/ai/chat', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-API-Key': process.env.GEMINI_API_KEY
          },
          body: JSON.stringify({
            message: prompt,
            isSubagent,
            jobId,
            chatHistory: jobData.chatHistory
          })
        });
        if (res.ok) {
          const json = await res.json();
          const responseText = json.response || json.reply;
          jobData.chatHistory.push({ role: 'user', content: prompt });
          jobData.chatHistory.push({ role: 'model', content: responseText });
          return { stdout: responseText, stderr: '' };
        } else {
          const txt = await res.text();
          console.error(`Internal AI chat error: ${txt}`);
          throw new Error(`Internal AI Chat error: ${txt}`);
        }
      } catch (e) {
        console.error("Failed to call internal AI chat:", e);
        throw e;
      }
    };

    if (jobData.type === 'braindump_to_dossier') {
      const { braindump, genre } = payload;

      if (jobData.currentStep < 1) {
        await updateJob(1, `Started Braindump to Dossier for genre: ${genre}`);
        jobData.currentStep = 1;
      }

      if (jobData.currentStep < 2) {
        const p1 = `Extract genre tropes and format requirements for: ${genre}. Based on this braindump: ${braindump}`;
        await updateJob(2, 'Step 1: Identifying Genre & Tropes...');
        const res = await runAgy(p1);
        await saveArtifact(jobData.projectId, 'note', 'genre_tropes', res.stdout);
        jobData.currentStep = 2;
      }

      if (jobData.currentStep < 3) {
        await updateJob(3, 'Step 2: Brainstorming Pitches...');
        const res = await runAgy("Brainstorm 5 distinct story pitches based on the previous tropes.");
        await saveArtifact(jobData.projectId, 'note', 'pitches_brainstorm', res.stdout);
        jobData.currentStep = 3;
      }

      if (jobData.currentStep < 4) {
        await updateJob(4, 'Step 3: Evaluating Pitches...');
        const res = await runAgy("Evaluate the 5 pitches and select the best one.");
        await saveArtifact(jobData.projectId, 'note', 'selected_pitch', res.stdout);
        jobData.currentStep = 4;
      }

      if (jobData.currentStep < 5) {
        await updateJob(5, 'Step 4: Extracting Winning Pitch...');
        const res = await runAgy("Format the winning pitch.");
        await saveArtifact(jobData.projectId, 'note', 'formatted_pitch', res.stdout);
        jobData.currentStep = 5;
      }

      if (jobData.currentStep < 6) {
        await updateJob(6, 'Step 5: Building Story Dossier Outline...');
        const res = await runAgy("Create a checklist of characters and worldbuilding elements needed for the winning pitch.");
        await saveArtifact(jobData.projectId, 'note', 'story_dossier_checklist', res.stdout);
        jobData.currentStep = 6;
      }

      if (jobData.currentStep < 7) {
        await updateJob(7, 'Step 6: Emotional Critique...');
        const res = await runAgy("Critique the emotional arc of the dossier.");
        await saveArtifact(jobData.projectId, 'note', 'dossier_emotional_critique', res.stdout);
        jobData.currentStep = 7;
      }

      if (jobData.currentStep < 8) {
        await updateJob(8, 'Step 7: Logic Critique...');
        const res = await runAgy("Critique the logical consistency of the plot.");
        await saveArtifact(jobData.projectId, 'note', 'dossier_logic_critique', res.stdout);
        jobData.currentStep = 8;
      }

      if (jobData.currentStep < 9) {
        await updateJob(9, 'Step 8: Character Name Critique...');
        const res = await runAgy("Review the suggested character names for genre fit.");
        await saveArtifact(jobData.projectId, 'note', 'character_names_critique', res.stdout);
        jobData.currentStep = 9;
      }

      if (jobData.currentStep < 10) {
        await updateJob(10, 'Step 10: Final Dossier Compile...');
        const res = await runAgy("Compile all previous details and critiques into the final story dossier.");
        await saveArtifact(jobData.projectId, 'note', 'dossier', res.stdout);
        await updateJob(10, 'Finished Braindump to Dossier', 'complete');
        jobData.currentStep = 10;
      }

    } else if (jobData.type === 'chapter_generator') {
      const { chapters, pov, tense } = payload;

      jobData.currentChapterIndex = jobData.currentChapterIndex || 0;
      jobData.currentChapterStep = jobData.currentChapterStep || 0;

      for (let i = jobData.currentChapterIndex; i < chapters.length; i++) {
        const chapter = chapters[i];
        jobData.currentChapterIndex = i;

        if (jobData.currentChapterStep < 1) {
          await updateJob(1, `Starting Chapter ${chapter} - Extracting plot`);
          const res = await runAgy(`Extract the plot for Chapter ${chapter} from the outline.`);
          await saveArtifact(jobData.projectId, 'note', `chapter_${chapter}_plot`, res.stdout);
          jobData.currentChapterStep = 1;
        }

        if (jobData.currentChapterStep < 2) {
          await updateJob(2, `Chapter ${chapter}: Plot Scene Brief`);
          const res = await runAgy("Break the chapter plot into smaller beats.");
          await saveArtifact(jobData.projectId, 'note', `chapter_${chapter}_beats`, res.stdout);
          jobData.currentChapterStep = 2;
        }

        if (jobData.currentChapterStep < 3) {
          await updateJob(3, `Chapter ${chapter}: Character Scene Brief`);
          const res = await runAgy("Detail character goals and emotional states for this scene.");
          await saveArtifact(jobData.projectId, 'note', `chapter_${chapter}_characters_brief`, res.stdout);
          jobData.currentChapterStep = 3;
        }

        if (jobData.currentChapterStep < 4) {
          await updateJob(4, `Chapter ${chapter}: Worldbuilding Scene Brief`);
          const res = await runAgy("Detail the setting and environment for this scene.");
          await saveArtifact(jobData.projectId, 'note', `chapter_${chapter}_setting_brief`, res.stdout);
          jobData.currentChapterStep = 4;
        }

        if (jobData.currentChapterStep < 5) {
          await updateJob(5, `Chapter ${chapter}: Chronology Check 1`);
          const res = await runAgy("Ensure the brief is consistent with the overall timeline.");
          await saveArtifact(jobData.projectId, 'note', `chapter_${chapter}_chronology_check`, res.stdout);
          jobData.currentChapterStep = 5;
        }

        if (jobData.currentChapterStep < 6) {
          await updateJob(6, `Chapter ${chapter}: Plot Scene Rewrite`);
          const res = await runAgy("Adjust the plot brief based on chronology.");
          await saveArtifact(jobData.projectId, 'note', `chapter_${chapter}_plot_revised`, res.stdout);
          jobData.currentChapterStep = 6;
        }

        if (jobData.currentChapterStep < 7) {
          await updateJob(7, `Chapter ${chapter}: Character & World Rewrite`);
          const res = await runAgy("Adjust character and world briefs based on chronology.");
          await saveArtifact(jobData.projectId, 'note', `chapter_${chapter}_briefs_revised`, res.stdout);
          jobData.currentChapterStep = 7;
        }

        if (jobData.currentChapterStep < 9) {
          await updateJob(9, `Chapter ${chapter}: First Draft`);
          const res = await runAgy(`Write the prose for the chapter using ${pov} and ${tense}.`);
          await saveArtifact(jobData.projectId, 'chapter', `chapter-${chapter}`, res.stdout, parseInt(chapter) || 999);
          jobData.currentChapterStep = 9;
        }

        if (jobData.currentChapterStep < 10) {
          await updateJob(10, `Chapter ${chapter}: Chronology Check 2`);
          const res = await runAgy("Check the written prose for timeline errors.");
          await saveArtifact(jobData.projectId, 'note', `chapter_${chapter}_chronology_check_2`, res.stdout);
          jobData.currentChapterStep = 10;
        }

        if (jobData.currentChapterStep < 11) {
          await updateJob(11, `Chapter ${chapter}: Style Check`);
          const res = await runAgy("Ensure the prose matches the genre style guide.");
          await saveArtifact(jobData.projectId, 'note', `chapter_${chapter}_style_check`, res.stdout);
          jobData.currentChapterStep = 11;
        }

        if (jobData.currentChapterStep < 12) {
          await updateJob(12, `Chapter ${chapter}: Rewrite`);
          const res = await runAgy("Adjust the prose based on style and chronology checks.");
          await saveArtifact(jobData.projectId, 'chapter', `chapter-${chapter}`, res.stdout, parseInt(chapter) || 999);
          jobData.currentChapterStep = 12;
        }

        if (jobData.currentChapterStep < 13) {
          const isLastChapter = (i === chapters.length - 1);
          const res = await runAgy("Provide any final prose polish if needed, or return the final prose.");
          await saveArtifact(jobData.projectId, 'chapter', `chapter-${chapter}`, res.stdout, parseInt(chapter) || 999);
          await updateJob(13, `Chapter ${chapter}: Final Draft`, isLastChapter ? 'complete' : 'running');
          jobData.currentChapterStep = 0; // reset step for the next chapter
        }
      }
    }
  } catch (e) {
    console.error('Job Error:', e);
    await updateJob(jobData.progress, `Error: ${e.message}`, 'error');
  }
}

module.exports = router;
