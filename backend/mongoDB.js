const mongoose = require('mongoose');
const fs = require('fs');
const path = require('path');
const fsPromises = require('fs/promises');

const mongoUri = process.env.MONGODB_URI || 'mongodb://localhost:27017/shadow_writer';

mongoose.connect(mongoUri)
  .then(() => {
    console.log('Connected to MongoDB');
    seedDatabaseIfEmpty()
      .then(() => migrateExistingCharacters().catch(err => console.error('Migration error:', err)))
      .catch(err => console.error('Error seeding database:', err));
  })
  .catch(err => console.error('MongoDB connection error:', err));

// --- Schemas & Models ---
const ProjectSchema = new mongoose.Schema({
  id: { type: String, unique: true, required: true },
  name: String,
  userId: String,
  userEmail: String,
  folderPath: String,
  templates: [String],
  writingPOV: String,
  writingTense: String,
  genre: String
});
const Project = mongoose.model('Project', ProjectSchema);

const TemplateSchema = new mongoose.Schema({
  id: { type: String, unique: true, required: true },
  name: String,
  genre: String,
  templateType: String,
  content: String,
  templateBehavior: String,
  nextTemplateId: String,
  model: { type: String, default: 'gemini-3.5-flash' },
  thinkingLevel: { type: String, default: 'high' },
  contextTypes: [{ type: String }], // e.g. ['project', 'chapters', 'notes', 'templates']
  subagents: [{
    step: Number,
    subagentTemplateId: String, // References a Template ID of type 'Subagent'
    contextInputs: [{ type: String }],
    outputType: { type: String, default: 'note', enum: ['note', 'chapter', 'character', 'artifact'] },
    outputId: String
  }],
  overrides: { type: Map, of: String },
  chatHistory: [{
    role: String,
    content: String,
    timestamp: { type: Date, default: Date.now }
  }]
});
const Template = mongoose.model('Template', TemplateSchema);

const CharacterElementSchema = new mongoose.Schema({
  id: { type: String, unique: true, required: true },
  name: String,
  type: String,
  prefix: String,
  suffix: String,
  details: String,
  description: String,
  characteristics: String,
  customAttributes: { type: Map, of: String }
});
const CharacterElement = mongoose.model('CharacterElement', CharacterElementSchema);

const HistorySchema = new mongoose.Schema({
  jobId: { type: String, unique: true, required: true },
  userId: String,
  projectId: String,
  type: String,
  status: String,
  progress: Number,
  totalSteps: Number,
  currentStep: Number,
  logs: [String],
  chatHistory: [{
    role: String,
    content: String,
    timestamp: { type: Date, default: Date.now }
  }],
  payload: mongoose.Schema.Types.Mixed,
  timestamp: { type: Date, default: Date.now }
});
const History = mongoose.model('History', HistorySchema);

const ChapterSchema = new mongoose.Schema({
  projectId: { type: String, required: true },
  id: { type: String, required: true }, // e.g. "chapter-1"
  content: String,
  attributes: { type: Map, of: mongoose.Schema.Types.Mixed }, // dynamic stats/sliders
  orderIndex: Number,
  lastEdited: { type: Date, default: Date.now }
});
ChapterSchema.index({ projectId: 1, id: 1 }, { unique: true });
const Chapter = mongoose.model('Chapter', ChapterSchema);

const CharacterSchema = new mongoose.Schema({
  projectId: { type: String, required: true },
  id: { type: String, required: true },
  name: String,
  species: String,
  age: String,
  attributes: { type: Map, of: mongoose.Schema.Types.Mixed }, // dynamic attributes
  content: String,
  lastEdited: { type: Date, default: Date.now }
});
CharacterSchema.index({ projectId: 1, id: 1 }, { unique: true });
const Character = mongoose.model('Character', CharacterSchema);

const NoteSchema = new mongoose.Schema({
  projectId: { type: String, required: true },
  id: { type: String, required: true },
  name: String,
  type: { type: String, default: 'note' },
  attributes: { type: Map, of: mongoose.Schema.Types.Mixed }, // dynamic attributes
  content: String,
  lastEdited: { type: Date, default: Date.now }
});
NoteSchema.index({ projectId: 1, id: 1 }, { unique: true });
const Note = mongoose.model('Note', NoteSchema);

const ArtifactSchema = new mongoose.Schema({
  projectId: { type: String, required: true },
  id: { type: String, required: true },
  name: String,
  type: { type: String, default: 'artifact' },
  attributes: { type: Map, of: mongoose.Schema.Types.Mixed },
  content: String,
  lastEdited: { type: Date, default: Date.now }
});
ArtifactSchema.index({ projectId: 1, id: 1 }, { unique: true });
const Artifact = mongoose.model('Artifact', ArtifactSchema);

const ContextFileSchema = new mongoose.Schema({
  projectId: { type: String, required: true },
  destination: { type: String, required: true },
  path: { type: String, required: true },
  content: String,
  lastEdited: { type: Date, default: Date.now }
});
ContextFileSchema.index({ projectId: 1, destination: 1, path: 1 }, { unique: true });
const ContextFile = mongoose.model('ContextFile', ContextFileSchema);

// --- Compatibility Helpers for readDB / writeDB ---
async function readDB(filename) {
  try {
    if (filename === 'projects.json') {
      return await Project.find({}).lean();
    }
    if (filename === 'templates.json') {
      return await Template.find({}).lean();
    }
    if (filename === 'characterElements.json') {
      return await CharacterElement.find({}).lean();
    }
    if (filename === 'history.json') {
      return await History.find({}).lean();
    }
  } catch (e) {
    console.error(`Error in readDB for ${filename}:`, e);
  }
  return [];
}

async function writeDB(filename, data) {
  try {
    if (filename === 'projects.json') {
      await Project.deleteMany({});
      if (data && data.length > 0) await Project.insertMany(data);
    }
    else if (filename === 'templates.json') {
      await Template.deleteMany({});
      if (data && data.length > 0) await Template.insertMany(data);
    }
    else if (filename === 'characterElements.json') {
      await CharacterElement.deleteMany({});
      if (data && data.length > 0) await CharacterElement.insertMany(data);
    }
    else if (filename === 'history.json') {
      await History.deleteMany({});
      if (data && data.length > 0) await History.insertMany(data);
    }
  } catch (e) {
    console.error(`Error in writeDB for ${filename}:`, e);
  }
}

function findProject(projects, projectId) {
  if (!projects || projects.length === 0) return null;
  let p = projects.find(proj => proj.id === projectId);
  if (!p && projects.length === 1) {
    p = projects[0];
  }
  return p;
}

function sanitizeAndStructureContent(rawContent, type = 'note', id = '') {
  let content = rawContent || '';
  const attributes = {};

  if (typeof content !== 'string') {
    if (typeof content === 'object') {
      try {
        content = JSON.stringify(content, null, 2);
      } catch (e) {
        content = String(content || '');
      }
    } else {
      content = String(content || '');
    }
  }

  // 1. Normalize line breaks (\r\n -> \n)
  content = content.replace(/\r\n/g, '\n').trim();

  // 2. Iteratively strip outer markdown code block fences (```markdown ... ``` or ```md ... ``` or ``` ... ```)
  const outerFenceRegex = /^\s*```(?:markdown|md|text|txt)?\s*\n([\s\S]*?)\n```\s*$/i;
  let hasOuterFence = true;
  let maxLoop = 5;
  while (hasOuterFence && maxLoop > 0) {
    maxLoop--;
    const match = content.match(outerFenceRegex);
    if (match && match[1]) {
      content = match[1].trim();
    } else {
      hasOuterFence = false;
    }
  }

  // 3. Extract embedded JSON metadata block (```json ... ```) if present
  const jsonRegex = /```json\s*\n([\s\S]*?)\n```/i;
  const jsonMatch = content.match(jsonRegex);
  if (jsonMatch) {
    try {
      const parsed = JSON.parse(jsonMatch[1]);
      if (typeof parsed === 'object' && parsed !== null) {
        Object.assign(attributes, parsed);
      }
      content = content.replace(jsonRegex, '').trim();
    } catch (e) {
      console.warn("Failed to parse embedded JSON block in content:", e);
    }
  }

  // 4. Extract YAML front-matter (--- ... ---) if present
  const fmRegex = /^---\s*\n([\s\S]*?)\n---\s*\n/i;
  const fmMatch = content.match(fmRegex);
  if (fmMatch) {
    const lines = fmMatch[1].split('\n');
    lines.forEach(line => {
      const colonIdx = line.indexOf(':');
      if (colonIdx > 0) {
        const key = line.substring(0, colonIdx).trim();
        let value = line.substring(colonIdx + 1).trim();

        if (value.startsWith('"') && value.endsWith('"')) value = value.slice(1, -1);
        else if (value.startsWith("'") && value.endsWith("'")) value = value.slice(1, -1);
        else if (value.toLowerCase() === 'true') value = true;
        else if (value.toLowerCase() === 'false') value = false;
        else if (!isNaN(value) && value !== '') value = Number(value);

        attributes[key] = value;
      }
    });
    content = content.replace(fmRegex, '').trim();
  }

  // 5. Strip redundant leading file headers / filenames (e.g. "# dossier.md", "File: notes/dossier.md", "### dossier.md")
  content = content.replace(/^\s*(?:#+\s*|File:\s*|Path:\s*|Output:\s*)?[a-zA-Z0-9_\-\/\.]+\.md\s*\n+/i, '').trim();

  // 6. Again check if outer fence remains after file header removal
  if (outerFenceRegex.test(content)) {
    const match = content.match(outerFenceRegex);
    if (match && match[1]) content = match[1].trim();
  }

  // 7. Fix escaped backslashes in JS expressions or formatting if present
  content = content.replace(/\\(\$\{)/g, '$1');

  // 8. Determine clean name and title
  let name = attributes.name || '';
  if (!name) {
    const h1Match = content.match(/^\s*#\s+(.+)$/m);
    if (h1Match) {
      name = h1Match[1].trim();
    } else {
      name = id || 'Untitled Note';
    }
  }

  // 9. Standardize output type & ID mapping
  let normalizedId = id;
  let normalizedType = type;

  if (type === 'note' || !type) {
    if (id === 'story_dossier' || id === 'final_dossier' || id === 'dossier') {
      normalizedId = 'dossier';
      normalizedType = 'dossier';
    } else if (id === 'story_outline' || id === 'final_outline' || id === 'outline') {
      normalizedId = 'outline';
      normalizedType = 'outline';
    }
  }

  return {
    id: normalizedId,
    type: normalizedType,
    name,
    attributes,
    cleanContent: content
  };
}

function extractAttributesAndContent(content) {
  const res = sanitizeAndStructureContent(content);
  return { attributes: res.attributes, cleanContent: res.cleanContent };
}

async function seedDatabaseIfEmpty() {
  // 1. Seed Templates if empty
  const countTemplates = await Template.countDocuments();
  if (countTemplates === 0) {
    const templatesPath = path.join(__dirname, 'public', 'templates.json');
    if (fs.existsSync(templatesPath)) {
      try {
        const data = JSON.parse(fs.readFileSync(templatesPath, 'utf8'));
        if (data && data.length > 0) {
          await Template.insertMany(data);
          console.log(`✓ Initialized ${data.length} templates from templates.json into MongoDB.`);
        }
      } catch (err) {
        console.error('Failed to seed templates:', err);
      }
    }
  }

  // 2. Seed Projects if empty
  const countProjects = await Project.countDocuments();
  if (countProjects === 0) {
    const projectsPath = path.join(__dirname, 'public', 'projects.json');
    if (fs.existsSync(projectsPath)) {
      try {
        const data = JSON.parse(fs.readFileSync(projectsPath, 'utf8'));
        if (data && data.length > 0) {
          await Project.insertMany(data);
          console.log(`✓ Initialized ${data.length} projects from projects.json into MongoDB.`);
        }
      } catch (err) {
        console.error('Failed to seed projects:', err);
      }
    }
  }

  // 3. Seed Chapters if empty
  const countChapters = await Chapter.countDocuments();
  if (countChapters === 0) {
    const chaptersPath = path.join(__dirname, 'public', 'chapters.json');
    if (fs.existsSync(chaptersPath)) {
      try {
        const data = JSON.parse(fs.readFileSync(chaptersPath, 'utf8'));
        if (data && data.length > 0) {
          await Chapter.insertMany(data);
          console.log(`✓ Initialized ${data.length} chapters from chapters.json into MongoDB.`);
        }
      } catch (err) {
        console.error('Failed to seed chapters:', err);
      }
    }
  }

  // 4. Seed Characters if empty
  const countCharacters = await Character.countDocuments();
  if (countCharacters === 0) {
    const charactersPath = path.join(__dirname, 'public', 'characters.json');
    if (fs.existsSync(charactersPath)) {
      try {
        const data = JSON.parse(fs.readFileSync(charactersPath, 'utf8'));
        if (data && data.length > 0) {
          await Character.insertMany(data);
          console.log(`✓ Initialized ${data.length} characters from characters.json into MongoDB.`);
        }
      } catch (err) {
        console.error('Failed to seed characters:', err);
      }
    }
  }

  // 5. Seed Notes if empty
  const countNotes = await Note.countDocuments();
  if (countNotes === 0) {
    const notesPath = path.join(__dirname, 'public', 'notes.json');
    if (fs.existsSync(notesPath)) {
      try {
        const data = JSON.parse(fs.readFileSync(notesPath, 'utf8'));
        if (data && data.length > 0) {
          await Note.insertMany(data);
          console.log(`✓ Initialized ${data.length} notes from notes.json into MongoDB.`);
        }
      } catch (err) {
        console.error('Failed to seed notes:', err);
      }
    }
  }

  // 6. Seed Character Elements
  const charCount = await CharacterElement.countDocuments();
  if (charCount === 0) {
    const charPath = path.join(__dirname, 'public', 'characterElements.json');
    if (fs.existsSync(charPath)) {
      try {
        const data = JSON.parse(fs.readFileSync(charPath, 'utf8'));
        if (data && data.length > 0) {
          await CharacterElement.insertMany(data);
          console.log(`✓ Auto-seeded ${data.length} character elements into MongoDB.`);
        }
      } catch (err) {
        console.error('Failed to auto-seed character elements:', err);
      }
    }
  }

  // 4. Seed History
  const historyCount = await History.countDocuments();
  if (historyCount === 0) {
    const historyPath = path.join(__dirname, 'public', 'history.json');
    if (fs.existsSync(historyPath)) {
      try {
        const data = JSON.parse(fs.readFileSync(historyPath, 'utf8'));
        if (data && data.length > 0) {
          await History.insertMany(data);
          console.log(`✓ Auto-seeded ${data.length} history records into MongoDB.`);
        }
      } catch (err) {
        console.error('Failed to auto-seed history records:', err);
      }
    }
  }
}

async function parseCharacterAttributes(content) {
  const attributes = {};
  
  if (!content) return attributes;

  try {
    const elements = await CharacterElement.find({});
    // Normalize newlines
    const normalized = content.replace(/\r\n/g, '\n');

    for (const el of elements) {
      if (!el.prefix) continue;

      // Build regex to match prefix, value, and suffix/delimiter
      let prefixPattern = el.prefix
        .replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
        .replace(/\\n/g, '\\s*\\n\\s*')
        .replace(/ /g, '\\s+');

      if (prefixPattern.startsWith('\\-\\s+') || prefixPattern.startsWith('\\*\\s+')) {
        prefixPattern = '^[ \\t]*[\\-\\*]\\s+' + prefixPattern.substring(prefixPattern.indexOf('\\s+') + 3);
      }

      let regexStr = '';
      if (el.type === 'textarea') {
        regexStr = prefixPattern + '([\\s\\S]*?)(?=\\n[ \\t]*## |\\n[ \\t]*\\-\\-\\- |$(?![\\s\\S]))';
      } else {
        regexStr = prefixPattern + '(.*?)(?=\\n|$)';
      }

      const regex = new RegExp(regexStr, 'mi');
      const match = normalized.match(regex);
      if (match) {
        let val = match[1].trim();
        if (el.suffix) {
          const cleanSuffix = el.suffix.replace(/\\n/g, '').trim();
          if (cleanSuffix && val.endsWith(cleanSuffix)) {
            val = val.substring(0, val.length - cleanSuffix.length).trim();
          }
        }
        attributes[el.id] = val;
      } else {
        attributes[el.id] = '';
      }
    }
  } catch (err) {
    console.error('Error in parseCharacterAttributes:', err);
  }

  return attributes;
}

async function migrateExistingCharacters() {
  console.log('Running character database migration...');
  try {
    const characters = await Character.find({});
    let count = 0;
    for (const char of characters) {
      if (char.content) {
        // Find Name
        const nameMatch = char.content.match(/^\s*#\s+(.+)$/m);
        const name = nameMatch ? nameMatch[1].trim() : char.id;

        const attrs = await parseCharacterAttributes(char.content);
        const species = attrs['species'] || 'Unknown';
        const age = attrs['age'] || 'Unknown';

        char.name = name;
        char.species = species;
        char.age = age;
        char.attributes = attrs;
        
        await char.save();
        count++;
      }
    }
    console.log(`✓ Character migration complete. Processed ${count} characters.`);
  } catch (error) {
    console.error('Failed to migrate characters:', error);
  }
}

async function ensureCleanDocumentOnRead(doc, type = 'note') {
  if (!doc || !doc.content) return doc;

  const rawContent = typeof doc.content === 'string' ? doc.content : String(doc.content || '');
  
  const isOuterFenced = /^\s*```(?:markdown|md|text|txt)?\s*\n/i.test(rawContent);
  const hasFileHeader = /^\s*(?:#+\s*|File:\s*|Path:\s*|Output:\s*)?[a-zA-Z0-9_\-\/\.]+\.md\s*\n/i.test(rawContent);
  const isAliasId = (type === 'note' || type === 'dossier') && (doc.id === 'final_dossier' || doc.id === 'story_dossier' || doc.id === 'final_outline');
  const hasUnparsedJson = /```json\s*\n[\s\S]*?\n```/i.test(rawContent);

  // Self-heal if any malformed indicator is detected
  if (isOuterFenced || hasFileHeader || isAliasId || hasUnparsedJson) {
    console.log(`[Self-Healing] Cleaning malformed document on read: ID="${doc.id}" (type=${type})`);

    // 1. Fast deterministic pass
    const { id: normId, name: normName, attributes, cleanContent } = sanitizeAndStructureContent(rawContent, type, doc.id);

    let finalContent = cleanContent;
    let finalAttributes = { ...(doc.attributes || {}), ...attributes };
    let finalName = doc.name || normName;

    // 2. Gemini AI fallback check if content still starts with code blocks or is structurally damaged
    if (/^\s*```/i.test(finalContent)) {
      try {
        const { generateContent } = require('./geminiClient');
        const prompt = `You are a Document Restructuring Assistant. Clean and fix the following raw document content into pure, clean Markdown. 
Do NOT enclose the entire response in markdown code blocks (\`\`\`markdown ... \`\`\`).
Do NOT include file headers like "# dossier.md".
Return strictly the clean formatted Markdown body.

Raw Content:
${finalContent}`;

        const geminiCleaned = await generateContent({ message: prompt, isSubagent: false });
        if (geminiCleaned && geminiCleaned.trim().length > 0) {
          finalContent = geminiCleaned
            .replace(/^\s*```(?:markdown|md)?\s*\n/i, '')
            .replace(/\n```\s*$/i, '')
            .trim();
        }
      } catch (e) {
        console.warn(`[Self-Healing] Gemini AI cleanup fallback skipped for doc ${doc.id}:`, e.message);
      }
    }

    // 3. Update the document and persist back to MongoDB
    doc.content = finalContent;
    doc.attributes = finalAttributes;
    if (finalName) doc.name = finalName;
    if (normId && normId !== doc.id) doc.id = normId;

    if (doc.save && typeof doc.save === 'function') {
      await doc.save().catch(err => console.error(`[Self-Healing] Failed to persist cleaned doc ${doc.id}:`, err));
    }
  }

  return doc;
}

module.exports = {
  readDB,
  writeDB,
  parseCharacterAttributes,
  migrateExistingCharacters,
  extractAttributesAndContent,
  sanitizeAndStructureContent,
  ensureCleanDocumentOnRead,
  findProject,
  Project,
  Template,
  CharacterElement,
  History,
  Chapter,
  Character,
  Note,
  Artifact,
  ContextFile
};
