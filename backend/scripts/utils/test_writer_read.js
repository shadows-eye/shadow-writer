const http = require('http');

async function getApi(path) {
    return new Promise((resolve, reject) => {
        const options = {
            hostname: 'localhost',
            port: 4000,
            path: path,
            method: 'GET',
            headers: {
                'x-api-key': 'dev-mcp-shared-key-for-local-testing-only'
            }
        };

        const req = http.request(options, (res) => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => resolve(JSON.parse(data)));
        });

        req.on('error', error => reject(error));
        req.end();
    });
}

async function runTests() {
    try {
        const pId = 'test_project_123';
        
        console.log("Fetching Note:");
        const noteRes = await getApi('/api/notes/test_note_1?projectId=' + pId);
        console.log(JSON.stringify(noteRes, null, 2));

        console.log("Fetching Character:");
        const charRes = await getApi('/api/characters/test_char_1?projectId=' + pId);
        console.log(JSON.stringify(charRes, null, 2));

        console.log("Fetching Chapter:");
        const chapRes = await getApi('/api/chapters/test_chap_1?projectId=' + pId);
        console.log(JSON.stringify(chapRes, null, 2));
        
    } catch (e) {
        console.error("Test failed:", e);
    }
}

runTests();
