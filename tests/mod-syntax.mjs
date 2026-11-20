// Parses every mod script as an ES module. Node's plain `--check` can accept
// some invalid module syntax as CommonJS, so this runs the module parser.
//
//   node --experimental-vm-modules tests/mod-syntax.mjs
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { SourceTextModule } from "node:vm";

let failed = 0;
for (const name of readdirSync("mods")) {
  const dir = join("mods", name);
  let files = [];
  try {
    files = readdirSync(dir).filter((file) => file.endsWith(".js"));
  } catch {
    continue;
  }
  for (const file of files) {
    const path = join(dir, file);
    try {
      new SourceTextModule(readFileSync(path, "utf8"), { identifier: path });
    } catch (error) {
      failed += 1;
      console.error(`FAIL  ${path}: ${error.message}`);
    }
  }
}
if (failed) {
  console.error(`\n${failed} module(s) did not parse`);
  process.exit(1);
}
console.log("mod scripts parse");
