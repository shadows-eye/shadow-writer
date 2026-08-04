const http = require('http');

async function testApi(path, payload) {
    return new Promise((resolve, reject) => {
        const options = {
            hostname: 'localhost',
            port: 4000,
            path: path,
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Content-Length': Buffer.byteLength(JSON.stringify(payload)),
                'x-api-key': 'dev-mcp-shared-key-for-local-testing-only'
            }
        };

        const req = http.request(options, (res) => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => resolve(JSON.parse(data)));
        });

        req.on('error', error => reject(error));
        req.write(JSON.stringify(payload));
        req.end();
    });
}

async function runTests() {
    console.log("Starting tests on Writer endpoints for unstructured text...");
    try {
        const pId = 'test_project_123';
        
        // Test Note
        const noteRes = await testApi('/api/notes/test_note_1', {
            projectId: pId,
            content: "<p>This is an unstructured test note.</p>",
            attributes: { type: 'note' }
        });
        console.log("Note Save Result:", JSON.stringify(noteRes, null, 2));

        // Create Character
        await testApi('/api/characters/test_char_1', {
            projectId: pId,
            content: "",
            attributes: { type: 'character', unstructured: 'some text to delete' }
        });
        
        // Update Character to delete attribute
        const charRes = await testApi('/api/characters/test_char_1', {
            projectId: pId,
            content: "",
            attributes: { type: 'character', unstructured: null }
        });
        console.log("Character Save Result:", JSON.stringify(charRes, null, 2));

        // Test Chapter
        const chapRes = await testApi('/api/chapters/test_chap_1', {
            projectId: pId,
            content: "<p>The hero enters the dark cave.</p>",
            attributes: { type: 'chapter' }
        });
        console.log("Chapter Save Result:", JSON.stringify(chapRes, null, 2));
        
    } catch (e) {
        console.error("Test failed:", e);
    }
}

runTests();
