import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

const functionsDir = join(process.cwd(), "supabase", "functions");
const names = readdirSync(functionsDir).filter((name) => {
  if (name.startsWith("_")) return false;
  return statSync(join(functionsDir, name)).isDirectory();
});

for (const name of names) {
  const result = spawnSync("supabase", ["functions", "deploy", name], {
    stdio: "inherit",
    shell: process.platform === "win32"
  });
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}
