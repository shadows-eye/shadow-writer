const { generateContent } = require('./geminiClient');

class SubagentEngine {
  constructor(jobData, updateJobCallback) {
    this.jobData = jobData;
    this.updateJob = updateJobCallback;
  }

  /**
   * Run the Subagent's internal Plan -> Execute -> Test loop.
   * @param {Object} params
   * @param {Object} params.subagentTmpl - The subagent template document from MongoDB
   * @param {String} params.contextSummary - Summary of the context topic/previous step outputs
   * @param {String} params.taskInstruction - The specific task instruction for this step
   * @param {String} params.specificContext - The specific context files/metadata for this step
   */
  async execute({ subagentTmpl, contextSummary, taskInstruction, specificContext }) {
    const subagentName = subagentTmpl.name;
    const model = subagentTmpl.model || 'gemini-3.1-flash-lite';
    const thinkingLevel = subagentTmpl.thinkingLevel || 'low';

    // Helper to call Gemini Client and log responses into the active job history
    const callLLM = async (prompt, systemInstruction = '') => {
      const fullPrompt = systemInstruction ? `${systemInstruction}\n\n${prompt}` : prompt;
      const responseText = await generateContent({
        message: fullPrompt,
        isSubagent: true,
        model: model,
        thinkingLevel: thinkingLevel
      });

      // Log subagent conversations into the active job history
      if (this.jobData && this.jobData.chatHistory) {
        this.jobData.chatHistory.push({
          role: 'user',
          content: `[Subagent ${subagentName}]: ${prompt.substring(0, 500)}${prompt.length > 500 ? '...' : ''}`
        });
        this.jobData.chatHistory.push({
          role: 'model',
          content: responseText
        });
      }

      return responseText;
    };

    // Step 1: Structure & Plan
    await this.updateJob(null, `[Subagent: ${subagentName}] Analyzing instructions and creating execution plan...`);
    
    const planningInstruction = `You are the planning unit of the subagent "${subagentName}". Analyze the target instructions, the context topic, the specific task, and the specific context files. Create a step-by-step plan on how to execute the task to meet all qualifications. Do not perform the task yet, only output the step-by-step execution plan.`;
    
    const planningPrompt = `Subagent Template Content / Overall Instructions:
${subagentTmpl.content}

Context Topic:
${contextSummary}

Specific Task Instruction:
${taskInstruction}

Specific Context / Files:
${specificContext}`;

    const executionPlan = await callLLM(planningPrompt, planningInstruction);
    let currentPlan = executionPlan;

    let iteration = 0;
    const maxLocalIterations = 2; // Keep local refinement cycle tight and fast
    let outputResult = '';
    let pass = false;
    let feedback = '';

    while (iteration < maxLocalIterations && !pass) {
      iteration++;
      await this.updateJob(null, `[Subagent: ${subagentName}] Executing plan (Local Attempt ${iteration}/${maxLocalIterations})...`);

      // Step 2: Execute
      const executionInstruction = `You are the execution unit of the subagent "${subagentName}". Solve the task using the provided plan, context, and specific instructions. Output the final result directly without any extra planning or conversational remarks.`;
      
      let executionPrompt = `Subagent Template Content / Overall Instructions:
${subagentTmpl.content}

Specific Context / Files:
${specificContext}

Specific Task Instruction:
${taskInstruction}

Execution Plan:
${currentPlan}`;

      if (iteration > 1) {
        executionPrompt += `\n\nPrevious attempt failed local validation with feedback:\n${feedback}\n\nPlease adjust your execution based on this feedback and try again.`;
      }

      outputResult = await callLLM(executionPrompt, executionInstruction);

      // Step 3: Local Test (Check if result fits to the request using the subagent template text)
      await this.updateJob(null, `[Subagent: ${subagentName}] Performing local quality checks...`);
      
      const testInstruction = `You are the quality assurance unit of the subagent "${subagentName}". You must test the subagent's output against the target Task Instructions and overall instructions to verify if all requirements are met.
Respond strictly in the following JSON format:
{
  "pass": true/false,
  "reason": "Detailed explanation of why the output passed or failed validation",
  "adjustments": "If failed, state exactly what adjustments are needed for the execution plan or output"
}`;

      const testPrompt = `Target Task Instructions:
${subagentTmpl.content}

Specific Task Instruction:
${taskInstruction}

Generated Output:
${outputResult}`;

      const testResponse = await callLLM(testPrompt, testInstruction);

      try {
        const cleanedJson = testResponse.replace(/```json/g, '').replace(/```/g, '').trim();
        const evaluation = JSON.parse(cleanedJson);
        pass = !!evaluation.pass;
        feedback = `Reason: ${evaluation.reason}\nAdjustments needed: ${evaluation.adjustments || 'None'}`;
        if (!pass && evaluation.adjustments) {
          currentPlan = `${currentPlan}\n\nAdjusted plan step for retry:\n${evaluation.adjustments}`;
        }
      } catch (e) {
        console.warn("Failed to parse local subagent evaluation JSON, falling back to text parsing:", e);
        // Simple text fallback
        if (testResponse.toLowerCase().includes('"pass": true') || testResponse.toLowerCase().includes('pass: true')) {
          pass = true;
          feedback = 'Passed validation (text fallback)';
        } else {
          pass = false;
          feedback = testResponse;
          currentPlan = `${currentPlan}\n\nAdjusted plan step for retry (text fallback):\n${testResponse}`;
        }
      }

      if (pass) {
        await this.updateJob(null, `[Subagent: ${subagentName}] Local quality check PASSED.`);
      } else {
        await this.updateJob(null, `[Subagent: ${subagentName}] Local quality check FAILED. Adjusting plan...`);
      }
    }

    return outputResult;
  }
}

module.exports = { SubagentEngine };
