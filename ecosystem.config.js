// ecosystem.config.js
module.exports = {
  apps: [
    {
      name: "system-monitor",
      script: "index.ts",
      interpreter: "/home/ubuntu/.bun/bin/bun",
      watch: false,
      env: {
        NODE_ENV: "production",
      },
    },
  ],
};
