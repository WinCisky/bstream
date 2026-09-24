module.exports = {
  apps: [{
    name: "bstream",
    cwd: "/home/ubuntu/bstream",
    script: "/home/ubuntu/.deno/bin/deno",
    args: "task start",
    interpreter: "none",
    autorestart: true,
    max_restarts: 10,
    env: { PORT: "8128" },
  }],
};
