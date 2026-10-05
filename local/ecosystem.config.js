module.exports = {
  apps: [
    {
      name: 'agent',
      script: 'agent.js',
      cwd: __dirname,
      restart_delay: 3000,
      max_restarts: 10,
    },
    {
      name: 'stream',
      script: 'stream-agent.js',
      cwd: __dirname,
      restart_delay: 3000,
      max_restarts: 10,
    },
  ],
};
