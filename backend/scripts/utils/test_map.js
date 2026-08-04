const mongoose = require('mongoose');
const { Character } = require('./models');

async function test() {
  await mongoose.connect('mongodb://localhost:27017/shadow_writer_dev');
  let char = await Character.findOne({ id: 'test_char_1' });
  if (!char) char = new Character({ projectId: 'global', id: 'test_char_1' });
  
  // Set initial map
  char.attributes = { a: 1, b: 2 };
  await char.save();
  
  console.log('After set 1:', (await Character.findOne({ id: 'test_char_1' })).attributes);
  
  char.attributes = { a: 1 };
  char.markModified('attributes');
  await char.save();
  
  console.log('After set 2:', (await Character.findOne({ id: 'test_char_1' })).attributes);
  
  process.exit(0);
}
test();
