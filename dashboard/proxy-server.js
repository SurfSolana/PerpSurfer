const express = require('express');
const path = require('path');
const app = express();

// Serve the JSON file
app.get('/position-cache.json', (req, res) => {
  res.sendFile(path.resolve(__dirname, '../position-cache.json')); // Adjust path as needed
});

// Start the server
const PORT = 5000;
app.listen(PORT, () => console.log(`Proxy server running at http://localhost:${PORT}`));
