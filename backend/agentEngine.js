const express = require('express');
const router = express.Router();
const crypto = require('crypto');
const path = require('path');

const { generateContent } = require('./geminiClient');

const { jobs, execAsync } = require('./server');
const { Project, Template, History, Note, Chapter, Character, Artifact, ContextFile, extractAttributesAndContent } = require('./mongoDB');
const { SubagentEngine } = require('./subagentEngine');

// Helper to replace variable placeholders in prompts or paths
function interpolateString(str, payload) {
  if (!str) return '';
  let result = str;
  for (const [key, value] of Object.entries(payload || {})) {
    result = result.replace(new RegExp(`{{\\s*${key}\\s*}}`, 'g'), value);
  }
  return result;
}

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
      const artifacts = await Artifact.find({ projectId }).lean();
      if (artifacts.length > 0) {
        contextStr += '\n[Project Artifacts]\n' + artifacts.map(a => `--- Artifact: ${a.name || a.id} ---\n${a.content}`).join('\n\n') + '\n';
      }
    }
    else if (ctx === 'dossier') {
      const dossierNote = await Note.findOne({ projectId, id: 'dossier' }).lean();
      if (dossierNote) {
        contextStr += `\n[Project Dossier]\n${dossierNote.content}\n`;
      } else {
        const dossierNotes = await Note.find({ projectId, id: /dossier/i }).lean();
        const dossierArtifacts = await Artifact.find({ projectId, id: /dossier/i }).lean();
        const allDossiers = [...dossierNotes, ...dossierArtifacts];
        if (allDossiers.length > 0) {
          contextStr += '\n[Project Dossier]\n' + allDossiers.map(d => d.content).join('\n\n') + '\n';
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

async function saveArtifact(projectId, type, id, content, orderIndex = null) {
  try {
    const { attributes, cleanContent } = extractAttributesAndContent(content);

    if (type === 'chapter') {
      await Chapter.findOneAndUpdate(
        { projectId, id },
        { content: cleanContent, attributes, orderIndex: orderIndex !== null ? orderIndex : 999, lastEdited: new Date() },
        { upsert: true }
      );
    } else if (type === 'character') {
      const nameMatch = cleanContent.match(/^\s*#\s+(.+)$/m);
      const name = attributes.name || (nameMatch ? nameMatch[1].trim() : id);
      await Character.findOneAndUpdate(
        { projectId, id },
        { name, content: cleanContent, attributes, lastEdited: new Date() },
        { upsert: true }
      );
    } else if (type === 'artifact') {
      const name = attributes.name || id;
      await Artifact.findOneAndUpdate(
        { projectId, id },
        { name, type: 'artifact', content: cleanContent, attributes, lastEdited: new Date() },
        { upsert: true }
      );
    } else {
      const name = attributes.name || id;
      const noteType = attributes.type || type || 'note';
      await Note.findOneAndUpdate(
        { projectId, id },
        { name, type: noteType, content: cleanContent, attributes, lastEdited: new Date() },
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
    const job = await History.findOne({ jobId: resumeJobId });
    if (!job) return res.status(404).json({ error: 'Job not found to resume' });

    job.status = 'running';
    job.logs.push(`[${new Date().toISOString()}] Resuming pipeline execution from step ${job.currentStep || 0}...`);
    await job.save();

    const jobData = {
      id: job.jobId,
      userId: job.userId,
      projectId: job.projectId,
      type: job.type,
      status: job.status,
      progress: job.progress,
      totalSteps: job.totalSteps,
      currentStep: job.currentStep,
      chatHistory: job.chatHistory || [],
      logs: job.logs,
      payload: job.payload
    };

    runAutomationLoop(resumeJobId, jobData, job.payload || payload);
    return res.json({ success: true, jobId: resumeJobId });
  }

  if (!type || !projectId) return res.status(400).json({ error: 'Missing type or projectId' });

  // Resolve template to determine steps
  let templateId = type;
  if (templateId === 'braindump_to_dossier') templateId = 'dossier';
  const template = await Template.findOne({ id: templateId });
  const subagentsCount = (template && template.subagents) ? template.subagents.length : 10;
  
  let totalSteps = subagentsCount + 1; // 1 (main Agent planning) + N (subagents)
  if (type === 'chapter_generator' && payload && payload.chapters) {
    totalSteps = payload.chapters.length * subagentsCount;
  }

  const jobId = crypto.randomUUID();
  const jobData = {
    id: jobId,
    userId,
    projectId,
    type,
    status: 'running',
    progress: 0,
    totalSteps,
    currentStep: 0,
    chatHistory: [],
    logs: [],
    payload,
    createdAt: new Date().toISOString()
  };

  await History.create({
    jobId,
    userId,
    projectId,
    type,
    status: 'running',
    progress: 0,
    totalSteps,
    currentStep: 0,
    logs: [],
    chatHistory: [],
    payload
  });

  runAutomationLoop(jobId, jobData, payload);

  res.json({ success: true, jobId });
});

router.get('/api/automation/history', async (req, res) => {
  const userId = req.headers['x-user-id'] || 'system';
  try {
    const list = await History.find({ userId }).sort({ timestamp: -1 }).lean();
    const formatted = list.map(j => ({
      id: j.jobId,
      userId: j.userId,
      projectId: j.projectId,
      type: j.type,
      status: j.status,
      progress: j.progress,
      totalSteps: j.totalSteps,
      currentStep: j.currentStep,
      logs: j.logs || [],
      createdAt: j.timestamp ? j.timestamp.toISOString() : new Date().toISOString()
    }));
    res.json({ history: formatted });
  } catch (e) {
    console.error('Error fetching history:', e);
    res.status(500).json({ error: 'Failed to fetch automation history' });
  }
});

router.post('/api/automation/log', async (req, res) => {
  const { jobId, userId, projectId, type, status, progress, log, createIfMissing } = req.body;
  if (!jobId) return res.status(400).json({ error: 'Missing jobId' });

  try {
    let job = await History.findOne({ jobId });

    if (!job) {
      if (!createIfMissing) {
        return res.status(404).json({ error: 'Job not found' });
      }
      job = new History({
        jobId,
        userId: userId || 'system',
        projectId: projectId || 'global',
        type: type || 'agent_chat',
        status: status || 'running',
        progress: progress || 0,
        totalSteps: 1,
        currentStep: 0,
        logs: []
      });
    }

    if (status) job.status = status;
    if (progress !== undefined) job.progress = progress;
    if (log) job.logs.push(`[${new Date().toISOString()}] ${log}`);

    await job.save();
    res.json({ success: true, job });
  } catch (e) {
    console.error('Error in automation logging:', e);
    res.status(500).json({ error: 'Failed to update job logs' });
  }
});

// --- Helper to dynamically generate the task list ---
async function generateAgentTaskList(template, agentContext, payload, availableSubagents) {
  const prompt = `You are the parent agent "${template.name}".
Overall Instructions & Goal:
${template.content}

Project Context & Information:
${agentContext}

Available subagent templates that you can delegate specific tasks to:
${availableSubagents.map(t => `- ID: "${t.id}" (Name: "${t.name}")\n  Instructions: ${t.content}`).join('\n')}

Based on your overall goal, the context, and the available subagents, formulate a structured step-by-step task list (execution plan) to accomplish your goal.
Each task must be assigned to one of the available subagent template IDs that best fits the task.
Output IDs should represent the specific output artifact name (e.g., "story_dossier", "genre_tropes", "outline_acts", etc.).
For steps that yield the final compiled output that the user wants (e.g. the final dossier or final outline), set "outputType" to "note", otherwise set "outputType" to "artifact".

Respond strictly in the following JSON format:
{
  "tasks": [
    {
      "step": 1,
      "taskDescription": "Detailed specific task instructions for the subagent...",
      "subagentTemplateId": "subagent_template_id_here",
      "outputType": "artifact",
      "outputId": "output_id_here"
    }
  ]
}`;

  try {
    const result = await generateContent({
      message: prompt,
      isSubagent: false,
      model: template.model || 'gemini-3.5-flash',
      thinkingLevel: template.thinkingLevel || 'high'
    });

    const cleanedJson = result.replace(/```json/g, '').replace(/```/g, '').trim();
    const parsed = JSON.parse(cleanedJson);
    if (parsed && Array.isArray(parsed.tasks)) {
      return parsed.tasks;
    }
  } catch (err) {
    console.error("Failed to generate dynamic task list:", err);
  }
  return null;
}

// --- Helper to verify the overall goal is satisfied ---
async function verifyOverallGoal(template, agentContext, finalOutput, availableSubagents) {
  const prompt = `You are the parent agent "${template.name}".
Your overall goal is:
${template.content}

Project Context:
${agentContext}

Final Compiled Output:
${finalOutput}

Evaluate whether the final compiled output fully satisfies your overall goal and project requirements.
If satisfied is false, identify the specific subagent template ID best suited to correct the deficiencies.
Respond strictly in the following JSON format:
{
  "satisfied": true/false,
  "reason": "Detailed critique/reasons if not satisfied, or congratulations if satisfied",
  "correction": {
    "subagentTemplateId": "ID of the subagent best suited to fix the deficiencies (e.g., a style guide auditor, prose reviser, or logic critiquer)",
    "instruction": "Specific, focused instructions telling that subagent what parts need adjustments and how to fix them."
  }
}`;

  try {
    const result = await generateContent({
      message: prompt,
      isSubagent: false,
      model: template.model || 'gemini-3.5-flash',
      thinkingLevel: template.thinkingLevel || 'high'
    });

    const cleanedJson = result.replace(/```json/g, '').replace(/```/g, '').trim();
    return JSON.parse(cleanedJson);
  } catch (err) {
    console.error("Failed to verify overall goal:", err);
    return { satisfied: true, reason: "Passed (JSON parse failure fallback)" };
  }
}

// --- Automation Loop Execution ---
async function runAutomationLoop(jobId, jobData, payload) {
  jobData.chatHistory = jobData.chatHistory || [];
  jobData.currentStep = jobData.currentStep || 0;

  if (jobData.type === 'template_generator' && payload && payload.templateName) {
    const cleanName = payload.templateName.toLowerCase().replace(/[^a-z0-9]+/g, '-');
    if (cleanName.includes('template-generator') || payload.templateName.toLowerCase().includes('template generator')) {
      throw new Error('Generating Template Generator templates is not allowed');
    }
  }

  const updateJob = async (progress, log, status = 'running') => {
    if (progress !== null && progress !== undefined) {
      jobData.progress = progress;
    }
    jobData.status = status;
    if (log) jobData.logs.push(`[${new Date().toISOString()}] ${log}`);

    await History.findOneAndUpdate(
      { jobId: jobId },
      { 
        status: jobData.status, 
        progress: jobData.progress,
        logs: jobData.logs,
        chatHistory: jobData.chatHistory,
        currentStep: jobData.currentStep
      }
    );

    const res = jobs.get(jobId);
    if (res) {
      res.write(`data: ${JSON.stringify(jobData)}\n\n`);
    }
  };

  try {
    const runAgy = async (prompt, isSubagent = true, modelOverride = null, thinkingOverride = null) => {
      try {
        const responseText = await generateContent({
          message: prompt,
          isSubagent,
          model: modelOverride,
          thinkingLevel: thinkingOverride
        });
        jobData.chatHistory.push({ role: 'user', content: prompt });
        jobData.chatHistory.push({ role: 'model', content: responseText });
        return { stdout: responseText, stderr: '' };
      } catch (e) {
        console.error("Failed to call direct Gemini chat:", e);
        throw e;
      }
    };

    // Determine target agent template ID
    let templateId = jobData.type;
    if (templateId === 'braindump_to_dossier') templateId = 'dossier';

    const template = await Template.findOne({ id: templateId });
    if (!template) {
      throw new Error(`Workflow template not found for type: ${jobData.type}`);
    }

    const subagentTemplates = await Template.find({ templateType: 'Subagent' }).lean();
    const subagents = template.subagents || [];
    const subagentCount = subagents.length;
    const subagentEngine = new SubagentEngine(jobData, updateJob);

    // --- Dynamic Execution: Chapter Generation Loop ---
    if (jobData.type === 'chapter_generator') {
      const { chapters, pov, tense } = payload;
      jobData.currentChapterIndex = jobData.currentChapterIndex || 0;
      jobData.currentChapterStep = jobData.currentChapterStep || 0;

      let previousOutput = '';

      for (let i = jobData.currentChapterIndex; i < chapters.length; i++) {
        const chapter = chapters[i];
        jobData.currentChapterIndex = i;

        const chapterPayload = { ...payload, chapter, pov, tense };

        for (let s = jobData.currentChapterStep; s < subagentCount; s++) {
          const subTask = subagents[s];
          jobData.currentChapterStep = s;

          const subagentTmpl = await Template.findOne({ id: subTask.subagentTemplateId });
          if (!subagentTmpl) {
            throw new Error(`Subagent template not found: ${subTask.subagentTemplateId}`);
          }

          const progressPct = ((i * subagentCount + s) / (chapters.length * subagentCount)) * 0.95 + 0.05;
          await updateJob(progressPct, `Chapter ${chapter}: ${subagentTmpl.name}...`);

          // Fetch only declared subagent context type inputs
          let subContext = await resolveContextData(jobData.projectId, subTask.contextInputs || []);

          // Auto-propagate Context Skills linked to the parent workflow
          const parentContextTypes = template.contextTypes || [];
          if (parentContextTypes.length > 0) {
            const linkedContexts = await Template.find({
              id: { $in: parentContextTypes },
              templateBehavior: 'Context Skill'
            }).lean();
            if (linkedContexts.length > 0) {
              const linkedContextStr = linkedContexts
                .map(t => `\n--- Context Guide: ${t.name} ---\n${t.content}`)
                .join('\n');
              subContext = linkedContextStr + '\n' + subContext;
            }
          }

          // Interpolate variables
          const taskPrompt = interpolateString(subagentTmpl.content || '', chapterPayload);
          const outputId = interpolateString(subTask.outputId, chapterPayload);

          // Subagent local Plan -> Execute -> Test execution
          const subResultText = await subagentEngine.execute({
            subagentTmpl,
            contextSummary: previousOutput || `Chapter ${chapter} Generation`,
            taskInstruction: taskPrompt,
            specificContext: subContext
          });

          // Parent Agent evaluates the output against the broad context
          await updateJob(progressPct, `Chapter ${chapter}: Parent Agent evaluating ${subagentTmpl.name}...`);
          const broadContext = await resolveContextData(jobData.projectId, template.contextTypes || []);
          
          let isAccepted = false;
          let parentIteration = 0;
          const maxParentIterations = 3;
          let refinedTaskInstruction = taskPrompt;
          let finalSubResultText = subResultText;

          while (parentIteration < maxParentIterations && !isAccepted) {
            parentIteration++;
            if (parentIteration > 1) {
              await updateJob(progressPct, `Chapter ${chapter}: Reworking ${subagentTmpl.name} (Parent Attempt ${parentIteration}/${maxParentIterations})...`);
              finalSubResultText = await subagentEngine.execute({
                subagentTmpl,
                contextSummary: previousOutput || `Chapter ${chapter} Generation`,
                taskInstruction: refinedTaskInstruction,
                specificContext: subContext
              });
            }

            const parentEvaluationPrompt = `You are the Parent Agent "${template.name}". Evaluate if the subagent's output fits the broad project context and chapter goals.
Broad Project Context:
${broadContext}

Subagent Output:
${finalSubResultText}

Respond strictly in JSON format:
{
  "accepted": true/false,
  "reason": "Critique or justification of acceptance",
  "refinedTaskInstruction": "If rejected, rewrite the subagent instructions to fix the deficient parts."
}`;

            const parentEvaluationResult = await runAgy(parentEvaluationPrompt, false, template.model, template.thinkingLevel);
            try {
              const cleanedJson = parentEvaluationResult.stdout.replace(/```json/g, '').replace(/```/g, '').trim();
              const parentEval = JSON.parse(cleanedJson);
              isAccepted = !!parentEval.accepted;
              if (!isAccepted && parentEval.refinedTaskInstruction) {
                refinedTaskInstruction = parentEval.refinedTaskInstruction;
              }
            } catch (e) {
              if (parentEvaluationResult.stdout.toLowerCase().includes('"accepted": true') || parentEvaluationResult.stdout.toLowerCase().includes('accepted: true')) {
                isAccepted = true;
              } else {
                isAccepted = false;
                refinedTaskInstruction = `${taskPrompt}\n\nParent critique:\n${parentEvaluationResult.stdout}`;
              }
            }
          }

          await saveArtifact(jobData.projectId, subTask.outputType, outputId, finalSubResultText, parseInt(chapter) || 999);
          previousOutput = finalSubResultText;
        }
        jobData.currentChapterStep = 0; // reset for the next chapter
      }

      await updateJob(1.0, `Finished Chapter Generation`, 'complete');

    } else {
      // --- Dynamic Execution: Standard Single Asset Workflow (e.g. Dossier, Outline) ---
      let previousOutput = '';

      // Check if we already have a task list saved in the database
      const taskListArtifact = await Artifact.findOne({ projectId: jobData.projectId, id: `${template.id}_task_list` }).lean();
      let tasks = [];
      if (taskListArtifact) {
        try {
          tasks = JSON.parse(taskListArtifact.content);
        } catch (e) {
          console.error("Failed to parse task list artifact, will regenerate:", e);
        }
      }

      if (tasks.length === 0) {
        await updateJob(0.02, `Initializing workflow and planning task list...`);
        const agentContext = await resolveContextData(jobData.projectId, template.contextTypes || []);
        
        // Generate dynamic task list
        tasks = await generateAgentTaskList(template, agentContext, payload, subagentTemplates);
        if (!tasks || tasks.length === 0) {
          // Fallback to static steps
          tasks = (template.subagents || []).map(sa => ({
            step: sa.step,
            taskDescription: `Perform step ${sa.step} using template instructions.`,
            subagentTemplateId: sa.subagentTemplateId,
            outputType: sa.outputType,
            outputId: sa.outputId
          }));
        }

        // Save task list and initial plan
        await saveArtifact(jobData.projectId, 'artifact', `${template.id}_task_list`, JSON.stringify(tasks, null, 2));
        
        const planMarkdown = `# ${template.name} Execution Plan\n\nGenerated Tasks:\n` + 
          tasks.map(t => `### Step ${t.step}: Assign to ${t.subagentTemplateId}\n- **Task**: ${t.taskDescription}\n- **Output**: ${t.outputId} (${t.outputType})`).join('\n\n');
        await saveArtifact(jobData.projectId, 'artifact', `${template.id}_plan`, planMarkdown);
        
        previousOutput = planMarkdown;
        jobData.currentStep = 0;
      } else {
        const planArtifact = await Artifact.findOne({ projectId: jobData.projectId, id: `${template.id}_plan` }).lean();
        previousOutput = planArtifact ? planArtifact.content : '';
      }

      for (let s = jobData.currentStep; s < tasks.length; s++) {
        const task = tasks[s];
        jobData.currentStep = s + 1; // update for resume support

        const subagentTmpl = await Template.findOne({ id: task.subagentTemplateId });
        if (!subagentTmpl) {
          throw new Error(`Subagent template not found: ${task.subagentTemplateId}`);
        }

        const progressPct = ((s + 1) / tasks.length) * 0.9 + 0.05;
        await updateJob(progressPct, `Step ${s + 1}/${tasks.length}: ${subagentTmpl.name}...`);

        // Fetch declared subagent context inputs
        const contextInputs = subagentTmpl.contextTypes || ['notes'];
        let subContext = await resolveContextData(jobData.projectId, contextInputs);

        // Auto-propagate Context Skills linked to parent
        const parentContextTypes = template.contextTypes || [];
        if (parentContextTypes.length > 0) {
          const linkedContexts = await Template.find({
            id: { $in: parentContextTypes },
            templateBehavior: 'Context Skill'
          }).lean();
          if (linkedContexts.length > 0) {
            const linkedContextStr = linkedContexts
              .map(t => `\n--- Context Guide: ${t.name} ---\n${t.content}`)
              .join('\n');
            subContext = linkedContextStr + '\n' + subContext;
          }
        }

        // Interpolate variables if any
        const taskPrompt = interpolateString(task.taskDescription, payload);
        const outputId = interpolateString(task.outputId, payload);

        // Execute subagent internal loop
        const subResultText = await subagentEngine.execute({
          subagentTmpl,
          contextSummary: previousOutput || `${template.name} Outline Plan`,
          taskInstruction: taskPrompt,
          specificContext: subContext
        });

        // Parent Agent evaluates the output against the broad context
        await updateJob(progressPct, `Step ${s + 1}/${tasks.length}: Parent Agent evaluating ${subagentTmpl.name}...`);
        const broadContext = await resolveContextData(jobData.projectId, template.contextTypes || []);
        
        let isAccepted = false;
        let parentIteration = 0;
        const maxParentIterations = 3;
        let refinedTaskInstruction = taskPrompt;
        let finalSubResultText = subResultText;

        while (parentIteration < maxParentIterations && !isAccepted) {
          parentIteration++;
          if (parentIteration > 1) {
            await updateJob(progressPct, `Step ${s + 1}/${tasks.length}: Reworking ${subagentTmpl.name} (Parent Attempt ${parentIteration}/${maxParentIterations})...`);
            finalSubResultText = await subagentEngine.execute({
              subagentTmpl,
              contextSummary: previousOutput || `${template.name} Outline Plan`,
              taskInstruction: refinedTaskInstruction,
              specificContext: subContext
            });
          }

          const parentEvaluationPrompt = `You are the Parent Agent "${template.name}". Evaluate if the subagent's output fits the broad project context and task goals.
Broad Project Context:
${broadContext}

Subagent Output:
${finalSubResultText}

Respond strictly in JSON format:
{
  "accepted": true/false,
  "reason": "Critique or justification of acceptance",
  "refinedTaskInstruction": "If rejected, rewrite the subagent instructions to fix the deficient parts."
}`;

          const parentEvaluationResult = await runAgy(parentEvaluationPrompt, false, template.model, template.thinkingLevel);
          try {
            const cleanedJson = parentEvaluationResult.stdout.replace(/```json/g, '').replace(/```/g, '').trim();
            const parentEval = JSON.parse(cleanedJson);
            isAccepted = !!parentEval.accepted;
            if (!isAccepted && parentEval.refinedTaskInstruction) {
              refinedTaskInstruction = parentEval.refinedTaskInstruction;
            }
          } catch (e) {
            if (parentEvaluationResult.stdout.toLowerCase().includes('"accepted": true') || parentEvaluationResult.stdout.toLowerCase().includes('accepted: true')) {
              isAccepted = true;
            } else {
              isAccepted = false;
              refinedTaskInstruction = `${taskPrompt}\n\nParent critique:\n${parentEvaluationResult.stdout}`;
            }
          }
        }

        await saveArtifact(jobData.projectId, task.outputType, outputId, finalSubResultText);
        previousOutput = finalSubResultText;
      }

      // Final Overall Goal Verification & Correction loop
      await updateJob(0.95, `Performing final overall goal verification...`);
      const lastTask = tasks[tasks.length - 1];
      const targetOutputId = interpolateString(lastTask.outputId, payload);
      
      const finalCompiledArtifact = await Artifact.findOne({ projectId: jobData.projectId, id: targetOutputId }).lean() 
        || await Note.findOne({ projectId: jobData.projectId, id: targetOutputId }).lean();
      
      if (finalCompiledArtifact) {
        const broadContext = await resolveContextData(jobData.projectId, template.contextTypes || []);
        let goalVerification = await verifyOverallGoal(template, broadContext, finalCompiledArtifact.content, subagentTemplates);
        
        let correctionIteration = 0;
        const maxCorrectionIterations = 2;
        while (!goalVerification.satisfied && correctionIteration < maxCorrectionIterations) {
          correctionIteration++;
          const correction = goalVerification.correction;
          if (correction && correction.subagentTemplateId) {
            const correctSubTmpl = await Template.findOne({ id: correction.subagentTemplateId });
            if (correctSubTmpl) {
              await updateJob(0.95, `[Final Correction ${correctionIteration}/${maxCorrectionIterations}] Triggering subagent ${correctSubTmpl.name} to refine output...`);
              
              const correctionResultText = await subagentEngine.execute({
                subagentTmpl: correctSubTmpl,
                contextSummary: finalCompiledArtifact.content,
                taskInstruction: correction.instruction,
                specificContext: broadContext
              });

              // Save the corrected result back
              await saveArtifact(jobData.projectId, lastTask.outputType, targetOutputId, correctionResultText);
              finalCompiledArtifact.content = correctionResultText;
              
              // Re-verify
              goalVerification = await verifyOverallGoal(template, broadContext, correctionResultText, subagentTemplates);
            } else {
              break;
            }
          } else {
            break;
          }
        }
      }

      await updateJob(1.0, `Finished ${template.name}`, 'complete');
    }

  } catch (e) {
    console.error('Job Error:', e);
    await updateJob(jobData.progress, `Error: ${e.message}`, 'error');
  }
}

module.exports = router;
