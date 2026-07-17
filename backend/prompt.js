const express = require('express');
const router = express.Router();
const crypto = require('crypto');
const { generateContent } = require('./geminiClient');

const { Template, History, Project, Chapter, Character, Note, ContextFile } = require('./mongoDB');

// Compile and format context data based on declared context types
async function resolveContextData(projectId, contextList) {
  if (!contextList || contextList.length === 0) return '';
  let contextStr = '';

  const project = await Project.findOne({ id: projectId }).lean();
  
  for (const ctx of contextList) {
    if (ctx === 'project' && project) {
      contextStr += `\n[Project Metadata]\nName: ${project.name}\nPOV: ${project.writingPOV || 'Not specified'}\nTense: ${project.writingTense || 'Not specified'}\n`;
    }
    else if (ctx === 'chapters') {
      const chapters = await Chapter.find({ projectId }).sort({ orderIndex: 1 }).lean();
      if (chapters.length > 0) {
        contextStr += '\n[Project Chapters]\n' + chapters.map(c => `--- Chapter: ${c.id} ---\n${c.content}`).join('\n\n') + '\n';
      }
    }
    else if (ctx === 'characters') {
      const characters = await Character.find({ projectId }).lean();
      if (characters.length > 0) {
        contextStr += '\n[Character Profiles]\n' + characters.map(c => `--- Character: ${c.name || c.id} ---\n${c.content}`).join('\n\n') + '\n';
      }
    }
    else if (ctx === 'notes') {
      const notes = await Note.find({ projectId }).lean();
      if (notes.length > 0) {
        contextStr += '\n[Project Notes & Outlines]\n' + notes.map(n => `--- Note: ${n.name || n.id} ---\n${n.content}`).join('\n\n') + '\n';
      }
    }
    else if (ctx === 'dossier') {
      const dossierNote = await Note.findOne({ projectId, id: 'dossier' }).lean();
      if (dossierNote) {
        contextStr += `\n[Project Dossier]\n${dossierNote.content}\n`;
      } else {
        const dossierNotes = await Note.find({ projectId, id: /dossier/i }).lean();
        if (dossierNotes.length > 0) {
          contextStr += '\n[Project Dossier]\n' + dossierNotes.map(n => n.content).join('\n\n') + '\n';
        }
      }
    }
    else if (ctx === 'templates') {
      const templates = await Template.find({ templateBehavior: 'Context Skill' }).lean();
      if (templates.length > 0) {
        contextStr += '\n[Writing Rules & Style Guidelines]\n' + templates.map(t => `--- ${t.name} ---\n${t.content}`).join('\n\n') + '\n';
      }
    }
    else if (ctx === 'workspace') {
      const files = await ContextFile.find({ projectId }).lean();
      if (files.length > 0) {
        contextStr += '\n[Workspace Files]\n' + files.map(f => `Path: ${f.path}\nContent:\n${f.content}`).join('\n\n') + '\n';
      }
    }
  }

  return contextStr;
}

router.post('/api/ai/chat', async (req, res) => {
  const { message, templateIds, projectId } = req.body;
  const userId = req.headers['x-user-id'] || 'system';
  if (!message) return res.status(400).json({ error: 'Missing message' });

  // Separate high-level context categories from template IDs
  const highLevelTypes = ['dossier', 'project', 'chapters', 'characters', 'notes', 'templates', 'workspace'];
  const selectedContextTypes = (templateIds || []).filter(id => highLevelTypes.includes(id));
  const selectedTemplateIds = (templateIds || []).filter(id => !highLevelTypes.includes(id));

  // Get templates content if provided
  let contextStr = '';
  if (selectedContextTypes.length > 0) {
    contextStr += await resolveContextData(projectId, selectedContextTypes);
  }
  if (selectedTemplateIds.length > 0) {
    const selectedTmpls = await Template.find({ id: { $in: selectedTemplateIds } }).lean();
    if (selectedTmpls.length > 0) {
      contextStr += '\nContext Templates:\n' + selectedTmpls.map(t => `--- ${t.name} ---\n${t.content}`).join('\n\n');
    }
  }

  // Create job history entry
  const jobId = crypto.randomUUID();
  await History.create({
    jobId,
    userId,
    projectId: projectId || 'global',
    type: 'ai_chat',
    status: 'running',
    progress: 0,
    totalSteps: 1,
    currentStep: 0,
    logs: [`Prompt: ${message}`]
  });

  const updateJob = async (status, log) => {
    const logs = [`Prompt: ${message}`];
    if (log) logs.push(log);
    await History.findOneAndUpdate(
      { jobId: jobId },
      {
        status,
        progress: (status === 'complete' || status === 'error') ? 1.0 : 0,
        logs
      }
    );
  };

  try {
    const payload = contextStr ? `Context: ${contextStr}\n\nPrompt: ${message}` : message;
    
    console.log('Sending direct chat request to Gemini...');
    const reply = await generateContent({
      message: payload,
      isSubagent: false
    });

    await updateJob('complete', `Response: ${reply}`);
    res.json({ reply });

  } catch (error) {
    console.error('Direct AI Chat API error:', error.message);
    await updateJob('error', `API Error: ${error.message}`);
    res.status(500).json({ error: 'Failed to process AI chat via direct API' });
  }
});

module.exports = router;
