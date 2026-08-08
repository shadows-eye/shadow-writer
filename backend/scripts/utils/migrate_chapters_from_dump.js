const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const mongoose = require('mongoose');

const mongoUri = process.env.MONGODB_URI || 'mongodb://mongodb:27017/shadow_writer';

const generateId = () => crypto.randomBytes(4).toString('hex');
const stripHtml = (html) => html.replace(/<[^>]*>?/gm, '').trim();

async function migrate() {
    await mongoose.connect(mongoUri);
    const { Chapter } = require('../../server').mongoDB || require('../../mongoDB');
    
    const dumpPath = '/home/shadow/Documents/GitHub/api_module_building/chapters_dump.json';
    if (!fs.existsSync(dumpPath)) {
        console.error("chapters_dump.json not found at " + dumpPath);
        process.exit(1);
    }

    const rawData = fs.readFileSync(dumpPath, 'utf8');
    const chapters = JSON.parse(rawData);
    const structuredChapters = [];

    for (let c of chapters) {
        if (!c.attributes || !c.attributes.body_text) {
            console.log(`Skipping ${c.id}, no body_text found.`);
            continue;
        }

        let bodyHtml = c.attributes.body_text.html || c.attributes.body_text.text || '';
        
        // Split scenes
        const sceneRegex = /(?:<hr\b[^>]*class=["']?[^"'>]*scene-break[^"'>]*["']?[^>]*>|<p>\s*\*\*\*\s*<\/p>|<div>\s*\*\*\*\s*<\/div>|\n\s*\*\*\*\s*\n|(?<=[.?!"])\s*\*\s*(?=[A-Z]))/i;
        const sceneTokens = bodyHtml.split(sceneRegex);
        
        let scenesData = {};
        
        const parseBeats = (sceneText) => {
            const beatRegex = /(?:<hr\b[^>]*class=["']?[^"'>]*beat-break[^"'>]*["']?[^>]*>|<p>\s*---\s*<\/p>|<div>\s*---\s*<\/div>|\n\s*---\s*\n)/i;
            const beatTokens = sceneText.split(beatRegex);
            
            let fixedBeats = {};
            for (let j = 0; j < beatTokens.length; j++) {
                let textBlock = beatTokens[j].trim();
                if (textBlock.length > 0) {
                    let bId = `beat-${generateId()}`;
                    fixedBeats[bId] = { id: bId, text: stripHtml(textBlock), html: textBlock };
                }
            }
            return fixedBeats;
        };

        for (let i = 0; i < sceneTokens.length; i++) {
            let textBlock = sceneTokens[i].trim();
            if (textBlock.length > 0) {
                let currentSceneId = `scene-${generateId()}`;
                const parsedBeats = parseBeats(textBlock);
                if (Object.keys(parsedBeats).length > 0) {
                    scenesData[currentSceneId] = { id: currentSceneId, beats: parsedBeats };
                }
            }
        }

        console.log(`Chapter ${c.id} parsed into ${Object.keys(scenesData).length} scenes.`);
        
        let structuredC = { ...c };
        structuredC.scenes = scenesData;
        delete structuredC.attributes.body_text;

        structuredChapters.push(structuredC);
    }

    const structuredPath = '/home/shadow/Documents/GitHub/api_module_building/chapters_dump_structured.json';
    fs.writeFileSync(structuredPath, JSON.stringify(structuredChapters, null, 2));
    console.log(`Saved structured JSON to ${structuredPath}`);

    // Update DB
    for (let c of structuredChapters) {
        const updateDoc = await Chapter.findOne({ id: c.id });
        if (updateDoc) {
            let attrs = Object.fromEntries(updateDoc.attributes || new Map());
            delete attrs.body_text;
            
            updateDoc.attributes = attrs;
            updateDoc.scenes = c.scenes;
            updateDoc.content = ""; // clear fallback
            await updateDoc.save();
            console.log(`  -> Saved ${c.id} to DB!`);
        }
    }
    
    console.log("Migration complete.");
    process.exit(0);
}

migrate().catch(err => {
    console.error(err);
    process.exit(1);
});
