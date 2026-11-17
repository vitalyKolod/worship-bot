module.exports = {
  apps: [
    { name: "worship-bot", script: "dist/index.js", cwd: __dirname, autorestart: true },
  ],
};
