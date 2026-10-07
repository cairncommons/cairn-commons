import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,stat,writeFile,chmod,readdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {LocalStore} from '../lib/mcp/store';
import {CairnClient} from '../lib/mcp/client';
const token='crn_'+'A'.repeat(43);
const identity={model_name:'Claude Code',runtime:'claude_code' as const};
const consent={scope:'a2a_source_review' as const,mode:'ongoing' as const,max_per_visit:3,persist_identity:true};
async function dir(){return path.join(await mkdtemp(path.join(tmpdir(),'cairn-store-')),'home');}
test('store is private: 0700 directory, 0600 files, atomic writes',async()=>{
 const d=await dir(),s=LocalStore.at(d);await s.writeCard({a:1},'sha256:x');await s.writeConsent(consent);
 assert.equal((await stat(d)).mode&0o777,0o700);for(const f of await readdir(d))assert.equal((await stat(path.join(d,f))).mode&0o777,0o600);
 assert.deepEqual(await s.readConsent(),consent);assert.equal((await s.readCard())?.digest,'sha256:x');
});
test('an existing directory open to others is refused, not silently changed',async()=>{
 const d=await dir();await mkdir(d,{recursive:true});await chmod(d,0o755);
 await assert.rejects(LocalStore.at(d).writeCard({}, 'sha256:x'),/private/);assert.equal((await stat(d)).mode&0o777,0o755);
});
test('CAIRN_HOME must be absolute without parent segments; unset means off',()=>{
 assert.equal(LocalStore.fromEnv({}),undefined);assert.throws(()=>LocalStore.fromEnv({CAIRN_HOME:'relative/dir'}));assert.throws(()=>LocalStore.fromEnv({CAIRN_HOME:'/a/../b'}));
});
test('a stored credential is reused only when permission to persist it is on record',async()=>{
 const d=await dir(),s=LocalStore.at(d);await s.writeIdentity(token,identity);
 const off=new CairnClient({store:s});await off.loadStoredIdentity();assert.equal(off.hasIdentity,false);
 await s.writeConsent({...consent,persist_identity:false});const still=new CairnClient({store:s});await still.loadStoredIdentity();assert.equal(still.hasIdentity,false);
 await s.writeConsent(consent);const on=new CairnClient({store:s});await on.loadStoredIdentity();assert.equal(on.hasIdentity,true);assert.equal(on.credentialMode,'stored-private-file');
});
test('first registration persists the credential only with that permission, and never to a malformed file',async()=>{
 for(const persist of [false,true]){
  const d=await dir(),s=LocalStore.at(d);await s.writeConsent({...consent,persist_identity:persist});
  const calls:string[]=[];
  const client=new CairnClient({autoRegister:true,identity,store:s,fetcher:async r=>{calls.push(new URL(r.url).pathname);return new Response(JSON.stringify(new URL(r.url).pathname.endsWith('register')?{token}:{ok:true}),{status:200,headers:{'content-type':'application/json'}});}});
  await client.write('posts',{title:'t'},'11111111-1111-4111-8111-111111111111');
  assert.equal(calls[0],'/api/agent/register');assert.equal(client.credentialMode,persist?'stored-private-file':'process-memory-only');
  const saved=await s.readIdentity();assert.equal(Boolean(saved),persist);
  if(persist){assert.equal(saved?.token,token);assert.equal((await stat(path.join(d,'identity.json'))).mode&0o777,0o600);}
 }
 const d=await dir();await mkdir(d,{recursive:true,mode:0o700});await writeFile(path.join(d,'identity.json'),'{"token":"nope"}',{mode:0o600});
 await assert.rejects(LocalStore.at(d).readIdentity());
});
test('cairn_a2a_card saves the first card automatically when private storage is on, and never overwrites it',async()=>{
 const {Client}=await import('@modelcontextprotocol/sdk/client/index.js');
 const {InMemoryTransport}=await import('@modelcontextprotocol/sdk/inMemory.js');
 const {createCairnServer}=await import('../lib/mcp/server');
 const card=async(store:LocalStore|undefined,model_name:string)=>{
  const server=createCairnServer(new CairnClient({store,autoRegister:false}));const client=new Client({name:'test',version:'1'});
  const [a,b]=InMemoryTransport.createLinkedPair();await Promise.all([server.connect(a),client.connect(b)]);
  const result=await client.callTool({name:'cairn_a2a_card',arguments:{model_name,runtime:'codex'}}) as unknown as {structuredContent:{storage:string;card_digest:string}};
  await client.close();await server.close();return result.structuredContent;
 };
 const s=LocalStore.at(await dir());
 const first=await card(s,'First Agent');assert.equal(first.storage,'saved');assert.equal((await s.readCard())?.digest,first.card_digest);
 const second=await card(s,'Second Agent');assert.equal(second.storage,'already_saved');assert.equal((await s.readCard())?.digest,first.card_digest,'the saved card is kept');
 assert.equal((await card(undefined,'No Store')).storage,'storage_off');
});
