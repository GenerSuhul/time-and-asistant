module.exports = {
  apps: [
    {
      name: "hikvision-device-gateway",
      cwd: __dirname,
      script: "dist/index.js",
      instances: 1,
      exec_mode: "fork",
      autorestart: true,
      max_restarts: 10,
      restart_delay: 5000,
      max_memory_restart: "512M",
      out_file: "/var/log/hikvision-gateway/out.log",
      error_file: "/var/log/hikvision-gateway/error.log",
      merge_logs: true,
      env: {
        NODE_ENV: "production",
        APP_ENV: "production",
        HOST: "127.0.0.1"
      }
    }
  ]
};
