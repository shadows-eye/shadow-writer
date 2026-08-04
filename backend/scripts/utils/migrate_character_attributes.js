const mongoose = require('mongoose');

const mongoUri = process.env.MONGODB_URI || 'mongodb://localhost:27017/shadow_writer';

mongoose.connect(mongoUri)
  .then(async () => {
    console.log('Connected to MongoDB for migration');
    
    // We can define the schemas needed just for migration
    const CharacterSchema = new mongoose.Schema({
        projectId: { type: String, required: true },
        id: { type: String, required: true },
        name: String,
        species: String,
        race: String,
        age: String,
        attributes: { type: Map, of: mongoose.Schema.Types.Mixed },
        content: String,
        lastEdited: { type: Date, default: Date.now }
    }, { strict: false });
    const Character = mongoose.model('Character', CharacterSchema);

    const chars = await Character.find({});
    console.log(`Found ${chars.length} characters.`);

    for (let char of chars) {
        let changed = false;
        if (!char.attributes) char.attributes = new Map();

        // 1. Rename species to race
        let speciesVal = char.species || char.attributes.get('species');
        if (speciesVal) {
            char.attributes.set('race', speciesVal);
            char.race = speciesVal;
            
            char.attributes.delete('species');
            char.species = undefined;
            changed = true;
        }

        // 2. Split rank and clearance
        let rankVal = char.attributes.get('rank');
        if (rankVal && typeof rankVal === 'string' && rankVal.includes('/')) {
            const parts = rankVal.split('/');
            const newRank = parts[0].trim();
            const newClearance = parts[1].trim();
            
            char.attributes.set('rank', newRank);
            char.attributes.set('clearance', newClearance);
            changed = true;
        }

        // 3. Strip legacy markdown from content
        if (char.content) {
            const originalContent = char.content;
            
            // Regex to remove anything that looks like dynamically injected markdown from attributes
            // like ## Rank\nFleet Admiral...
            // specifically, the attributes injected by getChapterOrDocContent
            // But we can just use the sanitizeAndStructureContent logic, or a simple regex for sections we know were injected:
            let newContent = char.content.replace(/^## (Species|Race|Age|Rank|Clearance|Rank Clearance|Physical Description|Physical Desc)\n.*\n?/gm, '');
            newContent = newContent.replace(/^## (Background|Conflict|Key Relationships)\n.*\n?/gm, ''); 
            // Wait, Background, Conflict, Key Relationships might be actual notes the user wrote?
            // Actually, we shouldn't strip anything blindly unless we're sure it was injected.
            // Let's look at the generated extraText: `\n\n## ${formattedKey}\n${cleanVal}`.
            // If we just look for `## Species`, `## Age`, `## Rank`, `## Clearance`, `## Physical Desc` and remove them.
            
            // Wait, the injected text always comes at the end, and we know exactly what we want to remove.
            // Let's leave content alone if it's too complex, or just strip standard injected fields.
            const injectedKeys = ['Species', 'Race', 'Age', 'Rank', 'Clearance', 'Rank Clearance', 'Physical Description', 'Physical Desc'];
            for (const key of injectedKeys) {
                const regex = new RegExp(`^## ${key}\\n.*\\n?`, 'gmi');
                newContent = newContent.replace(regex, '');
            }
            newContent = newContent.trim();
            
            if (newContent !== originalContent) {
                char.content = newContent;
                changed = true;
            }
        }

        if (changed) {
            console.log(`Updating character: ${char.id}`);
            await char.save();
        }
    }
    
    console.log('Migration complete.');
    mongoose.disconnect();
  })
  .catch(err => console.error('Error:', err));
