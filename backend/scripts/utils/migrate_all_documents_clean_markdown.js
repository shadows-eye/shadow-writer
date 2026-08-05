const mongoose = require('mongoose');

const mongoUri = process.env.MONGODB_URI || 'mongodb://localhost:27017/shadow_writer';

function cleanMarkdown(val) {
    if (!val || typeof val !== 'string') return val;
    let s = val.replace(/\\([*#_\-\[\]\(\)])/g, '$1').trim();
    
    // Strip bullet points that are bold headers
    s = s.replace(/^[\-\*]\s*\*\*[^*]+\*\*\:\s*/gm, '');
    
    // Strip generic dividers
    s = s.replace(/\s*---\s*/g, '');
    
    // Strip all heading hashes that are followed by a space (e.g. "## ")
    s = s.replace(/#{1,6}\s+/g, '');
    
    // Strip hashes that are glued to words or punctuation (like "cells.##Role")
    s = s.replace(/#{1,6}/g, '');
    
    // Strip all bold markers indiscriminately
    s = s.replace(/\*\*/g, '');
    s = s.replace(/__/g, '');
    
    // Clean up multiple spaces that might have been left behind
    s = s.replace(/  +/g, ' ');
    
    return s.trim();
}

mongoose.connect(mongoUri)
  .then(async () => {
    console.log('Connected to MongoDB for AGGRESSIVE markdown migration');
    
    const GenericSchema = new mongoose.Schema({
        projectId: { type: String, required: true },
        id: { type: String, required: true },
        attributes: { type: mongoose.Schema.Types.Mixed }, // Use Mixed to handle both Maps and plain objects
        content: String,
        lastEdited: { type: Date, default: Date.now }
    }, { strict: false });

    const models = [
        { name: 'Character', collectionName: 'characters' },
        { name: 'Note', collectionName: 'notes' },
        { name: 'Artifact', collectionName: 'artifacts' },
        { name: 'Chapter', collectionName: 'chapters' }
    ];

    let totalCleaned = 0;

    for (const modelInfo of models) {
        const Model = mongoose.model(modelInfo.name, GenericSchema, modelInfo.collectionName);
        const docs = await Model.find({});
        console.log(`\nFound ${docs.length} documents in ${modelInfo.collectionName} collection.`);

        let cleanedInCollection = 0;

        for (let doc of docs) {
            let changed = false;

            // 1. Clean attributes (handling both Mongoose Maps and plain objects)
            if (doc.attributes) {
                if (typeof doc.attributes.keys === 'function') {
                    // It's a Mongoose Map
                    for (const key of Array.from(doc.attributes.keys())) {
                        const value = doc.attributes.get(key);
                        if (typeof value === 'string') {
                            const cleaned = cleanMarkdown(value);
                            if (cleaned !== value) {
                                doc.attributes.set(key, cleaned);
                                changed = true;
                            }
                        }
                    }
                } else if (typeof doc.attributes === 'object') {
                    // It's a plain JS object
                    for (const key of Object.keys(doc.attributes)) {
                        const value = doc.attributes[key];
                        if (typeof value === 'string') {
                            const cleaned = cleanMarkdown(value);
                            if (cleaned !== value) {
                                doc.attributes[key] = cleaned;
                                changed = true;
                            }
                        }
                    }
                    // Since it's a Mixed type, we need to tell Mongoose it changed
                    if (changed) {
                        doc.markModified('attributes');
                    }
                }
            }

            // 2. Clean content
            if (doc.content) {
                const cleaned = cleanMarkdown(doc.content);
                if (cleaned !== doc.content) {
                    doc.content = cleaned;
                    changed = true;
                }
            }

            if (changed) {
                await doc.save();
                cleanedInCollection++;
                totalCleaned++;
            }
        }
        
        console.log(`Cleaned ${cleanedInCollection} documents in ${modelInfo.collectionName}.`);
    }
    
    console.log(`\nMigration complete. Total documents cleaned: ${totalCleaned}`);
    mongoose.disconnect();
  })
  .catch(err => console.error('Error:', err));
