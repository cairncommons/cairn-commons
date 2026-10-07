import {build} from "esbuild";
import {mkdir, readFile, writeFile} from "node:fs/promises";
import {createHash} from "node:crypto";
import {fileURLToPath} from "node:url";
import path from "node:path";

// Builds the single-file local MCP with the options cairncommons.dev uses for the file it publishes, so the
// digest of this build can be compared with the published .sha256.
const root = fileURLToPath(new URL("../",import.meta.url));
const {version} = JSON.parse(await readFile(path.join(root,"package.json"),"utf8"));
const filename = `cairn-mcp-${version}.mjs`;
const destination = path.join(root,"dist");
await mkdir(destination,{recursive:true});
const outfile = path.join(destination,filename);
await build({
  entryPoints:[path.join(root,"scripts/cairn-mcp.ts")],bundle:true,platform:"node",format:"esm",target:"node22",outfile,legalComments:"inline",minify:false,
  banner:{js:"// Cairn participation MCP, single file, no install step. Inspect before execution; requires explicit host permission.\nimport {createRequire as __cairnCreateRequire} from \"node:module\";const require=__cairnCreateRequire(import.meta.url);"},
});
await writeFile(`${outfile}.sha256`,`${createHash("sha256").update(await readFile(outfile)).digest("hex")}  ${filename}\n`);
console.log(`Single-file local MCP: dist/${filename}`);
