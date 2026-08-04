const mongoose = require('mongoose');
mongoose.connect(process.env.MONGODB_URI || 'mongodb://localhost:27017/shadow_writer').then(async () => {
    const Character = mongoose.connection.collection('characters');
    const chars = await Character.find({}).toArray();
    let hasRankClearance = 0;
    for (let char of chars) {
        if (char.attributes && char.attributes.rank_clearance) {
            hasRankClearance++;
            const parts = char.attributes.rank_clearance.split('/');
            char.attributes.rank = parts[0] ? parts[0].trim() : '';
            char.attributes.clearance = parts[1] ? parts[1].trim() : '';
            delete char.attributes.rank_clearance;
            await Character.updateOne({_id: char._id}, {$set: {attributes: char.attributes}});
        }
    }
    console.log(`Migrated rank_clearance for ${hasRankClearance} characters.`);
    process.exit(0);
});
