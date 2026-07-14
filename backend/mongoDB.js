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
  writingTense: String
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
  jobId: String,
  userId: String,
  projectId: String,
  type: String,
  status: String,
  progress: Number,
  log: String,
  timestamp: { type: Date, default: Date.now }
});
const History = mongoose.model('History', HistorySchema);

const ChapterSchema = new mongoose.Schema({
  projectId: { type: String, required: true },
  id: { type: String, required: true }, // e.g. "chapter-1"
  content: String,
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
  attributes: { type: Map, of: String },
  content: String,
  lastEdited: { type: Date, default: Date.now }
});
CharacterSchema.index({ projectId: 1, id: 1 }, { unique: true });
const Character = mongoose.model('Character', CharacterSchema);

const NoteSchema = new mongoose.Schema({
  projectId: { type: String, required: true },
  id: { type: String, required: true },
  content: String,
  lastEdited: { type: Date, default: Date.now }
});
NoteSchema.index({ projectId: 1, id: 1 }, { unique: true });
const Note = mongoose.model('Note', NoteSchema);

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

async function seedDatabaseIfEmpty() {
  // 1. Seed Templates
  const templateCount = await Template.countDocuments();
  if (templateCount === 0) {
    const templatesPath = path.join(__dirname, 'db', 'templates.json');
    if (fs.existsSync(templatesPath)) {
      try {
        const data = JSON.parse(fs.readFileSync(templatesPath, 'utf8'));
        if (data && data.length > 0) {
          await Template.insertMany(data);
          console.log(`✓ Auto-seeded ${data.length} templates into MongoDB.`);
        }
      } catch (err) {
        console.error('Failed to auto-seed templates:', err);
      }
    }
  }

  // 2. Seed Projects
  const projectCount = await Project.countDocuments();
  if (projectCount === 0) {
    const projectsPath = path.join(__dirname, 'db', 'projects.json');
    if (fs.existsSync(projectsPath)) {
      try {
        const data = JSON.parse(fs.readFileSync(projectsPath, 'utf8'));
        if (data && data.length > 0) {
          await Project.insertMany(data);
          console.log(`✓ Auto-seeded ${data.length} projects into MongoDB.`);
        }
      } catch (err) {
        console.error('Failed to auto-seed projects:', err);
      }
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
  findProject,
  Project,
  Template,
  CharacterElement,
  History,
  Chapter,
  Character,
  Note,
  ContextFile
};
