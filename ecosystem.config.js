// PM2 配置文件：宝塔「PM2管理器」添加项目时选择本文件即可
module.exports = {
  apps: [
    {
      name: 'h5-kefu',
      script: 'server.js',
      cwd: __dirname,
      instances: 1,          // 必须单实例：数据为单进程内存+落盘模式
      exec_mode: 'fork',
      autorestart: true,
      max_memory_restart: '400M',
      env: {
        PORT: parseInt(process.env.PORT || '3000', 10)
      },
      error_file: './data/logs/pm2-error.log',
      out_file: './data/logs/pm2-out.log',
      merge_logs: true,
      time: true
    }
  ]
};
