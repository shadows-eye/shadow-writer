const mongoose = require('mongoose');
async function check() {
  await mongoose.connect('mongodb://localhost:27017/shadow_writer');
  const db = mongoose.connection.db;
  const docs = await db.collection('characters').find({ id: 'admiral-serdal', projectId: 'the-beginning-of-the-end' }).toArray();
  for (const doc of docs) {
    if (doc.content && doc.content.includes('Rank Fleet Admiral')) {
        console.log("Found in content:", doc.content.substring(0, 50));
    }
    for (const [k, v] of Object.entries(doc.attributes || {})) {
        if (typeof v === 'string' && v.includes('Rank Fleet Admiral')) {
            console.log(`Found in attribute [${k}]:`, v.substring(0, 50));
        }
    }
  }
  process.exit(0);
}
check();
