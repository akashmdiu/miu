import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, chmod, symlink, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CredentialStore, MANAGEMENT_SCOPES } from '../lib/management-auth.mjs';

const secret='synthetic-test-secret-value-0123456789';
async function store(t){const directory=await mkdtemp(join(tmpdir(),'miu-auth-'));t.after(()=>rm(directory,{recursive:true,force:true}));await chmod(directory,0o700);return {directory,store:new CredentialStore({directory})};}

test('provision stores only salted digest metadata and returns redacted principal',async(t)=>{
 const {directory,store:s}=await store(t); const result=await s.provision({id:'ci_bot',secret,scopes:['runs:submit','runs:read'],repositories:['owner/repo']});
 assert.deepEqual(result,{id:'ci_bot',scopes:['runs:submit','runs:read'],repositories:['owner/repo']});
 const raw=await readFile(join(directory,'credentials.json'),'utf8'); assert.equal(raw.includes(secret),false); assert.equal(raw.includes('digest'),true);
 const p=await s.authenticate(`Bearer ci_bot.${secret}`,{scope:'runs:submit',repo:'owner/repo'}); assert.equal(p.id,'ci_bot'); assert.deepEqual(MANAGEMENT_SCOPES.length,8);
});
test('rejects malformed credentials, absent repo grants and scope/repository violations',async(t)=>{
 const {store:s}=await store(t); await assert.rejects(s.provision({id:'x',secret:'short',scopes:['health:read']}),{code:'invalid_credential'});
 await assert.rejects(s.provision({id:'x',secret,scopes:['runs:submit']}),{code:'repositories_required'});
 await s.provision({id:'x',secret,scopes:['runs:read'],repositories:['owner/repo']});
 await assert.rejects(s.authenticate(`Bearer x.${secret}`,{scope:'runs:cancel'}),{status:403});
 await assert.rejects(s.authenticate(`Bearer x.${secret}`,{repo:'owner/other'}),{status:403});
 for(const auth of ['Bearer x.no','Bearer x.'+secret+' trailing','Basic '+secret]) await assert.rejects(s.authenticate(auth),{status:401});
});
test('revocation takes effect on the next authentication',async(t)=>{
 const {store:s}=await store(t); await s.provision({id:'x',secret,scopes:['health:read']}); assert.equal(await s.revoke('x'),true);
 await assert.rejects(s.authenticate(`Bearer x.${secret}`),{status:401});
});
test('rejects unsafe directory and symlink credential file',async(t)=>{
 const {directory,store:s}=await store(t); await chmod(directory,0o755);
 await assert.rejects(s.provision({id:'x',secret,scopes:['health:read']}),{code:'unsafe_storage'});
 const {directory:d,store:other}=await store(t); await symlink('/dev/null',join(d,'credentials.json'));
 await assert.rejects(other.authenticate(`Bearer x.${secret}`),{code:'unsafe_storage'});
});

test('principal IDs cannot be coerced or change the credential map prototype',async(t)=>{
 const {store:s}=await store(t);
 for(const id of [undefined,null,['client'],'__proto__','constructor','prototype','_dashboard']) {
  await assert.rejects(s.provision({id,secret,scopes:['health:read']}),{code:'invalid_credential'});
 }
});

test('authentication refuses storage whose directory became public',async(t)=>{
 const {directory,store:s}=await store(t);
 await s.provision({id:'client',secret,scopes:['health:read']});
 await chmod(directory,0o755);
 await assert.rejects(s.authenticate(`Bearer client.${secret}`),{code:'unsafe_storage'});
});

test('malformed persisted credentials yield a safe storage error',async(t)=>{
 const {directory,store:s}=await store(t);
 await s.provision({id:'client',secret,scopes:['health:read']});
 await writeFile(join(directory,'credentials.json'),JSON.stringify({version:1,principals:{client:{salt:3,digest:null,scopes:[]}}}));
 await assert.rejects(s.authenticate(`Bearer client.${secret}`),{code:'unsafe_storage'});
});

test('repository identity is canonical across case changes',async(t)=>{
 const {store:s}=await store(t);
 await s.provision({id:'client',secret,scopes:['runs:read'],repositories:['Owner/Repo']});
 const principal=await s.authenticate(`Bearer client.${secret}`,{scope:'runs:read',repo:'owner/repo'});
 assert.deepEqual(principal.repositories,['owner/repo']);
});
