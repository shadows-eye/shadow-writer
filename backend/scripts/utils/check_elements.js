const mongoose = require('mongoose');
async function check() {
  await mongoose.connect('mongodb://localhost:27017/shadow_writer');
  const db = mongoose.connection.db;
  const elements = await db.collection('characterelements').find({ id: 'description' }).toArray();
  console.log(elements);
  process.exit(0);
}
check();
