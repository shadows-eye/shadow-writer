const mongoose = require('mongoose');
const fs = require('fs');
const { ObjectId } = require('mongodb');

const mongoUri = process.env.MONGODB_URI || 'mongodb://localhost:27017/shadow_writer';

mongoose.connect(mongoUri)
  .then(async () => {
    console.log('Connected to MongoDB. Starting Dev-to-Prod Sync...');
    
    const db = mongoose.connection.db;
    const dumpPath = process.argv[2] || '/tmp/dev_dump.json';
    
    if (!fs.existsSync(dumpPath)) {
        console.error(`Error: Dump file not found at ${dumpPath}`);
        process.exit(1);
    }
    
    const dump = JSON.parse(fs.readFileSync(dumpPath, 'utf8'));
    const collectionsToSync = ['characters', 'notes', 'chapters'];
    
    for (const collName of collectionsToSync) {
        const devDocs = dump[collName] || [];
        if (devDocs.length === 0) continue;
        
        console.log(`Syncing collection '${collName}' (${devDocs.length} documents)...`);
        const collection = db.collection(collName);
        
        // Wipe existing production collection
        await collection.deleteMany({});
        
        // Restore ObjectId
        for (let doc of devDocs) {
            if (doc._id && typeof doc._id === 'string' && doc._id.length === 24) {
                doc._id = new ObjectId(doc._id);
            }
        }
        
        await collection.insertMany(devDocs);
        console.log(`✅ Successfully replaced '${collName}' with Dev data.`);
    }
    
    console.log('\nSync Complete! Artifacts were NOT touched.');
    process.exit(0);
  })
  .catch(err => {
    console.error(err);
    process.exit(1);
  });
