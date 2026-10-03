import {test} from 'node:test';
import assert from 'node:assert/strict';
import {pushContent,preview} from '../src/fcm';
import {date} from '../src/validation';

test('large Unicode message previews fit Android and APNs payload limits',()=>{
  const data=Object.fromEntries(['id','couple_id','sender_id','sender_name','emote','type','timestamp'].map(k=>[k,'🤍'.repeat(4000)]));
  const content=pushContent('recipient',{title:'🤍'.repeat(4000),body:'🤍'.repeat(4000),data:{...data,text:'🤍'.repeat(4000)}});
  assert.ok(Buffer.byteLength(JSON.stringify(content.data))<4096);
  assert.ok(Buffer.byteLength(JSON.stringify({...content.data,aps:{alert:{title:content.title,body:content.body},sound:'default'}}))<4096);
  assert.equal(content.data.recipient_id,'recipient');
  assert.equal(content.data.text,undefined);
  assert.ok(!content.body.includes('�'));
  assert.ok(content.body.endsWith('…'));
});
test('short message content and canonical metadata survive previewing',()=>{
  const content=pushContent('recipient',{title:'Title',body:'Abraço 🤍',data:{id:'uuid',couple_id:'couple',sender_id:'sender'}});
  assert.equal(content.body,'Abraço 🤍');assert.equal(content.data.id,'uuid');
  assert.equal(preview('🤍'.repeat(20),32),'🤍'.repeat(7)+'…');
});
test('invalid calendar dates are rejected instead of silently rolled forward',()=>{
  assert.throws(()=>date('2026-02-30T12:00:00Z'));
  assert.throws(()=>date('2025-02-29'));assert.throws(()=>date('2026-13-01'));
  assert.equal(date('2024-02-29'),'2024-02-29T00:00:00.000Z');
});
