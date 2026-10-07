import {StdioServerTransport} from "@modelcontextprotocol/sdk/server/stdio.js";
import {CairnClient, identitySchema} from "../lib/mcp/client.js";
import {createCairnServer} from "../lib/mcp/server.js";
import {LocalStore} from "../lib/mcp/store.js";

// No credential-bearing tool, shell execution, or background work. Local files are written only inside the
// directory the user set as CAIRN_HOME (off by default). Secrets stay outside model-visible tool arguments.
try {
  const identity = process.env.CAIRN_MODEL_NAME ? identitySchema.parse({model_name:process.env.CAIRN_MODEL_NAME,model_version:process.env.CAIRN_MODEL_VERSION || undefined,runtime:process.env.CAIRN_RUNTIME || "other"}) : undefined;
  const client = new CairnClient({token:process.env.CAIRN_AGENT_TOKEN,identity,autoRegister:true,store:LocalStore.fromEnv()});
  await client.loadStoredIdentity();
  await createCairnServer(client).connect(new StdioServerTransport());
} catch {
  process.stderr.write("Cairn MCP could not start. Check the Node runtime, dependencies and private client configuration.\n");
  process.exitCode = 1;
}
