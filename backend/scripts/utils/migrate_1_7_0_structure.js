const mongoose = require('mongoose');
const fs = require('fs');
const path = require('path');
const { generateContent } = require('../../geminiClient');

const mongoUri = process.env.MONGODB_URI || 'mongodb://localhost:27017/shadow_writer';

mongoose.connect(mongoUri)
  .then(async () => {
    console.log('Connected to MongoDB for Gemini-powered Structural Migration (1.7.0)');
    
    const elementsPath = path.join(__dirname, '../../public/characterElements.json');
    const elementsData = JSON.parse(fs.readFileSync(elementsPath, 'utf8'));
    
    const schemas = {};
    elementsData.forEach(element => {
        if (!schemas[element.entityType]) schemas[element.entityType] = [];
        schemas[element.entityType].push(element.id);
    });
    
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
        
        const docType = modelInfo.collectionName;
        const validKeys = [
            ...(schemas[docType] || []),
            ...(schemas['all'] || [])
        ];
        
        const docsToMigrate = docs.filter(doc => {
            const rawObj = doc.toObject();
            const legacyFields = Object.keys(rawObj).filter(k => !coreFields.includes(k));
            const hasLegacyFields = legacyFields.length > 0;
            
            let hasPopulatedAttributes = false;
            if (rawObj.attributes) {
                hasPopulatedAttributes = Object.values(rawObj.attributes).some(val => val && val !== '');
            }
            
            const hasUnmigratedContent = (rawObj.content && rawObj.content.trim().length > 0 && !hasPopulatedAttributes);
            
            let hasHallucinatedKeys = false;
            if (rawObj.attributes) {
                const existingKeys = Object.keys(rawObj.attributes);
                hasHallucinatedKeys = existingKeys.some(k => !validKeys.includes(k) && k !== 'type' && k !== 'subtypeTag' && k !== 'category');
            }
            
            return hasLegacyFields || hasUnmigratedContent || hasHallucinatedKeys;
        });

        console.log(`\n--- [${modelInfo.collectionName.toUpperCase()}] ---`);
        console.log(`Found ${docs.length} total documents.`);
        
        if (docsToMigrate.length === 0) {
            console.log(`✓ All documents are already perfectly structured. Skipping.`);
            continue;
        }

        console.log(`⚠️  Identified ${docsToMigrate.length} documents requiring Gemini structural mapping.`);

        let migratedInCollection = 0;

        for (let i = 0; i < docsToMigrate.length; i++) {
            const doc = docsToMigrate[i];
            try {
                const rawObj = doc.toObject();
                
                const legacyFields = {};
                for (const key of Object.keys(rawObj)) {
                    if (!coreFields.includes(key)) {
                        legacyFields[key] = rawObj[key];
                    }
                }
                
                const systemPrompt = `SYSTEM DIRECTIVE: You are an automatic data structurer. The user has provided an unstructured block of text. 
Analyze the text and map it directly into a structured JSON schema. 
CRITICAL RULE: You MUST output ONLY valid JSON containing EXACTLY these keys: [${validKeys.join(', ')}].
Do not invent new keys. If a key is not mentioned in the text, leave its value as an empty string "".
Do not include markdown formatting or conversational text.`;

                let textToProcess = rawObj.content || '';
                // Since we're re-migrating, we need to collect all previously extracted content to feed back into Gemini
                if (rawObj.attributes) {
                    const extractedContent = Object.values(rawObj.attributes)
                        .filter(val => typeof val === 'string' && val.length > 20)
                        .join('\n');
                    if (extractedContent) textToProcess += '\n' + extractedContent;
                }

                const fullPrompt = `${systemPrompt}\n\nUnstructured Data (Legacy Database Fields):\n${JSON.stringify(legacyFields, null, 2)}\n\nPlain Text Content (Analyze this for attributes):\n${textToProcess || 'No content provided.'}`;

                console.log(`[${i + 1}/${docsToMigrate.length}] Sending doc "${rawObj.id || rawObj._id}" to Gemini for auto-structuring...`);
                
                let geminiResponse = await generateContent(fullPrompt, 'gemini-3.5-flash');
                
                geminiResponse = geminiResponse.replace(/^```json\n/i, '').replace(/\n```$/, '').trim();
                geminiResponse = geminiResponse.replace(/^```\n/i, '').replace(/\n```$/, '').trim();
                
                const structuredData = JSON.parse(geminiResponse);
                
                // Build a completely fresh attributes object
                const newAttributes = {};
                
                // Apply strict keys
                for (const key of validKeys) {
                    if (key === 'race' && legacyFields['race']) newAttributes.race = legacyFields['race'];
                    else if (key === 'rank' && legacyFields['rank']) newAttributes.rank = legacyFields['rank'];
                    else newAttributes[key] = structuredData[key] || '';
                }
                
                // Keep structural markers
                newAttributes.type = docType;
                if (docType === 'characters') newAttributes.subtypeTag = 'characters';
                if (rawObj.attributes && rawObj.attributes.category) newAttributes.category = rawObj.attributes.category;
                
                // Completely overwrite the attributes field
                doc.set('attributes', newAttributes);
                
                for (const key of Object.keys(legacyFields)) {
                    doc.set(key, undefined);
                }
                
                doc.set('content', '');
                
                doc.markModified('attributes');
                await doc.save();
                migratedInCollection++;
                totalMigrated++;
                console.log(`   ✓ Successfully structured "${rawObj.id || rawObj._id}"`);
                
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
