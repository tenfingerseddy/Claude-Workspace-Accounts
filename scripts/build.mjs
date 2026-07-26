import { build, context } from "esbuild";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { buildWrapper } from "./build-wrapper.mjs";

const projectRoot = path.dirname(fileURLToPath(new URL("../package.json", import.meta.url)));

const options = {
  absWorkingDir: projectRoot,
  entryPoints: [path.join(projectRoot, "src", "extension.ts")],
  outfile: path.join(projectRoot, "dist", "extension.cjs"),
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node24",
  sourcemap: true,
  sourcesContent: false,
  external: ["vscode"],
  logLevel: "info"
};

await buildWrapper();

if (process.argv.includes("--watch")) {
  const buildContext = await context(options);
  await buildContext.watch();
  console.log("Watching Claude Workspace Accounts sources…");
} else {
  await build(options);
}
