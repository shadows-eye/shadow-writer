/**
 * scripts/restructure_all_documents.js
 * Production CLI Migration Script
 * Connects to MongoDB, iterates through all characters, notes, chapters, and artifacts,
 * converts raw string content into structured key-value attributes, and persists updates.
 */

const mongoose = require('mongoose');
const path = require('path');

// Connect to MongoDB
const mongoUri = process.env.MONGODB_URI || 'mongodb://localhost:27017/shadow_writer';

const {
  Character,
  Note,
  Chapter,
  Artifact,
  parseContentToAttributes,
  constructMarkdownFromAttributes
} = require('../mongoDB');

async function migrateAllDocuments() {
  console.log('====================================================');
  console.log('🚀 Starting Universal MongoDB Attribute Restructure...');
  console.log('====================================================');

  try {
    await mongoose.connect(mongoUri);
    console.log('✅ Connected to MongoDB:', mongoUri);

    // 1. Restructure Notes
    const notes = await Note.find({});
    console.log(`\n📝 Processing ${notes.length} Note documents...`);
    let noteCount = 0;
    for (const doc of notes) {
      let attrs = doc.attributes instanceof Map ? Object.fromEntries(doc.attributes) : (doc.attributes || {});
      const parsedAttrs = parseContentToAttributes(doc.content, doc.type || 'notes');
      
      const mergedAttrs = { ...parsedAttrs, ...attrs };
      doc.attributes = mergedAttrs;
      doc.markModified('attributes');
      
      const reconstructedContent = constructMarkdownFromAttributes(doc.name || doc.id, doc.type || 'notes', mergedAttrs);
      if (reconstructedContent) doc.content = reconstructedContent;
      
      await doc.save();
      noteCount++;
    }
    console.log(`✅ Restructured ${noteCount} Note documents.`);

    // 2. Restructure Characters
    const characters = await Character.find({});
    console.log(`\n👤 Processing ${characters.length} Character documents...`);
    let charCount = 0;
    for (const doc of characters) {
      let attrs = doc.attributes instanceof Map ? Object.fromEntries(doc.attributes) : (doc.attributes || {});
      const parsedAttrs = parseContentToAttributes(doc.content, 'characters');
      
      const mergedAttrs = { ...parsedAttrs, ...attrs };
      doc.attributes = mergedAttrs;
      doc.markModified('attributes');
      
      const reconstructedContent = constructMarkdownFromAttributes(doc.name || doc.id, 'characters', mergedAttrs);
      if (reconstructedContent) doc.content = reconstructedContent;
      
      await doc.save();
      charCount++;
    }
    console.log(`✅ Restructured ${charCount} Character documents.`);

    // 3. Restructure Chapters
    const chapters = await Chapter.find({});
    console.log(`\n📖 Processing ${chapters.length} Chapter documents...`);
    let chapCount = 0;
    for (const doc of chapters) {
      let attrs = doc.attributes instanceof Map ? Object.fromEntries(doc.attributes) : (doc.attributes || {});
      const parsedAttrs = parseContentToAttributes(doc.content, 'chapters');
      
      const mergedAttrs = { ...parsedAttrs, ...attrs };
      doc.attributes = mergedAttrs;
      doc.markModified('attributes');
      
      const reconstructedContent = constructMarkdownFromAttributes(doc.id, 'chapters', mergedAttrs);
      if (reconstructedContent) doc.content = reconstructedContent;
      
      await doc.save();
      chapCount++;
    }
    console.log(`✅ Restructured ${chapCount} Chapter documents.`);

    // 4. Restructure Artifacts
    const artifacts = await Artifact.find({});
    console.log(`\n⚙️ Processing ${artifacts.length} Artifact documents...`);
    let artCount = 0;
    for (const doc of artifacts) {
      let attrs = doc.attributes instanceof Map ? Object.fromEntries(doc.attributes) : (doc.attributes || {});
      const parsedAttrs = parseContentToAttributes(doc.content, doc.type || 'artifact');
      
      const mergedAttrs = { ...parsedAttrs, ...attrs };
      doc.attributes = mergedAttrs;
      doc.markModified('attributes');
      
      const reconstructedContent = constructMarkdownFromAttributes(doc.name || doc.id, doc.type || 'artifact', mergedAttrs);
      if (reconstructedContent) doc.content = reconstructedContent;
      
      await doc.save();
      artCount++;
    }
    console.log(`✅ Restructured ${artCount} Artifact documents.`);

    console.log('\n🎉 All MongoDB documents successfully restructured into Key-Value Attributes!');
    process.exit(0);
  } catch (err) {
    console.error('❌ Migration failed:', err);
    process.exit(1);
  }
}

migrateAllDocuments();
