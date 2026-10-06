/**
 * ecosystem.config.js
 *
 * PM2 process configuration for the Windows local agents.
 *
 * Processes:
 *   agent  — WebRTC input agent  (agent.js)  — handles mouse/keyboard control
 *   stream — WebRTC stream agent (stream-agent.js) — captures and streams the desktop
 *
 * Usage:
 *   pm2 start ecosystem.config.js   # start both processes
 *   pm2 save                         # persist process list across reboots
 */

module.exports = {
  apps: [
    {
      name: 'agent',
      script: 'agent.js',
      cwd: __dirname,
      restart_delay: 3000, // wait 3 s before restarting on crash
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
