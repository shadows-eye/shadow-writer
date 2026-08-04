const mongoose = require('mongoose');

async function test() {
  await mongoose.connect('mongodb://localhost:27017/shadow_writer_dev');
  
  const TestSchema = new mongoose.Schema({
    attributes: { type: Map, of: mongoose.Schema.Types.Mixed }
  });
  const TestModel = mongoose.model('TestMapDelete', TestSchema);
  
  let doc = new TestModel({ attributes: { a: 1, b: 2 } });
  await doc.save();
  
  console.log('Original:', doc.attributes);
  
  doc = await TestModel.findById(doc._id);
  if (doc.attributes && typeof doc.attributes.delete === 'function') {
      doc.attributes.delete('a');
  } else {
      doc.set('attributes.a', undefined);
  }
  doc.markModified('attributes');
  await doc.save();
  
  doc = await TestModel.findById(doc._id);
  console.log('After delete/unset:', doc.attributes);
  
  doc = await TestModel.findById(doc._id);
  doc.set('attributes.b', undefined);
  await doc.save();
  
  doc = await TestModel.findById(doc._id);
  console.log('After set undefined:', doc.attributes);
  
  process.exit(0);
}
test();
