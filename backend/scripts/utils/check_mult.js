const mongoose = require('mongoose');
async function check() {
  await mongoose.connect('mongodb://localhost:27017/shadow_writer');
  const db = mongoose.connection.db;
  const docs = await db.collection('characters').find({ id: 'admiral-serdal', projectId: 'the-beginning-of-the-end' }).toArray();
  console.log(`Found ${docs.length} documents for admiral-serdal in the-beginning-of-the-end`);
  for (const doc of docs) {
    console.log("Attributes:", Object.keys(doc.attributes || {}));
    if (doc.attributes && doc.attributes.description) {
      console.log("Desc:", doc.attributes.description);
    }
    console.log("Content length:", doc.content ? doc.content.length : 0);
  }
  process.exit(0);
}
check();
