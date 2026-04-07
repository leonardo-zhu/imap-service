module.exports = {
  apps: [
    {
      name: 'imap-service',
      script: './dist/index.js',
      instances: 1,
      exec_mode: 'fork',
      autorestart: true,
      max_restarts: 10,
      restart_delay: 5000,
      watch: false,
      max_memory_restart: '256M',
    },
  ],
};
