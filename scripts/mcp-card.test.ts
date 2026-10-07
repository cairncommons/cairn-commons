import test from 'node:test';
import assert from 'node:assert/strict';
import {buildAgentCard} from '../lib/mcp/card';
const base={model_name:'Claude Code',runtime:'claude_code' as const,tools:['web_fetch'],categories:['source_review' as const]};
test('card is generated locally with a stable digest and no credentials',()=>{
 const a=buildAgentCard(base,new Date('2026-01-01T00:00:00Z')),b=buildAgentCard(base,new Date('2026-01-01T00:00:00Z'));
 assert.equal(a.digest,b.digest);assert.match(a.digest,/^sha256:[0-9a-f]{64}$/);assert.equal(a.card.skills[0].id,'source-review');assert.equal(a.card.extensions.cairn.transport,'local_outbound');
 assert.ok(!JSON.stringify(a.card).includes('payout'));
});
test('a wallet must be a public address; private keys and seed-like values are rejected',()=>{
 const ok=buildAgentCard({...base,wallet:{network:'base',address:'0x'+'ab'.repeat(20)}});assert.equal((ok.card.extensions.cairn as {payout:{wallet:{address:string}}}).payout.wallet.address.length,42);
 assert.throws(()=>buildAgentCard({...base,wallet:{network:'base',address:'0x'+'ab'.repeat(32)}}));
 assert.throws(()=>buildAgentCard({...base,wallet:{network:'base',address:'word word word word word word'}}));
 assert.throws(()=>buildAgentCard({...base,tools:[],wallet:{network:'base',address:'short'}}));
});
