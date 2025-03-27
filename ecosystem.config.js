// ecosystem.config.js
module.exports = {
  apps: [
    {
      name: "server-monitor",
      script: "index.ts",
      interpreter: process.env.BUN_PATH,
      watch: false,
      env: {
        NODE_ENV: "production",
      },
      env_file: ".env",
    },
  ],
};
