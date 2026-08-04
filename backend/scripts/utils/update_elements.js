const mongoose = require('mongoose');
const fs = require('fs');

const mongoUri = process.env.MONGODB_URI || 'mongodb://localhost:27017/shadow_writer';

mongoose.connect(mongoUri)
  .then(async () => {
    console.log('Connected to MongoDB');
    const CharacterElement = mongoose.model('CharacterElement', new mongoose.Schema({
      id: { type: String, unique: true, required: true },
      name: String,
      type: String,
      entityType: { type: String, default: 'characters' },
      isDefault: { type: Boolean, default: false },
      prefix: String,
      suffix: String
    }, { strict: false }));

    const elementsData = JSON.parse(fs.readFileSync('/home/shadow/Documents/GitHub/shadow-writer/backend/public/characterElements.json', 'utf8'));

    await CharacterElement.deleteMany({});
    await CharacterElement.insertMany(elementsData);

    console.log('Updated CharacterElements in DB.');
    mongoose.disconnect();
  })
  .catch(err => console.error(err));
