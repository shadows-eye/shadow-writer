const mongoose = require('mongoose');

async function seedMangledDoc() {
  const mongoUri = process.env.MONGODB_URI || 'mongodb://localhost:27017/shadow_writer';
  await mongoose.connect(mongoUri);
  console.log('Connected to MongoDB:', mongoUri);

  const { Note } = require('../backend/mongoDB');

  const mangledContent = `\`\`\`markdown
# mangled_test_dossier.md

---

\`\`\`json
{
  "genre": "Cyberpunk",
  "status": "mangled_test",
  "priority": "high"
}
\`\`\`

# Mangled Cyberpunk Dossier Test

## Overview
This document was intentionally seeded into MongoDB with outer markdown code fences (\`\`\`markdown), leading filename headers (# mangled_test_dossier.md), top horizontal separators (---), and unparsed JSON metadata.

## World Details
In Neo-Veridia, the neon lights refract through toxic smog while megacorps control cybernetic implants...
\`\`\``;

  // Insert into default active project "the-beginning-of-the-end"
  await Note.deleteOne({ projectId: 'the-beginning-of-the-end', id: 'mangled_test_dossier' });
  await Note.create({
    projectId: 'the-beginning-of-the-end',
    id: 'mangled_test_dossier',
    name: 'mangled_test_dossier.md',
    type: 'note',
    content: mangledContent,
    attributes: {}
  });

  console.log('✅ Successfully seeded mangled document "mangled_test_dossier" into project "the-beginning-of-the-end".');
  await mongoose.disconnect();
}

seedMangledDoc().catch(err => {
  console.error('Error seeding mangled doc:', err);
  process.exit(1);
});
