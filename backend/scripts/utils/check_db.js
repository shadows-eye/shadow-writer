const mongoose = require('mongoose');
mongoose.connect(process.env.MONGODB_URI || 'mongodb://localhost:27017/shadow_writer').then(async () => {
    const char = await mongoose.connection.collection('characters').findOne({id: 'admiral-serdal'});
    console.log("Admiral Serdal:", char);
    process.exit(0);
});
