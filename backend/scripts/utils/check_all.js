const mongoose = require('mongoose');
async function check() {
  await mongoose.connect('mongodb://localhost:27017/shadow_writer');
  const db = mongoose.connection.db;
  const chars = await db.collection('characters').find({ id: 'admiral-serdal' }).toArray();
  for (let i = 0; i < chars.length; i++) {
    console.log(`\n--- Char ${i} [Project: ${chars[i].projectId}] ---`);
    console.log(`Content length:`, chars[i].content ? chars[i].content.length : 0);
    console.log(`Content preview:`, chars[i].content ? chars[i].content.substring(0, 100) : '""');
    console.log(`Attributes:`, Object.keys(chars[i].attributes || {}));
    if (chars[i].attributes && chars[i].attributes.description) {
        console.log(`Description length:`, chars[i].attributes.description.length);
        console.log(`Description preview:`, chars[i].attributes.description.substring(0, 100));
    } else {
        console.log(`Description: NONE`);
    }
  }
  process.exit(0);
}
check();
