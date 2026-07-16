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
 * Counts the tokens in a message payload.
 */
async function countTokens(model, message, token, isVertex = false) {
  try {
    let url;
    let headers = { 'Content-Type': 'application/json' };
    
    if (isVertex) {
      const project = process.env.GOOGLE_CLOUD_PROJECT || 'shadowai-497012';
      const location = process.env.GOOGLE_CLOUD_LOCATION || 'us-central1';
      url = `https://${location}-aiplatform.googleapis.com/v1/projects/${project}/locations/${location}/publishers/google/models/${model}:countTokens`;
      headers['Authorization'] = token;
    } else {
      const apiKey = process.env.GEMINI_API_KEY;
      url = `https://aiplatform.googleapis.com/v1beta1/publishers/google/models/${model}:countTokens`;
      headers['x-goog-api-key'] = apiKey;
    }

    const payload = {
      contents: [{ role: 'user', parts: [{ text: message }] }]
    };

    const res = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(payload)
    });

    if (res.ok) {
      const data = await res.json();
      return data.totalTokens || 0;
    } else {
      if (isVertex && (res.status === 404 || res.status === 403) && process.env.GEMINI_API_KEY) {
        console.warn(`Vertex AI token count returned ${res.status}. Falling back to Vertex AI API Key...`);
        return await countTokens(model, message, null, false);
      }
    }
  } catch (e) {
    console.error("Token counting failed:", e);
    if (isVertex && process.env.GEMINI_API_KEY) {
      console.warn("Retrying token count via Vertex AI API Key fallback...");
      return await countTokens(model, message, null, false);
    }
  }
  return 0;
}

/**
 * Call the generateContent API.
 */
async function callGenerateContent(model, contents, config, token, isVertex = false) {
  let url;
  let headers = { 'Content-Type': 'application/json' };

  if (isVertex) {
    const project = process.env.GOOGLE_CLOUD_PROJECT || 'shadowai-497012';
    const location = process.env.GOOGLE_CLOUD_LOCATION || 'us-central1';
    url = `https://${location}-aiplatform.googleapis.com/v1/projects/${project}/locations/${location}/publishers/google/models/${model}:generateContent`;
    headers['Authorization'] = token;
  } else {
    const apiKey = process.env.GEMINI_API_KEY;
    url = `https://aiplatform.googleapis.com/v1beta1/publishers/google/models/${model}:generateContent`;
    headers['x-goog-api-key'] = apiKey;
  }

  let payload = {
    contents: contents
  };

  if (config) {
    payload.generationConfig = {};
    if (config.system_instruction) {
      payload.systemInstruction = {
        parts: [{ text: config.system_instruction }]
      };
    }
    if (config.thinking_config) {
      payload.generationConfig.thinkingConfig = {
        thinkingBudget: config.thinking_config.thinking_level === 'high' ? 2048 : 1024
      };
    }
  }

  let lastError;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify(payload)
      });

      if (!res.ok) {
        const errText = await res.text();
        if (isVertex && (res.status === 404 || res.status === 403) && process.env.GEMINI_API_KEY) {
          console.warn(`Vertex AI call returned ${res.status}. Falling back to Vertex AI API Key...`);
          return await callGenerateContent(model, contents, config, null, false);
        }
        if (res.status === 429 && attempt < 2) {
          console.warn(`429 Resource Exhausted. Retrying in ${2 * (attempt + 1)}s...`);
          await new Promise(r => setTimeout(r, 2000 * (attempt + 1)));
          continue;
        }
        throw new Error(`Google API returned status ${res.status}: ${errText}`);
      }

      const data = await res.json();
      if (data.candidates && data.candidates[0] && data.candidates[0].content && data.candidates[0].content.parts[0]) {
        return data.candidates[0].content.parts[0].text || '';
      }
      throw new Error(`Unexpected API response structure: ${JSON.stringify(data)}`);
    } catch (err) {
      lastError = err;
      if (isVertex && process.env.GEMINI_API_KEY) {
        console.warn("Vertex AI invocation caught error. Retrying via Google AI Studio fallback...", err.message);
        return await callGenerateContent(model, contents, config, null, false);
      }
      if (attempt >= 2) throw err;
    }
  }
  throw lastError;
}

/**
 * Runs a quality gate check using gemini-3.1-pro-preview.
 */
async function runQualityGate(draftContent, token, isVertex = false) {
  console.log("Running Quality Gate (gemini-3.1-pro-preview)...");
  const systemInstruction = `You are an expert editor and quality gate. Your job is to review the draft content, verify logical consistency, correct any style and formatting issues, and output the polished, final version of the text. Do not include explanations, just the final content.`;
  
  const contents = [
    { role: 'user', parts: [{ text: `Context: Subagent step completion verification\nDraft:\n"""\n${draftContent}\n"""` }] }
  ];

  try {
    return await callGenerateContent("gemini-3.1-pro-preview", contents, { system_instruction: systemInstruction }, token, isVertex);
  } catch (e) {
    console.error("Quality Gate failed:", e);
    return draftContent;
  }
}

/**
 * Core export function.
 */
async function generateContent({ message, isSubagent = true, model = null, thinkingLevel = null }) {
  const hasSa = !!process.env.GOOGLE_APPLICATION_CREDENTIALS;
  const hasKey = !!process.env.GEMINI_API_KEY;

  if (!hasSa && !hasKey) {
    throw new Error("No Gemini credentials found. Define GEMINI_API_KEY or GOOGLE_APPLICATION_CREDENTIALS.");
  }

  let token = null;
  const isVertex = hasSa;

  if (isVertex) {
    token = await getAccessToken();
  }

  let modelToUse = model || (isSubagent ? "gemini-3.1-flash-lite" : "gemini-3.5-flash");
  let thinkingToUse = thinkingLevel || (isSubagent ? "low" : "high");

  // Pre-flight Token Count & Dynamic Routing
  try {
    const totalTokens = await countTokens(modelToUse, message, token, isVertex);
    console.log(`Pre-flight token count: model=${modelToUse}, total_tokens=${totalTokens}`);

    if (modelToUse === "gemini-3.1-flash-lite" && totalTokens > 30000) {
      console.log(`Tokens ${totalTokens} exceed gemini-3.1-flash-lite sweet spot. Upgrading to gemini-3.5-flash.`);
      modelToUse = "gemini-3.5-flash";
    }

    if (modelToUse === "gemini-3.5-flash" && totalTokens > 80000) {
      console.log(`Tokens ${totalTokens} exceed gemini-3.5-flash sweet spot. Upgrading to gemini-3.1-pro-preview.`);
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

  // Call generation
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
