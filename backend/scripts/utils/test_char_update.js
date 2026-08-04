const http = require('http');

const payload = JSON.stringify({
  content: "",
  projectId: "global",
  attributes: { type: 'character', description: null }
});

const req = http.request({
  hostname: 'localhost',
  port: 4000,
  path: '/api/characters/test_char_1',
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(payload)
  }
}, (res) => {
  let data = '';
  res.on('data', chunk => data += chunk);
  res.on('end', () => {
    console.log('Update response:', data);
    
    // Now fetch to see if description is gone
    http.get('http://localhost:4000/api/characters/test_char_1', (res2) => {
      let data2 = '';
      res2.on('data', chunk => data2 += chunk);
      res2.on('end', () => {
         console.log('Fetch response:', data2);
      });
    });
  });
});

req.write(payload);
req.end();
