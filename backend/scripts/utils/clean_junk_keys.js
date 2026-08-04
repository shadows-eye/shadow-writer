const mongoose = require('mongoose');

async function clean() {
  await mongoose.connect('mongodb://localhost:27017/shadow_writer');
  
  const CharacterSchema = new mongoose.Schema({
    id: String,
    projectId: String,
    name: String,
    species: String,
    age: String,
    attributes: { type: Map, of: mongoose.Schema.Types.Mixed },
    content: String,
  }, { strict: false });
  const Character = mongoose.model('Character', CharacterSchema, 'characters');
  
  const chars = await Character.find({});
  let updated = 0;
  
  for (let doc of chars) {
    if (!doc.attributes) continue;
    let modified = false;
    
    const junkKeys = [
      'unstructured', 'chapter_content', 'background_role', 
      'description_notes', 'physical_description', 'rank_clearance',
      'physical_desc', doc.id, doc.id.replace(/-/g, '_')
    ];
    
    for (let key of junkKeys) {
      if (doc.attributes.has(key)) {
        doc.attributes.delete(key);
        modified = true;
      }
    }
    
    if (modified) {
      doc.markModified('attributes');
      await doc.save();
      updated++;
      console.log(`Cleaned junk keys for character ${doc.id}`);
    }
  }
  
  console.log(`Finished. Cleaned ${updated} characters.`);
  process.exit(0);
}
clean();
