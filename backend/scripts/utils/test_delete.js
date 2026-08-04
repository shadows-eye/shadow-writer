const mongoose = require('mongoose');

const CharacterSchema = new mongoose.Schema({
  projectId: { type: String, required: true },
  id: { type: String, required: true },
  attributes: { type: Map, of: mongoose.Schema.Types.Mixed }
});
const Character = mongoose.model('TestCharacter', CharacterSchema);

async function test() {
  await mongoose.connect('mongodb://localhost:27017/shadow_writer_test');
  
  // 1. Create character
  const char = new Character({ projectId: 'test', id: 'test', attributes: { description: 'test desc' } });
  await char.save();
  
  // 2. Fetch and delete
  let doc = await Character.findOne({ id: 'test' });
  console.log("Before:", doc.attributes.get('description'));
  
  doc.attributes.delete('description');
  doc.markModified('attributes');
  await doc.save();
  
  // 3. Fetch again
  let doc2 = await Character.findOne({ id: 'test' });
  console.log("After:", doc2.attributes.get('description'));
  
  await mongoose.connection.close();
}
test();
