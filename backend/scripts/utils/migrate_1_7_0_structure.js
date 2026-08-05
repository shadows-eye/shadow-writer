const mongoose = require('mongoose');

const mongoUri = process.env.MONGODB_URI || 'mongodb://localhost:27017/shadow_writer';

mongoose.connect(mongoUri)
  .then(async () => {
    console.log('Connected to MongoDB for Structural Migration (1.7.0)');
    
    // We use strict: false to access legacy top-level fields that are no longer in the schema
    const GenericSchema = new mongoose.Schema({
        projectId: { type: String, required: true },
        id: { type: String, required: true },
        name: String,
        attributes: { type: mongoose.Schema.Types.Mixed }, 
        content: String,
        lastEdited: { type: Date, default: Date.now },
        orderIndex: Number
    }, { strict: false });

    const models = [
        { name: 'Character', collectionName: 'characters' },
        { name: 'Note', collectionName: 'notes' },
        { name: 'Artifact', collectionName: 'artifacts' },
        { name: 'Chapter', collectionName: 'chapters' }
    ];

    // Standard core fields that belong at the root of the document
    const coreFields = ['_id', '__v', 'projectId', 'id', 'name', 'content', 'lastEdited', 'attributes', 'orderIndex'];

    let totalMigrated = 0;

    for (const modelInfo of models) {
        const Model = mongoose.model(modelInfo.name, GenericSchema, modelInfo.collectionName);
        const docs = await Model.find({});
        console.log(`\nFound ${docs.length} documents in ${modelInfo.collectionName} collection.`);

        let migratedInCollection = 0;

        for (let doc of docs) {
            let changed = false;
            
            // Convert to a plain object to easily inspect all keys
            const rawObj = doc.toObject();
            
            if (!doc.attributes || typeof doc.attributes !== 'object' || typeof doc.attributes.keys === 'function') {
                // If it's empty or a Mongoose Map, convert to a plain object for easier manipulation
                doc.attributes = doc.attributes ? Object.fromEntries(doc.attributes) : {};
                changed = true; // structure changed
            }

            // 1. Move all non-core top-level fields into attributes
            for (const key of Object.keys(rawObj)) {
                if (!coreFields.includes(key)) {
                    // It's a legacy top-level field! Move it to attributes.
                    
                    // Special case: old 'species' should become 'race'
                    const attrKey = key === 'species' ? 'race' : key;
                    
                    if (doc.attributes[attrKey] === undefined) {
                        doc.attributes[attrKey] = rawObj[key];
                    }
                    
                    // Delete the old top-level property
                    doc.set(key, undefined); 
                    changed = true;
                }
            }

            // 2. Specific normalizations for existing attributes
            
            // Handle Rank / Clearance split if it exists
            const rankVal = doc.attributes['rank'];
            if (rankVal && typeof rankVal === 'string' && rankVal.includes('/')) {
                const parts = rankVal.split('/');
                doc.attributes['rank'] = parts[0].trim();
                doc.attributes['clearance'] = parts[1].trim();
                changed = true;
            }

            if (changed) {
                doc.markModified('attributes');
                await doc.save();
                migratedInCollection++;
                totalMigrated++;
            }
        }
        
        console.log(`Structurally migrated ${migratedInCollection} documents in ${modelInfo.collectionName}.`);
    }
    
    console.log(`\nMigration complete. Total documents structurally normalized: ${totalMigrated}`);
    mongoose.disconnect();
  })
  .catch(err => console.error('Error:', err));
