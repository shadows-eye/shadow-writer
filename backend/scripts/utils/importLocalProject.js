const fs = require('fs');
const path = require('path');
const mongoose = require('mongoose');
const { Project, Chapter, Character, Note, Artifact } = require('./mongoDB');

async function main() {
  const projectDir = '/home/shadow/Documents/AllianceRPG/The Begining of the End';
  if (!fs.existsSync(projectDir)) {
    console.error(`Project directory not found: ${projectDir}`);
    process.exit(1);
  }

  const projectId = 'the-beginning-of-the-end';
  const projectName = 'The Beginning of the End';

  console.log(`Starting migration for project "${projectName}" (${projectId})...`);

  // 1. Create/Update Project Entry
  await Project.findOneAndUpdate(
    { id: projectId },
    {
      $set: {
        name: projectName,
        genre: 'Science Fiction',
        templates: [
          "genre_trope_identifier",
          "pitch_brainstormer",
          "pitch_evaluator",
          "pitch_formatter",
          "dossier_outline_builder",
          "dossier_emotional_critiquer",
          "dossier_logic_critiquer",
          "character_names_reviewer",
          "dossier_compiler",
          "outline_act_expander",
          "outline_placements_planner",
          "outline_compiler",
          "chapter_plot_extractor",
          "chapter_beats_builder",
          "chapter_character_briefer",
          "chapter_setting_briefer",
          "chapter_chronology_checker_1",
          "chapter_plot_reviser",
          "chapter_prose_drafter",
          "chapter_chronology_checker_2",
          "chapter_style_guide_auditor",
          "chapter_prose_reviser",
          "chapter_final_polisher",
          "dossier",
          "outline",
          "chapter_generator"
        ]
      }
    },
    { upsert: true, new: true }
  );
  console.log(`✓ Updated Project metadata in MongoDB.`);

  // Helper to read file cleanly
  const read = (filepath) => fs.readFileSync(filepath, 'utf8');

  // 2. Import Chapters
  const chapterFiles = fs.readdirSync(projectDir)
    .filter(f => f.toLowerCase().startsWith('chapter') && f.endsWith('.md'));

  for (const file of chapterFiles) {
    const fullPath = path.join(projectDir, file);
    const content = read(fullPath);
    const match = file.match(/chapter\s*(\d+)/i);
    const orderIndex = match ? parseInt(match[1]) : 999;
    const chapterId = `chapter-${orderIndex}`;

    await Chapter.findOneAndUpdate(
      { projectId, id: chapterId },
      {
        $set: {
          content,
          orderIndex,
          attributes: { name: `Chapter ${orderIndex}` },
          lastEdited: new Date()
        }
      },
      { upsert: true, new: true }
    );
    console.log(`✓ Imported Chapter ${orderIndex} (${chapterId})`);
  }

  // 3. Import Characters
  const charDir = path.join(projectDir, 'characters');
  if (fs.existsSync(charDir)) {
    const charFiles = fs.readdirSync(charDir).filter(f => f.endsWith('.md'));
    for (const file of charFiles) {
      const name = file.replace('.md', '').trim();
      const charId = name.toLowerCase().replace(/[^a-z0-9]+/g, '-');
      const content = read(path.join(charDir, file));

      await Character.findOneAndUpdate(
        { projectId, id: charId },
        {
          $set: {
            name,
            content,
            attributes: { name },
            lastEdited: new Date()
          }
        },
        { upsert: true, new: true }
      );
      console.log(`✓ Imported Character "${name}" (${charId})`);
    }
  }

  // 4. Import Key Notes & Documents (Dossier, Outline, Timeline, etc.)
  const mainNotes = [
    { filename: 'Dossier.md', id: 'dossier', name: 'Dossier', type: 'dossier' },
    { filename: 'Outline.md', id: 'outline', name: 'Outline', type: 'outline' },
    { filename: 'Timeline.md', id: 'timeline', name: 'Timeline', type: 'note' },
    { filename: 'AGENTS.note.md', id: 'agents-note', name: 'Agents Guidelines', type: 'note' },
    { filename: 'story_structure.note.md', id: 'story-structure', name: 'Story Structure', type: 'note' }
  ];

  for (const n of mainNotes) {
    const fullPath = path.join(projectDir, n.filename);
    if (fs.existsSync(fullPath)) {
      const content = read(fullPath);
      await Note.findOneAndUpdate(
        { projectId, id: n.id },
        {
          $set: {
            name: n.name,
            type: n.type,
            content,
            attributes: { name: n.name, type: n.type },
            lastEdited: new Date()
          }
        },
        { upsert: true, new: true }
      );
      console.log(`✓ Imported Note "${n.name}" (${n.id})`);
    }
  }

  // 5. Import Subfolder Notes (races, systems)
  const importFolderAsNotes = async (subfolder, prefix) => {
    const dir = path.join(projectDir, subfolder);
    if (fs.existsSync(dir)) {
      const files = fs.readdirSync(dir).filter(f => f.endsWith('.md'));
      for (const file of files) {
        const title = file.replace('.md', '').trim();
        const noteName = `${prefix}: ${title}`;
        const noteId = `${subfolder}-${title.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`;
        const content = read(path.join(dir, file));

        await Note.findOneAndUpdate(
          { projectId, id: noteId },
          {
            $set: {
              name: noteName,
              type: 'note',
              content,
              attributes: { name: noteName, category: subfolder },
              lastEdited: new Date()
            }
          },
          { upsert: true, new: true }
        );
        console.log(`✓ Imported ${subfolder} Note "${noteName}" (${noteId})`);
      }
    }
  };

  await importFolderAsNotes('races', 'Race');
  await importFolderAsNotes('systems', 'System');

  console.log('\nMigration Complete! All chapters, characters, dossier, outline, and world notes have been imported into MongoDB.');
  process.exit(0);
}

main().catch(err => {
  console.error("Migration failed:", err);
  process.exit(1);
});
