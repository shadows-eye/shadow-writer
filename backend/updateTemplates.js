const fs = require('fs');
const path = require('path');
const mongoose = require('mongoose');
const { Template } = require('./mongoDB');

async function main() {
  const templatesPath = path.join(__dirname, 'db', 'templates.json');
  if (!fs.existsSync(templatesPath)) {
    console.error('templates.json not found');
    process.exit(1);
  }

  const data = JSON.parse(fs.readFileSync(templatesPath, 'utf8'));
  console.log(`Read ${data.length} templates from JSON.`);

  for (const t of data) {
    await Template.findOneAndUpdate(
      { id: t.id },
      { 
        name: t.name,
        genre: t.genre,
        templateType: t.templateType,
        templateBehavior: t.templateBehavior,
        nextTemplateId: t.nextTemplateId,
        content: t.content,
        overrides: t.overrides
      },
      { upsert: true, new: true }
    );
    console.log(`✓ Updated template ${t.id} in MongoDB.`);
  }

  console.log('Done!');
  process.exit(0);
}

main();
