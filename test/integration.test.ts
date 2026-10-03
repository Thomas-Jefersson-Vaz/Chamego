import { test, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { Pool, PoolConfig } from 'pg';
import EmbeddedPostgres from 'embedded-postgres';
import { io as connectSocket } from 'socket.io-client';
import { createApplication } from '../src/index';
import { initDb, transaction } from '../src/db';

let postgres: EmbeddedPostgres;
let db: Pool;
let testConnection: PoolConfig;
let runtime: ReturnType<typeof createApplication>;
let base: string;
const secret = 'integration-test-secret-0123456789abcdef';
async function freePort() {
  const s=net.createServer();await new Promise<void>(r=>s.listen(0,'127.0.0.1',r));
  const port=(s.address() as net.AddressInfo).port;await new Promise<void>(r=>s.close(()=>r()));return port;
}
before(async()=>{
  const port=await freePort();
  postgres=new EmbeddedPostgres({databaseDir:await fs.mkdtemp(path.join(os.tmpdir(),'chamego-test-')),port,user:'test',password:randomUUID(),persistent:false,onLog:()=>{},onError:()=>{},postgresFlags:['-h','127.0.0.1']});
  await postgres.initialise();await postgres.start();
  const client=postgres.getPgClient();await client.connect();
  const config=client.connectionParameters;
  testConnection={host:'127.0.0.1',port,user:config.user,password:config.password,database:config.database,max:8};
  db=new Pool(testConnection);
  await client.end();await initDb(db);
}, {timeout:60000});
beforeEach(async()=>{
  runtime=createApplication(db,secret);
  await new Promise<void>(r=>runtime.server.listen(0,'127.0.0.1',r));
  base=`http://127.0.0.1:${(runtime.server.address() as net.AddressInfo).port}`;
});
afterEach(async()=>{runtime.dispose();await new Promise<void>(r=>runtime.io.close(()=>r()));});
after(async()=>{await db?.end();if(postgres) await postgres.stop();});
async function request(method:string,url:string,token?:string,data?:unknown) {
  const r=await fetch(base+url,{method,headers:{'Content-Type':'application/json',...(token?{Authorization:`Bearer ${token}`}:{})},body:data===undefined?undefined:JSON.stringify(data)});
  return {status:r.status,body:await r.json() as any};
}
async function user() {return (await request('POST','/api/auth/register',undefined,{name:'Test',email:`${randomUUID()}@example.com`,password:'valid-password'})).body;}
async function couple() {
  const a=await user(),b=await user();const invite=(await request('POST','/api/couples/invite',a.token,{})).body.couple;
  assert.equal((await request('POST','/api/couples/pair',b.token,{code:invite.code})).status,200);
  return {a,b,id:invite.id};
}
const sync=(token:string,mutations:any[]=[],cursor?:string)=>request('POST','/api/sync',token,{protocol:2,cursor,mutations});
const mutation=(entity:string,record:any)=>({mutation_id:randomUUID(),entity,record});

test('authentication rejects malformed payloads and incorrect credentials',async()=>{
  assert.equal((await request('POST','/api/auth/login',undefined,{email:12,password:'x'})).status,400);
  assert.equal((await request('POST','/api/auth/login',undefined,{email:'absent@example.com',password:'incorrect'})).status,401);
  assert.equal((await request('GET','/api/users/me')).status,401);
  assert.throws(()=>createApplication(db,'fallback_secret'));
});
test('migration reruns preserve existing data',async()=>{
  const a=await user();await initDb(db);assert.equal((await db.query('SELECT id FROM users WHERE id=$1',[a.user.id])).rowCount,1);
});
test('cross-couple inserts and conflicting IDs are denied and secret gifts stay private',async()=>{
  const c=await couple(),other=await couple();
  const id=randomUUID();
  assert.equal((await request('POST','/api/gifts',c.a.token,{id,title:'Secret',type:'secret'})).status,201);
  assert.deepEqual((await request('GET','/api/gifts',c.b.token)).body,[]);
  assert.equal((await request('DELETE',`/api/gifts/${id}`,c.b.token)).status,409);
  assert.equal((await sync(other.a.token,[mutation('gifts',{id,couple_id:other.id,title:'Overwrite',type:'wish'})])).status,409);
  assert.equal((await sync(other.a.token,[mutation('outings',{id:randomUUID(),couple_id:c.id,title:'Intrusion'})])).status,403);
  const partner=await sync(c.b.token);
  assert.ok(partner.body.remote_updates.gifts.every((g:any)=>!g.title));
});
test('sync atomicity, old event timestamps, receipt retries and deletion propagation',async()=>{
  const c=await couple();const initial=await sync(c.b.token);
  const id=randomUUID();const m=mutation('outings',{id,couple_id:c.id,title:'Offline',updated_at:'2000-01-01T00:00:00Z'});
  assert.equal((await sync(c.a.token,[m])).status,200);
  assert.equal((await sync(c.a.token,[m])).status,200);
  assert.equal((await db.query('SELECT count(*) FROM outings WHERE id=$1',[id])).rows[0].count,'1');
  const changed=await sync(c.b.token,[],initial.body.cursor);
  assert.equal(changed.body.remote_updates.outings[0].title,'Offline');
  const atomicId=randomUUID();
  assert.equal((await sync(c.a.token,[mutation('outings',{id:atomicId,title:'Valid'}),mutation('outings',{id:randomUUID(),title:'Invalid',status:'bad'})])).status,400);
  assert.equal((await db.query('SELECT id FROM outings WHERE id=$1',[atomicId])).rowCount,0);
  await request('DELETE',`/api/outings/${id}`,c.a.token);
  assert.equal((await sync(c.b.token,[],changed.body.cursor)).body.remote_updates.outings[0].is_deleted,true);
  assert.equal((await sync(c.b.token,[],initial.body.cursor+'tampered')).status,400);
});
test('concurrent pairing grants only one partner slot; unpair revokes access',async()=>{
  const a=await user(),b=await user(),c=await user();const invite=(await request('POST','/api/couples/invite',a.token,{})).body.couple;
  const results=await Promise.all([request('POST','/api/couples/pair',b.token,{code:invite.code}),request('POST','/api/couples/pair',c.token,{code:invite.code})]);
  assert.deepEqual(results.map(r=>r.status).sort(),[200,409]);
  assert.equal((await request('POST','/api/couples/unpair',a.token,{})).status,200);
  assert.equal((await request('GET','/api/outings',a.token)).status,403);
  assert.ok((await db.query('SELECT ended_at FROM couples WHERE id=$1',[invite.id])).rows[0].ended_at);
});
test('cursor capture waits for a concurrent writer and sees its committed row',async()=>{
  const c=await couple();const initial=await sync(c.b.token);
  let release!:()=>void;const barrier=new Promise<void>(r=>release=r);let entered!:()=>void;const ready=new Promise<void>(r=>entered=r);
  const id=randomUUID();
  const writer=transaction(db,async client=>{await client.query('INSERT INTO outings(id,couple_id,title) VALUES($1,$2,$3)',[id,c.id,'Concurrent']);entered();await barrier;});
  await ready;const reader=sync(c.b.token,[],initial.body.cursor);release();await writer;
  assert.equal((await reader).body.remote_updates.outings[0].id,id);
});
test('HTTP and sync message retries share one ID and authenticated sender',async()=>{
  const c=await couple();const id=randomUUID();const record={id,couple_id:c.id,text:'Hi',type:'custom',created_at:'2020-01-01T00:00:00Z',sender_id:c.b.user.id};
  assert.equal((await request('POST','/api/notifications/emote',c.a.token,{id,couple_id:c.id,text:'Hi',emote:'custom'})).status,200);
  assert.equal((await sync(c.a.token,[mutation('chamegos',record)])).status,200);
  const rows=(await db.query('SELECT * FROM chamegos WHERE id=$1',[id])).rows;
  assert.equal(rows.length,1);assert.equal(rows[0].sender_id,c.a.user.id);
});
test('FCM token reassignments are unique',async()=>{
  const a=await user(),b=await user();
  await Promise.all([request('POST','/api/users/fcm-token',a.token,{fcm_token:'test-device'}),request('POST','/api/users/fcm-token',b.token,{fcm_token:'test-device'})]);
  assert.equal((await db.query("SELECT count(*) FROM users WHERE fcm_token='test-device'")).rows[0].count,'1');
});
test('socket joining uses authenticated membership, not supplied couple ID',async()=>{
  const own=await couple(),other=await couple();
  const socket=connectSocket(base,{path:'/ws',auth:{token:own.a.token},transports:['websocket'],forceNew:true});
  try {
    await new Promise<void>((resolve,reject)=>{socket.once('connect',resolve);socket.once('connect_error',reject);});
    await new Promise<void>(r=>socket.emit('join_couple',{couple_id:other.id},()=>r()));
    const serverSocket=runtime.io.sockets.sockets.get(socket.id!);
    assert.ok(serverSocket?.rooms.has(`couple:${own.id}`));assert.ok(!serverSocket?.rooms.has(`couple:${other.id}`));
  } finally {socket.disconnect();}
});


test('legacy recovery quarantines malformed records without blocking valid data',async()=>{
  const c=await couple();const good=randomUUID(),bad=randomUUID(),privateId=randomUUID();
  const result=await request('POST','/api/recovery',c.a.token,{records:[
    {entity:'outings',record:{id:good,couple_id:c.id,title:'Recover',status:'planned',is_deleted:0,updated_at:'2026-01-01T00:00:00Z'}},
    {entity:'memories',record:{id:bad,couple_id:c.id,title:'Malformed',date:'invalid',photo_urls:'not json',updated_at:'invalid'}},
    {entity:'gifts',record:{id:privateId,couple_id:c.id,title:'Not mine',type:'secret',creator_id:c.b.user.id,updated_at:'2026-01-01T00:00:00Z'}}
  ]});
  assert.equal(result.status,200);
  assert.deepEqual(result.body.retry,[{entity:'outings',id:good}]);
  assert.deepEqual(result.body.quarantine,[{entity:'memories',id:bad},{entity:'gifts',id:privateId}]);
  assert.equal((await db.query('SELECT id FROM outings WHERE id=$1',[good])).rowCount,0);
});
test('legacy recovery suppresses HTTP-generated duplicate message IDs',async()=>{
  const c=await couple(),canonical=randomUUID(),legacy=randomUUID();const created_at=new Date().toISOString();
  await sync(c.a.token,[mutation('chamegos',{id:canonical,text:'Same message',type:'custom',created_at})]);
  const result=await request('POST','/api/recovery',c.a.token,{records:[{entity:'chamegos',record:{id:legacy,couple_id:c.id,sender_id:c.a.user.id,text:'Same message',type:'custom',created_at}}]});
  assert.equal(result.status,200);assert.deepEqual(result.body.retry,[]);
  assert.deepEqual(result.body.quarantine,[{entity:'chamegos',id:legacy}]);
});
test('unpair and socket join cannot restore a revoked couple room',async()=>{
  const c=await couple();
  const socket=connectSocket(base,{path:'/ws',auth:{token:c.a.token},transports:['websocket'],forceNew:true});
  try {
    await new Promise<void>((resolve,reject)=>{socket.once('connect',resolve);socket.once('connect_error',reject);});
    const joins=Array.from({length:5},()=>new Promise<void>(r=>socket.emit('join_couple',{couple_id:c.id},()=>r())));
    const ended=request('POST','/api/couples/unpair',c.b.token,{});
    await Promise.all([...joins,ended]);
    const denied=await new Promise<any>(r=>socket.emit('join_couple',{couple_id:c.id},r));
    assert.ok(denied.error);
    assert.ok(!runtime.io.sockets.sockets.get(socket.id!)?.rooms.has(`couple:${c.id}`));
    assert.equal((await sync(c.a.token)).body.remote_updates.user.couple_id,null);
  } finally {socket.disconnect();}
});
test('late batch authorization failure rolls back writes and receipts',async()=>{
  const c=await couple(),other=await couple();const id=randomUUID();
  const m=mutation('outings',{id,title:'Rollback'});
  const result=await sync(c.a.token,[m,mutation('outings',{id:randomUUID(),couple_id:other.id,title:'Wrong couple'})]);
  assert.equal(result.status,403);
  assert.equal((await db.query('SELECT id FROM outings WHERE id=$1',[id])).rowCount,0);
  assert.equal((await db.query('SELECT mutation_id FROM mutation_receipts WHERE mutation_id=$1',[m.mutation_id])).rowCount,0);
});
test('privacy transitions and journal pagination preserve visible current state',async()=>{
  const c=await couple(),id=randomUUID();
  await request('POST','/api/gifts',c.a.token,{id,title:'Public then private',type:'wish'});
  const initial=await sync(c.b.token);
  await request('PUT',`/api/gifts/${id}`,c.a.token,{type:'secret'});
  assert.deepEqual((await sync(c.b.token,[],initial.body.cursor)).body.remote_updates.gifts,[{id,is_deleted:true}]);
  await transaction(db,async client=>{
    await client.query(`INSERT INTO outings(id,couple_id,title) SELECT uuid_generate_v4(),$1,'Page '||i FROM generate_series(1,505) i`,[c.id]);
  });
  let cursor=initial.body.cursor;const seen=new Set<string>();let pages=0;
  do {
    const result=await sync(c.b.token,[],cursor);assert.equal(result.status,200);
    for(const row of result.body.remote_updates.outings) seen.add(row.id);
    cursor=result.body.cursor;pages++;
    if(!result.body.has_more) break;
  } while(pages<5);
  assert.equal(seen.size,505);assert.ok(pages>1);
});

test('upgrading an existing pre-migration database preserves users and relationship data',async()=>{
  const name='legacy_'+randomUUID().replaceAll('-','');
  await db.query(`CREATE DATABASE ${name}`);
  const legacy=new Pool({...testConnection,database:name});
  try {
    await legacy.query(await fs.readFile(path.join(process.cwd(),'src/schema.sql'),'utf8'));
    await legacy.query('ALTER TABLE users DROP COLUMN relationship_type, DROP COLUMN fcm_token');
    const userId=randomUUID(),coupleId=randomUUID(),giftId=randomUUID();
    await legacy.query('INSERT INTO users(id,name,email,password_hash) VALUES($1,$2,$3,$4)',[userId,'Existing','existing@example.com','hash']);
    await legacy.query('INSERT INTO couples(id,code,user1_id) VALUES($1,$2,$3)',[coupleId,'OLD-CODE',userId]);
    await legacy.query('UPDATE users SET couple_id=$1 WHERE id=$2',[coupleId,userId]);
    await legacy.query("INSERT INTO gifts(id,couple_id,creator_id,title,type) VALUES($1,$2,$3,'Keep private','secret')",[giftId,coupleId,userId]);
    const dateId=randomUUID();
    await legacy.query("INSERT INTO special_dates(id,couple_id,title,date,repeat_option,notify_option) VALUES($1,$2,'Legacy date','2024-02-29','Todo ano','1 dia antes')",[dateId,coupleId]);
    await initDb(legacy);await initDb(legacy);
    const migratedDate=(await legacy.query('SELECT repeat_option,notify_option FROM special_dates WHERE id=$1',[dateId])).rows[0];
    assert.deepEqual(migratedDate,{repeat_option:'yearly',notify_option:'1day_before'});
    assert.equal((await legacy.query('SELECT name,couple_id FROM users WHERE id=$1',[userId])).rows[0].couple_id,coupleId);
    assert.equal((await legacy.query('SELECT title FROM gifts WHERE id=$1',[giftId])).rows[0].title,'Keep private');
    assert.ok((await legacy.query('SELECT invite_expires_at FROM couples WHERE id=$1',[coupleId])).rows[0].invite_expires_at);
    assert.equal((await legacy.query('SELECT version FROM schema_migrations')).rowCount,2);
    assert.ok((await legacy.query('SELECT record_id FROM sync_changes WHERE record_id=$1',[giftId])).rowCount);
  } finally {
    await legacy.end();await db.query(`DROP DATABASE ${name}`);
  }
});

test('revoking an older FCM token does not clear a newly registered device',async()=>{
  const a=await user();
  await request('POST','/api/users/fcm-token',a.token,{fcm_token:'old-device-token'});
  await request('POST','/api/users/fcm-token',a.token,{fcm_token:'new-device-token'});
  assert.equal((await request('DELETE','/api/users/fcm-token',a.token,{fcm_token:'old-device-token'})).status,200);
  assert.equal((await db.query('SELECT fcm_token FROM users WHERE id=$1',[a.user.id])).rows[0].fcm_token,'new-device-token');
  await request('DELETE','/api/users/fcm-token',a.token,{fcm_token:'new-device-token'});
  assert.equal((await db.query('SELECT fcm_token FROM users WHERE id=$1',[a.user.id])).rows[0].fcm_token,null);
});

test('orphaned historical invitations cannot create a one-sided relationship',async()=>{
  const a=await user(),b=await user();
  const invite=(await request('POST','/api/couples/invite',a.token,{})).body.couple;
  await transaction(db,c=>c.query('UPDATE users SET couple_id=NULL WHERE id=$1',[a.user.id]));
  assert.equal((await request('POST','/api/couples/pair',b.token,{code:invite.code})).status,404);
  assert.equal((await db.query('SELECT couple_id FROM users WHERE id=$1',[b.user.id])).rows[0].couple_id,null);
  assert.equal((await db.query('SELECT user2_id FROM couples WHERE id=$1',[invite.id])).rows[0].user2_id,null);
});


test('short invitation codes are unique, stable and refresh expired legacy codes', async()=>{
  const a=await user(),b=await user();
  const first=(await request('POST','/api/couples/invite',a.token,{})).body.couple;
  assert.match(first.code,/^AMOR-[0-9]{4}$/);
  const again=(await request('POST','/api/couples/invite',a.token,{})).body.couple;
  assert.equal(again.code,first.code);
  const other=(await request('POST','/api/couples/invite',b.token,{})).body.couple;
  assert.notEqual(other.code,first.code);
  await db.query("UPDATE couples SET code='AMOR-ABCDEF123456',invite_expires_at=NOW()-INTERVAL '1 day' WHERE id=$1",[first.id]);
  const renewed=(await request('POST','/api/couples/invite',a.token,{})).body.couple;
  assert.match(renewed.code,/^AMOR-[0-9]{4}$/);
  assert.equal(renewed.id,first.id);
  assert.equal((await request('POST','/api/couples/pair',b.token,{code:renewed.code})).status,200);
});
