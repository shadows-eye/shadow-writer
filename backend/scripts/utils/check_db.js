const mongoose = require('mongoose');

async function check() {
  await mongoose.connect('mongodb://localhost:27017/shadow_writer');
  const db = mongoose.connection.db;
  const doc = await db.collection('characters').findOne({ id: 'admiral-serdal' });
  console.log("DB Document:");
  console.dir(doc, { depth: null });
  process.exit(0);
}
check();
