const fs = require('node:fs');
fs.copyFileSync('src/schema.sql', 'dist/schema.sql');
fs.cpSync('src/migrations', 'dist/migrations', { recursive: true });
