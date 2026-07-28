const fs = require('fs');
const path = require('path');
const mongoose = require('mongoose');
const { Chapter, Character, Note } = require('./mongoDB');

async function main() {
  console.log('Exporting project data to seed JSON files in backend/public/...');

  const chapters = await Chapter.find({}).lean();
  const characters = await Character.find({}).lean();
  const notes = await Note.find({}).lean();

  const publicDir = path.join(__dirname, 'public');

  fs.writeFileSync(path.join(publicDir, 'chapters.json'), JSON.stringify(chapters, null, 2));
  console.log(`✓ Saved ${chapters.length} chapters to chapters.json`);

  fs.writeFileSync(path.join(publicDir, 'characters.json'), JSON.stringify(characters, null, 2));
  console.log(`✓ Saved ${characters.length} characters to characters.json`);

  fs.writeFileSync(path.join(publicDir, 'notes.json'), JSON.stringify(notes, null, 2));
  console.log(`✓ Saved ${notes.length} notes to notes.json`);

  process.exit(0);
}

main().catch(err => {
  console.error("Failed to export seed files:", err);
  process.exit(1);
});
