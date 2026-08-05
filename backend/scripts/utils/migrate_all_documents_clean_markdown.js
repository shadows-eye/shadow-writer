const mongoose = require('mongoose');

const mongoUri = process.env.MONGODB_URI || 'mongodb://localhost:27017/shadow_writer';

function cleanMarkdown(val) {
    if (!val || typeof val !== 'string') return val;
    let s = val.replace(/\\([*#_\-\[\]\(\)])/g, '$1').trim();
    // Strip bullet-point bold headers (e.g. "- **Age**: ")
    s = s.replace(/^[\-\*]\s*\*\*[^*]+\*\*\:\s*/gm, '');
    // Strip generic dividers
    s = s.replace(/\s*---\s*/g, '');
    // Strip markdown headings (#, ##, ###, etc.)
    s = s.replace(/^#{1,6}\s+/gm, '');
    // Strip bold markers
    s = s.replace(/(\*\*|__)(.*?)\1/g, '$2');
    // Strip italic markers
    s = s.replace(/(\*|_)(.*?)\1/g, '$2');
    return s.trim();
}

mongoose.connect(mongoUri)
  .then(async () => {
    console.log('Connected to MongoDB for markdown migration (1.7.0 format)');
    
    const GenericSchema = new mongoose.Schema({
        projectId: { type: String, required: true },
        id: { type: String, required: true },
        attributes: { type: Map, of: mongoose.Schema.Types.Mixed },
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

            // 1. Clean attributes
            if (doc.attributes) {
                for (const [key, value] of doc.attributes.entries()) {
                    if (typeof value === 'string') {
                        const cleaned = cleanMarkdown(value);
                        if (cleaned !== value) {
                            doc.attributes.set(key, cleaned);
                            changed = true;
                        }
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
