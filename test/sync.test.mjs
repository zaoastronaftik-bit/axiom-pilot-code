import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { webcrypto } from 'node:crypto';
import { Store } from '../dist/storage.js';
import { snapshotForBrowser, sealSnapshot } from '../dist/sync.js';
import { accountOrigin, DeviceAuth } from '../dist/auth.js';

test('offline history snapshot reads saved sessions only, excludes tools and project paths', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'axiom-sync-'));
  try {
    const store = new Store(root);
    await mkdir(path.join(root, 'sessions'));
    await writeFile(path.join(root, 'sessions', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa.json'), JSON.stringify({
      id:'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      cwd:'/private/project',
      model:'LocalQwen',
      updatedAt:'2026-10-19T07:00:00Z',
      messages:[
        {role:'system',content:'PRIVATE_SYSTEM'},
        {role:'user',content:'Review this code. api_key=NEVER_EXPOSE'},
        {role:'tool',content:'PRIVATE_TOOL_OUTPUT'},
        {role:'assistant',content:'Check completed.'}
      ]
    }));
    const snapshot = await snapshotForBrowser(store,[{id:'core',name:'Axiom Core',version:'1.0',source:'built-in'}]);
    assert.equal(snapshot.schema, 1);
    assert.equal(snapshot.modules.length, 1);
    assert.equal(snapshot.chats.length, 1);
    const encoded = JSON.stringify(snapshot);
    assert.ok(!encoded.includes('/private/project'));
    assert.ok(!encoded.includes('PRIVATE_SYSTEM'));
    assert.ok(!encoded.includes('PRIVATE_TOOL_OUTPUT'));
    assert.ok(!encoded.includes('NEVER_EXPOSE'));
    assert.ok(encoded.includes('Check completed.'));
  } finally { await rm(root,{recursive:true,force:true}); }
});

test('client RSA-OAEP + AES-256-GCM envelope decrypts only with recipient private key', async () => {
  const pair = await webcrypto.subtle.generateKey({
    name:'RSA-OAEP',modulusLength:3072,
    publicExponent:new Uint8Array([1,0,1]),hash:'SHA-256'
  },false,['encrypt','decrypt']);
  const publicKey = await webcrypto.subtle.exportKey('jwk',pair.publicKey);
  const snapshot = {schema:1,modules:[],chats:[{id:'chat',title:'Secret test',date:'',model:'',messages:[]}]};
  const envelope = await sealSnapshot(snapshot,publicKey);
  assert.equal(envelope.alg,'RSA-OAEP-256+A256GCM');
  assert.equal(envelope.iv.length,16);
  assert.ok(!JSON.stringify(envelope).includes('Secret test'));
  const aesRaw = await webcrypto.subtle.decrypt({name:'RSA-OAEP'},pair.privateKey,Buffer.from(envelope.ek,'base64url'));
  const aes = await webcrypto.subtle.importKey('raw',aesRaw,'AES-GCM',false,['decrypt']);
  const recovered = await webcrypto.subtle.decrypt({name:'AES-GCM',iv:Buffer.from(envelope.iv,'base64url')},aes,Buffer.from(envelope.data,'base64url'));
  assert.deepEqual(JSON.parse(new TextDecoder().decode(recovered)),snapshot);
  await assert.rejects(sealSnapshot(snapshot,{kty:'RSA',e:'AQAB',n:'bad',alg:'RSA-OAEP'}));
});

test('CLI account URL accepts secure Supabase Edge Function path, preserving existing origin', () => {
  assert.equal(accountOrigin('https://example.supabase.co/functions/v1/axiom-bridge'),
    'https://example.supabase.co/functions/v1/axiom-bridge');
  assert.equal(accountOrigin('https://example.com'), 'https://example.com');
  assert.throws(() => accountOrigin('http://example.com/functions/v1/axiom-bridge'));
  assert.throws(() => accountOrigin('https://user:password@example.com'));
});

test('CLI pairing requests append to deployed function path and never call approve', async () => {
  const urls = [];
  let credential = null;
  const secrets = {get:async()=>credential,set:async v=>{credential=v},delete:async()=>{credential=null}};
  const fetcher = async (url,init) => {
    urls.push(url);
    if(url.endsWith('/api/device?action=start')) return Response.json({
      deviceCode:'A'.repeat(43),userCode:'ABCD-EFGH',
      verificationUri:'https://example.com/?device=ABCD-EFGH',
      interval:1,expiresIn:60
    });
    if(url.endsWith('/api/device?action=poll'))return Response.json({status:'authorized',accessToken:'axiom_cli_'+'B'.repeat(43)});
    if(url.endsWith('/api/cli?action=revoke'))return Response.json({revoked:true});
    return Response.json({authenticated:true,plan:'free'});
  };
  const client = new DeviceAuth('https://example.supabase.co/functions/v1/axiom-bridge',secrets,fetcher);
  await client.login(new AbortController().signal,async()=>{});
  assert.ok(urls.every(url=>url.startsWith('https://example.supabase.co/functions/v1/axiom-bridge/api/')));
  assert.ok(!urls.some(url=>url.includes('approve')));
  await client.logout(new AbortController().signal);
  assert.equal(credential,null);
});
