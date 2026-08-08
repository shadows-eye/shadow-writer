const { GoogleAuth } = require('google-auth-library');
const fs = require('fs');
const path = require('path');

// Configure Auth Client
const auth = new GoogleAuth({
  scopes: 'https://www.googleapis.com/auth/cloud-platform'
});

async function getAccessToken() {
  const token = await auth.getAccessToken();
  return `Bearer ${token}`;
}

/**
 * Counts the tokens in a message payload with EU-first -> Global location fallback.
 */
async function countTokens(model, message, token, isVertex = false) {
  try {
    let headers = { 'Content-Type': 'application/json' };
    const payload = { contents: [{ role: 'user', parts: [{ text: message }] }] };

    if (isVertex) {
      const project = process.env.GOOGLE_CLOUD_PROJECT || 'shadowai-497012';
      const locationsToTry = ['eu', 'global', 'us'];

      for (const loc of locationsToTry) {
        const host = (loc === 'us' || loc === 'eu') ? `aiplatform.${loc}.rep.googleapis.com` : 'aiplatform.googleapis.com';
        const url = `https://${host}/v1beta1/projects/${project}/locations/${loc}/publishers/google/models/${model}:countTokens`;
        headers['Authorization'] = token;

        try {
          const res = await fetch(url, { method: 'POST', headers, body: JSON.stringify(payload) });
          if (res.ok) {
            const data = await res.json();
            return data.totalTokens || 0;
          }
        } catch (e) {
          // Continue to next location
        }
      }
    } else {
      const apiKey = process.env.GEMINI_API_KEY;
      const url = `https://aiplatform.googleapis.com/v1beta1/publishers/google/models/${model}:countTokens`;
      headers['x-goog-api-key'] = apiKey;

      const res = await fetch(url, { method: 'POST', headers, body: JSON.stringify(payload) });
      if (res.ok) {
        const data = await res.json();
        return data.totalTokens || 0;
      }
    }
  } catch (e) {
    console.error("Token counting failed:", e);
  }
  return 0;
}

/**
 * Call the generateContent API with EU-first -> Global fallback routing.
 */
async function callGenerateContent(model, contents, config, token, isVertex = false) {
  let headers = { 'Content-Type': 'application/json' };

  if (isVertex) {
    const project = process.env.GOOGLE_CLOUD_PROJECT || 'shadowai-497012';
    // Order of locations: EU first, then global, then US
    const locationsToTry = ['eu', 'global', 'us'];
    let lastVertexError = null;

    for (const loc of locationsToTry) {
      const host = (loc === 'us' || loc === 'eu') ? `aiplatform.${loc}.rep.googleapis.com` : 'aiplatform.googleapis.com';
      const url = `https://${host}/v1beta1/projects/${project}/locations/${loc}/publishers/google/models/${model}:generateContent`;
      headers['Authorization'] = token;

      let payload = {
        contents: contents,
        safetySettings: [
          { category: 'HARM_CATEGORY_HARASSMENT', threshold: 'BLOCK_NONE' },
          { category: 'HARM_CATEGORY_HATE_SPEECH', threshold: 'BLOCK_NONE' },
          { category: 'HARM_CATEGORY_SEXUALLY_EXPLICIT', threshold: 'BLOCK_NONE' },
          { category: 'HARM_CATEGORY_DANGEROUS_CONTENT', threshold: 'BLOCK_NONE' }
        ]
      };
      if (config) {
        payload.generationConfig = {};
        if (config.system_instruction) {
          payload.systemInstruction = { parts: [{ text: config.system_instruction }] };
        }
        if (config.thinking_config) {
          payload.generationConfig.thinkingConfig = {
            thinkingBudget: config.thinking_config.thinking_level === 'high' ? 2048 : 1024
          };
        }
      }

      try {
        const res = await fetch(url, {
          method: 'POST',
          headers,
          body: JSON.stringify(payload)
        });

        if (res.ok) {
          const data = await res.json();
          if (data.candidates && data.candidates[0] && data.candidates[0].content && data.candidates[0].content.parts[0]) {
            return data.candidates[0].content.parts[0].text || '';
          }
        } else if (res.status === 404) {
          console.warn(`[geminiClient] Location '${loc}' returned 404 for model '${model}'. Retrying with next location fallback...`);
          continue; // Try next location in order (e.g. global)
        } else {
          const errText = await res.text();
          throw new Error(`Google API returned status ${res.status}: ${errText}`);
        }
      } catch (err) {
        lastVertexError = err;
      }
    }

    // Fallback to API Key if all Vertex location attempts returned error/404
    if (process.env.GEMINI_API_KEY) {
      console.warn(`[geminiClient] All Vertex locations failed (${lastVertexError?.message}). Retrying via API Key fallback...`);
      return await callGenerateContent(model, contents, config, null, false);
    }
    throw lastVertexError || new Error("All Vertex AI locations failed.");
  } else {
    // API Key Endpoint
    const apiKey = process.env.GEMINI_API_KEY;
    const url = `https://aiplatform.googleapis.com/v1beta1/publishers/google/models/${model}:generateContent`;
    headers['x-goog-api-key'] = apiKey;

    let payload = {
      contents: contents,
      safetySettings: [
        { category: 'HARM_CATEGORY_HARASSMENT', threshold: 'BLOCK_NONE' },
        { category: 'HARM_CATEGORY_HATE_SPEECH', threshold: 'BLOCK_NONE' },
        { category: 'HARM_CATEGORY_SEXUALLY_EXPLICIT', threshold: 'BLOCK_NONE' },
        { category: 'HARM_CATEGORY_DANGEROUS_CONTENT', threshold: 'BLOCK_NONE' }
      ]
    };
    if (config) {
      payload.generationConfig = {};
      if (config.system_instruction) {
        payload.systemInstruction = { parts: [{ text: config.system_instruction }] };
      }
      if (config.thinking_config) {
        payload.generationConfig.thinkingConfig = {
          thinkingBudget: config.thinking_config.thinking_level === 'high' ? 2048 : 1024
        };
      }
    }

    const res = await fetch(url, { method: 'POST', headers, body: JSON.stringify(payload) });
    if (!res.ok) {
      const errText = await res.text();
      throw new Error(`Google API returned status ${res.status}: ${errText}`);
    }
    const data = await res.json();
    if (data.candidates && data.candidates[0] && data.candidates[0].content && data.candidates[0].content.parts[0]) {
      return data.candidates[0].content.parts[0].text || '';
    }
    throw new Error(`Unexpected API response structure: ${JSON.stringify(data)}`);
  }
}

/**
 * Quality Gate evaluation using high-reasoning model.
 */
async function runQualityGate(draftContent, token, isVertex) {
  const qualityPrompt = `
You are an expert editor and quality gate. Your job is to review the draft content below, 
verify logical consistency, correct any style and formatting issues, and output 
the polished, final version of the text. Do not include explanations, just the final content.

DRAFT CONTENT:
${draftContent}
  `;

  try {
    const response = await callGenerateContent("gemini-3.1-pro-preview", [{ role: 'user', parts: [{ text: qualityPrompt }] }], { thinking_config: { thinking_level: 'high' } }, token, isVertex);
    return response || draftContent;
  } catch (err) {
    console.warn("Quality gate run failed. Returning original draft:", err);
    return draftContent;
  }
}

/**
 * Main generateContent function called by agentEngine & subagentEngine.
 */
async function generateContent(message, model = null, thinkingLevel = null, isSubagent = false) {
  let token = null;
  let isVertex = false;

  try {
    token = await getAccessToken();
    isVertex = true;
  } catch (err) {
    console.warn("Failed to get Google Auth token for Vertex AI. Falling back to API Key:", err.message);
    isVertex = false;
  }

  let modelToUse = model || (isSubagent ? "gemini-3.6-flash" : "gemini-3.6-flash");
  let thinkingToUse = thinkingLevel || (isSubagent ? "low" : "high");

  // Pre-flight Token Count & Dynamic Routing
  try {
    const totalTokens = await countTokens(modelToUse, message, token, isVertex);
    console.log(`Pre-flight token count: model=${modelToUse}, total_tokens=${totalTokens}`);

    if (modelToUse === "gemini-3.6-flash" && totalTokens > 60000) {
      console.log(`Tokens ${totalTokens} exceed gemini-3.6-flash sweet spot. Upgrading to gemini-3.6-flash.`);
      modelToUse = "gemini-3.6-flash";
    }

    if (modelToUse === "gemini-3.6-flash" && totalTokens > 100000) {
      console.log(`Tokens ${totalTokens} exceed gemini-3.6-flash sweet spot. Upgrading to gemini-3.1-pro-preview.`);
      modelToUse = "gemini-3.1-pro-preview";
    }
  } catch (err) {
    console.error("Error in token counting or dynamic routing:", err);
  }

  // Setup prompt contents
  const contents = [
    { role: 'user', parts: [{ text: message }] }
  ];

  // Setup config
  let config = {};
  if (thinkingToUse && thinkingToUse.toLowerCase() !== 'none') {
    config.thinking_config = { thinking_level: thinkingToUse.toLowerCase() };
  }

  // Call generation with EU-first -> Global fallback
  let outputText = await callGenerateContent(modelToUse, contents, config, token, isVertex);

  // Quality gate check for default subagents
  if (isSubagent && !model) {
    outputText = await runQualityGate(outputText, token, isVertex);
  }

  return outputText;
}

module.exports = {
  generateContent
};
