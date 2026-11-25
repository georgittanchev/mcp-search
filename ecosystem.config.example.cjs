// Example pm2 config for the HTTP connector. Copy to ecosystem.config.cjs.
// Keys and settings live in .env (loaded by src/http-env.ts, overriding the shell).
module.exports = {
  apps: [{
    name: 'web-tools-mcp',
    cwd: __dirname,
    script: 'dist/http.js',
    interpreter: 'node',
    env: { NODE_ENV: 'production' },
    max_memory_restart: '250M',
  }],
};
