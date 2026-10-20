// One-command local setup: env file, backing services, migrations, dev server.
import { spawnSync, spawn } from "node:child_process";
import { copyFileSync, existsSync } from "node:fs";

const run = (command, args) => {
  const result = spawnSync(command, args, { stdio: "inherit" });
  if (result.status !== 0) {
    console.error(`\nbootstrap: "${command} ${args.join(" ")}" failed.`);
    process.exit(result.status ?? 1);
  }
};

if (!existsSync(".env")) {
  copyFileSync(".env.example", ".env");
  console.log("bootstrap: created .env from .env.example");
}

run("docker", ["compose", "up", "-d", "--wait"]);
run("pnpm", ["db:migrate"]);

const dev = spawn("pnpm", ["exec", "next", "dev"], { stdio: "inherit" });
for (const signal of ["SIGINT", "SIGTERM"])
  process.on(signal, () => dev.kill(signal));
dev.on("exit", (code) => process.exit(code ?? 0));
