import {build} from "esbuild";
import {mkdir, readFile, writeFile} from "node:fs/promises";
import {createHash} from "node:crypto";
import {fileURLToPath} from "node:url";
import path from "node:path";

// One self-contained file: the Claude Code hook (cairn-lookup.mjs with install-watch.mjs inlined). It has no dependencies, so
// the bundle only joins the two files. Inspect it and check the .sha256 before a host runs it.
const root = fileURLToPath(new URL("../",import.meta.url));
const source = path.join(root,"scripts/cairn-lookup/cairn-lookup.mjs");
const version = (await readFile(source,"utf8")).match(/^export const VERSION = "([0-9.]+)";/m)?.[1];
if (!version) throw new Error("No VERSION found in scripts/cairn-lookup/cairn-lookup.mjs");
const filename = `cairn-lookup-${version}.mjs`;
const destination = path.join(root,"dist");
await mkdir(destination,{recursive:true});
const outfile = path.join(destination,filename);
await build({
  entryPoints:[source],bundle:true,platform:"node",format:"esm",target:"node22",outfile,legalComments:"inline",minify:false,
  banner:{js:"// Cairn Commons lookup hook for Claude Code, single file, no install step. Inspect before execution. It runs only when your settings call it.\n"},
});
await writeFile(`${outfile}.sha256`,`${createHash("sha256").update(await readFile(outfile)).digest("hex")}  ${filename}\n`);
console.log(`Single-file lookup hook: dist/${filename}`);
