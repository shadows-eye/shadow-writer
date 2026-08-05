const mongoose = require('mongoose');
const { generateContent } = require('../../geminiClient');

const mongoUri = process.env.MONGODB_URI || 'mongodb://localhost:27017/shadow_writer';

mongoose.connect(mongoUri)
  .then(async () => {
    console.log('Connected to MongoDB for Gemini-powered Structural Migration (1.7.0)');
    
    // We use strict: false to access legacy top-level fields that are no longer in the schema
    const GenericSchema = new mongoose.Schema({}, { strict: false });

    const models = [
        { name: 'Character', collectionName: 'characters' },
        { name: 'Note', collectionName: 'notes' },
        { name: 'Artifact', collectionName: 'artifacts' },
        { name: 'Chapter', collectionName: 'chapters' }
    ];

    const coreFields = ['_id', '__v', 'projectId', 'id', 'name', 'content', 'lastEdited', 'attributes', 'orderIndex'];
    let totalMigrated = 0;

    for (const modelInfo of models) {
        const Model = mongoose.model(modelInfo.name, GenericSchema, modelInfo.collectionName);
        const docs = await Model.find({});
        console.log(`\nFound ${docs.length} documents in ${modelInfo.collectionName} collection.`);

        let migratedInCollection = 0;

        for (let doc of docs) {
            try {
                const rawObj = doc.toObject();
                
                // Extract legacy fields that need mapping
                const legacyFields = {};
                for (const key of Object.keys(rawObj)) {
                    if (!coreFields.includes(key)) {
                        legacyFields[key] = rawObj[key];
                    }
                }
                
                // If there are no legacy fields, skip
                if (Object.keys(legacyFields).length === 0) continue;

                const docType = rawObj.type || modelInfo.name.toLowerCase();
                const systemPrompt = "SYSTEM DIRECTIVE: You are an automatic data structurer. The user has provided an unstructured block of text for this document. Analyze the text and map it directly into a structured JSON schema appropriate for a " + docType + ". Output only valid JSON with the mapped attributes. Do not include markdown formatting or conversational text.";
                
                const fullPrompt = `${systemPrompt}\n\nUnstructured Text:\n${JSON.stringify(legacyFields, null, 2)}`;

                console.log(`Sending doc ${rawObj.id || rawObj._id} to Gemini for auto-structuring...`);
                
                let geminiResponse = await generateContent({ message: fullPrompt, model: 'gemini-3.5-flash' });
                
                // Clean markdown code blocks
                geminiResponse = geminiResponse.replace(/^```json\n/i, '').replace(/\n```$/, '').trim();
                geminiResponse = geminiResponse.replace(/^```\n/i, '').replace(/\n```$/, '').trim();
                
                const structuredData = JSON.parse(geminiResponse);
                
                // Ensure attributes map exists
                if (!doc.attributes || typeof doc.attributes !== 'object' || typeof doc.attributes.keys === 'function') {
                    doc.attributes = doc.attributes ? Object.fromEntries(doc.attributes) : {};
                }
                
                // Clear old legacy fields from document root
                for (const key of Object.keys(legacyFields)) {
                    doc.set(key, undefined);
                }
                
                // Merge Gemini's structured mapping into attributes
                for (const key of Object.keys(structuredData)) {
                    // special old-system normalizations
                    const finalKey = key === 'species' ? 'race' : key;
                    
                    if (finalKey === 'rank' && typeof structuredData[key] === 'string' && structuredData[key].includes('/')) {
                        const parts = structuredData[key].split('/');
                        doc.attributes['rank'] = parts[0].trim();
                        doc.attributes['clearance'] = parts[1].trim();
                    } else {
                        doc.attributes[finalKey] = structuredData[key];
                    }
                }
                
                doc.markModified('attributes');
                await doc.save();
                migratedInCollection++;
                totalMigrated++;
                console.log(`Successfully auto-structured ${rawObj.id || rawObj._id}`);
                
                // Brief pause to avoid rate limits
                await new Promise(res => setTimeout(res, 500));
            } catch (err) {
                console.error(`Failed to auto-structure document ${doc.id}:`, err.message);
            }
        }
        
        console.log(`Structurally migrated ${migratedInCollection} documents in ${modelInfo.collectionName}.`);
    }
    
    console.log(`\nMigration complete. Total documents Gemini structurally normalized: ${totalMigrated}`);
    mongoose.disconnect();
  })
  .catch(err => console.error('Error:', err));
