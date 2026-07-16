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

function extractAttributesAndContent(content) {
  const attributes = {};
  let cleanContent = content || '';

  if (!content) return { attributes, cleanContent };

  // 1. Try parsing JSON code block: ```json ... ```
  const jsonRegex = /```json\s*\n([\s\S]*?)\n```/i;
  const jsonMatch = content.match(jsonRegex);
  if (jsonMatch) {
    try {
      const parsed = JSON.parse(jsonMatch[1]);
      Object.assign(attributes, parsed);
      // Clean JSON code block out of content
      cleanContent = cleanContent.replace(jsonRegex, '').trim();
    } catch (e) {
      console.warn("Failed to parse JSON code block in content:", e);
    }
  }

  // 2. Try parsing YAML front-matter: between --- and --- at the start
  const fmRegex = /^---\s*\n([\s\S]*?)\n---\s*\n/i;
  const fmMatch = content.match(fmRegex);
  if (fmMatch) {
    const lines = fmMatch[1].split('\n');
    lines.forEach(line => {
      const colonIdx = line.indexOf(':');
      if (colonIdx > 0) {
        const key = line.substring(0, colonIdx).trim();
        let value = line.substring(colonIdx + 1).trim();

        // Parse basic types: boolean, number, or strings
        if (value.startsWith('"') && value.endsWith('"')) {
          value = value.slice(1, -1);
        } else if (value.startsWith("'") && value.endsWith("'")) {
          value = value.slice(1, -1);
        } else if (value.toLowerCase() === 'true') {
          value = true;
        } else if (value.toLowerCase() === 'false') {
          value = false;
        } else if (!isNaN(value) && value !== '') {
          value = Number(value);
        }
        attributes[key] = value;
      }
    });
    cleanContent = cleanContent.replace(fmRegex, '').trim();
  }

  return { attributes, cleanContent };
}

async function seedDatabaseIfEmpty() {
  // 1. Sync Templates (using upsert by id so updates propagate)
  const templatesPath = path.join(__dirname, 'db', 'templates.json');
  if (fs.existsSync(templatesPath)) {
    try {
      const data = JSON.parse(fs.readFileSync(templatesPath, 'utf8'));
      if (data && data.length > 0) {
        for (const item of data) {
          // Sync except we preserve overrides if they exist
          await Template.findOneAndUpdate(
            { id: item.id },
            { 
              $set: {
                name: item.name,
                genre: item.genre,
                templateType: item.templateType,
                content: item.content,
                templateBehavior: item.templateBehavior,
                nextTemplateId: item.nextTemplateId || '',
                model: item.model || 'gemini-3.5-flash',
                thinkingLevel: item.thinkingLevel || 'high',
                contextTypes: item.contextTypes || [],
                subagents: item.subagents || []
              }
            },
            { upsert: true, new: true }
          );
        }
        console.log(`✓ Synchronized ${data.length} templates from templates.json into MongoDB.`);
      }
    } catch (err) {
      console.error('Failed to sync templates:', err);
    }
  }

  // 2. Sync Projects (using upsert by id so updates propagate)
  const projectsPath = path.join(__dirname, 'db', 'projects.json');
  if (fs.existsSync(projectsPath)) {
    try {
      const data = JSON.parse(fs.readFileSync(projectsPath, 'utf8'));
      if (data && data.length > 0) {
        for (const item of data) {
          await Project.findOneAndUpdate(
            { id: item.id },
            {
              $set: {
                name: item.name,
                folderPath: item.folderPath,
                templates: item.templates || [],
                writingPOV: item.writingPOV,
                writingTense: item.writingTense,
                genre: item.genre
              }
            },
            { upsert: true, new: true }
          );
        }
        console.log(`✓ Synchronized ${data.length} projects from projects.json into MongoDB.`);
      }
    } catch (err) {
      console.error('Failed to sync projects:', err);
    }
  }

  // 3. Seed Character Elements
  const charCount = await CharacterElement.countDocuments();
  if (charCount === 0) {
    const charPath = path.join(__dirname, 'db', 'characterElements.json');
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
    const historyPath = path.join(__dirname, 'db', 'history.json');
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

module.exports = {
  readDB,
  writeDB,
  parseCharacterAttributes,
  migrateExistingCharacters,
  extractAttributesAndContent,
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
