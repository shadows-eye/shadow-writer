const mongoose = require('mongoose');

async function runSanitizerTest() {
  console.log('🧪 Starting Dev MongoDB Sanitizer Test...');
  
  const mongoUri = process.env.MONGODB_URI || 'mongodb://localhost:27017/shadow_writer';
  await mongoose.connect(mongoUri);
  console.log('Connected to MongoDB');

  const { Note, cleanDatabaseOnStartup, sanitizeAndStructureContent } = require('../backend/mongoDB');

  const dirtyTestContent = `\`\`\`markdown
# dirty_test_note.md

---

\`\`\`json
{
  "genre": "Sci-Fi",
  "status": "draft",
  "rating": 5
}
\`\`\`

# Cosmology and the State of the Zark

## The Modern Crisis
In the current era, the long peace has been shattered by Genfras...
\`\`\``;

  // Insert dirty note into MongoDB bypassing sanitizer
  await Note.deleteOne({ projectId: 'test_project', id: 'dirty_test_note' });
  await Note.create({
    projectId: 'test_project',
    id: 'dirty_test_note',
    name: 'Dirty Test Note',
    type: 'note',
    content: dirtyTestContent,
    attributes: {}
  });

  console.log('Inserted dirty test note into MongoDB.');

  // Run startup database sanitizer
  await cleanDatabaseOnStartup();

  // Fetch cleaned note from MongoDB
  const cleanedNote = await Note.findOne({ projectId: 'test_project', id: 'dirty_test_note' }).lean();

  console.log('\n--- SANITIZATION TEST RESULT ---');
  console.log('Cleaned Title:', cleanedNote.name);
  console.log('Cleaned Content:\n', cleanedNote.content);
  console.log('Extracted Attributes:', cleanedNote.attributes);

  // Assertions
  const hasOuterFence = /^\s*```/i.test(cleanedNote.content);
  const hasHeaderArtifact = /# dirty_test_note\.md/i.test(cleanedNote.content);
  const hasLeadingSep = /^\s*---/i.test(cleanedNote.content);

  if (!hasOuterFence && !hasHeaderArtifact && !hasLeadingSep && cleanedNote.name === 'Cosmology and the State of the Zark') {
    console.log('\n✅ TEST PASSED: Database startup sanitizer successfully cleaned the document!');
  } else {
    console.error('\n❌ TEST FAILED: Document still contains malformed artifacts.');
    process.exitCode = 1;
  }

  // Cleanup test entry
  await Note.deleteOne({ projectId: 'test_project', id: 'dirty_test_note' });
  await mongoose.disconnect();
}

runSanitizerTest().catch(err => {
  console.error('Test execution error:', err);
  process.exit(1);
});
