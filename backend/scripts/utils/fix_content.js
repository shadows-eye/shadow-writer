const mongoose = require('mongoose');
mongoose.connect(process.env.MONGODB_URI || 'mongodb://localhost:27017/shadow_writer').then(async () => {
    const Character = mongoose.connection.collection('characters');
    const chars = await Character.find({}).toArray();
    let updated = 0;
    for (let char of chars) {
        if (char.content) {
            let orig = char.content;
            let newContent = char.content.replace(/^- \*\*(Species|Race|Age|Rank\/Clearance|Rank|Clearance|Traits)\*\*: .*\n?/gm, '');
            newContent = newContent.replace(/^## (Physical Description|Background & Role|Conflict|Key Relationships|Species|Race|Age|Rank|Clearance|Traits)\n.*(\n|$)/gm, '');
            newContent = newContent.trim();
            if (newContent !== orig) {
                await Character.updateOne({_id: char._id}, {$set: {content: newContent}});
                updated++;
            }
        }
    }
    console.log(`Updated content for ${updated} characters.`);
    process.exit(0);
});
