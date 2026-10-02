import express, { Request, Response, NextFunction } from 'express';
import http from 'node:http';
import { randomBytes, randomUUID } from 'node:crypto';
import { Server } from 'socket.io';
import cors from 'cors';
import bcrypt from 'bcrypt';
import jwt from 'jsonwebtoken';
import { Pool } from 'pg';
import { pool, initDb, transaction } from './db';
import { entities, membership, validateRecord, writeRecord } from './crud';
import { ApiError, object, text, uuid, UUID, date, choice, relationshipTypes } from './validation';
import { synchronize, safeUser, coupleProfile } from './sync';
import { initFcm, sendPushToUser } from './fcm';

type AuthRequest = Request & { user?: { id: string } };
export function createApplication(db: Pool, secret: string) {
  if (secret.length < 32 || /fallback_secret|troque_por|chamego_super_secret/i.test(secret)) throw new Error('JWT_SECRET must be a random secret of at least 32 characters');
  const app = express();
  const server = http.createServer(app);
  const origins = (process.env.CORS_ORIGINS ?? '').split(',').filter(Boolean);
  const io = new Server(server,{path:'/ws',cors:{origin:origins},maxHttpBufferSize:16384});
  app.disable('x-powered-by');
  if (process.env.TRUST_PROXY) app.set('trust proxy',process.env.TRUST_PROXY);
  app.use(cors({origin:origins}));
  app.use(express.json({limit:'1mb'}));
  app.use((req,res,next)=>{
    res.setHeader('X-Content-Type-Options','nosniff');
    res.setHeader('Cache-Control','no-store');
    const started=Date.now();
    res.on('finish',()=>console.log(JSON.stringify({event:'http',method:req.method,path:req.path,status:res.statusCode,duration_ms:Date.now()-started})));
    next();
  });
  const buckets = new Map<string,{count:number;expires:number}>();
  const cleanup = setInterval(()=>{for(const [key,value] of buckets) if(value.expires<Date.now()) buckets.delete(key);},60000);
  cleanup.unref();
  function limit(req: Request,res: Response,next: NextFunction) {
    const key=`${req.path}:${req.ip ?? 'unknown'}`;
    let value=buckets.get(key);
    if(!value || value.expires<Date.now()) { value={count:0,expires:Date.now()+60000}; buckets.set(key,value); }
    if(++value.count>30) { res.setHeader('Retry-After','60'); res.status(429).json({error:'Muitas tentativas. Aguarde um minuto.'}); return; }
    next();
  }
  const verify=(token:unknown)=>{
    if(typeof token!=='string') throw new ApiError(401,'Autenticacao obrigatoria.');
    const decoded=jwt.verify(token,secret,{algorithms:['HS256']});
    if(typeof decoded==='string' || typeof decoded.id!=='string' || !UUID.test(decoded.id) || typeof decoded.exp!=='number') throw new ApiError(401,'Token invalido.');
    return {id:uuid(decoded.id),exp:decoded.exp};
  };
  const auth=async(req:AuthRequest,_res:Response,next:NextFunction)=>{
    try {
      const match=/^Bearer (\S+)$/i.exec(req.headers.authorization ?? '');
      req.user=verify(match?.[1]);
      if(!(await db.query('SELECT id FROM users WHERE id=$1',[req.user.id])).rowCount) throw new ApiError(401,'Conta indisponivel.');
      next();
    } catch { next(new ApiError(401,'Sessao invalida. Entre novamente.')); }
  };
  const route=(fn:(req:AuthRequest,res:Response)=>Promise<any>)=>async(req:AuthRequest,res:Response,next:NextFunction)=>{
    try { await fn(req,res); } catch(err) { next(err); }
  };
  app.get(['/health','/api/health'],(_req,res)=>res.json({status:'ok'}));
  app.get(['/ready','/api/ready'],route(async(_req,res)=>{await db.query('SELECT 1');res.json({status:'ready',protocol:2});}));
  app.post('/api/auth/register',limit,route(async(req,res)=>{
    const b=object(req.body);const name=text(b.name);const email=text(b.email).toLowerCase();const password=text(b.password,72);
    if(!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || password.length<8 || Buffer.byteLength(b.password)>72) throw new ApiError(400,'E-mail invalido ou senha menor que 8 caracteres.');
    const hash=await bcrypt.hash(b.password,12);
    const user=await transaction(db,async c=>safeUser((await c.query('INSERT INTO users(name,email,password_hash) VALUES($1,$2,$3) RETURNING *',[name,email,hash])).rows[0]));
    res.status(201).json({user,token:jwt.sign({id:user.id},secret,{expiresIn:'7d'})});
  }));
  app.post('/api/auth/login',limit,route(async(req,res)=>{
    const b=object(req.body);const email=text(b.email).toLowerCase();text(b.password,72);
    const user=(await db.query('SELECT * FROM users WHERE email=$1',[email])).rows[0];
    const match=await bcrypt.compare(b.password,user?.password_hash ?? '$2b$12$abcdefghijklmnopqrstuuO4vG6oylbTW27APDt4KcvLehUFwjoPe');
    if(!user || !match) throw new ApiError(401,'E-mail ou senha incorretos.');
    res.json({user:safeUser(user),token:jwt.sign({id:user.id},secret,{expiresIn:'7d'})});
  }));
  app.get('/api/users/me',auth,route(async(req,res)=>res.json({user:safeUser((await db.query('SELECT * FROM users WHERE id=$1',[req.user!.id])).rows[0])})));
  app.get('/api/couples/me',auth,route(async(req,res)=>res.json(await transaction(db,c=>coupleProfile(c,req.user!.id)))));
  app.post('/api/couples/invite',auth,limit,route(async(req,res)=>{
    const result=await transaction(db,async c=>{
      const me=(await c.query('SELECT * FROM users WHERE id=$1 FOR UPDATE',[req.user!.id])).rows[0];
      if(me.couple_id) {
        const current=await coupleProfile(c,me.id);
        if(current.couple?.user2_id) return current;
        if(current.couple) {
          await c.query("UPDATE couples SET code=$1,invite_expires_at=NOW()+INTERVAL '7 days',updated_at=NOW() WHERE id=$2",['AMOR-'+randomBytes(6).toString('hex').toUpperCase(),current.couple.id]);
          return coupleProfile(c,me.id);
        }
        throw new ApiError(409,'Relacionamento inconsistente. Contate o suporte.');
      }
      const couple=(await c.query("INSERT INTO couples(code,user1_id,start_date,invite_expires_at) VALUES($1,$2,NOW(),NOW()+INTERVAL '7 days') RETURNING *",['AMOR-'+randomBytes(6).toString('hex').toUpperCase(),me.id])).rows[0];
      await c.query('UPDATE users SET couple_id=$1,updated_at=NOW() WHERE id=$2',[couple.id,me.id]);
      return coupleProfile(c,me.id);
    });
    await transaction(db,async c=>{
      const current=await coupleProfile(c,req.user!.id);
      const sockets=await io.in(`user:${req.user!.id}`).fetchSockets();
      for(const socket of sockets) {
        for(const room of socket.rooms) if(room.startsWith('couple:')) await socket.leave(room);
        if(current.couple) await socket.join(`couple:${current.couple.id}`);
      }
    });
    res.json(result);
  }));
  app.post('/api/couples/pair',auth,limit,route(async(req,res)=>{
    const code=text(object(req.body).code,20).toUpperCase();
    const result=await transaction(db,async c=>{
      const me=(await c.query('SELECT * FROM users WHERE id=$1 FOR UPDATE',[req.user!.id])).rows[0];
      const couple=(await c.query('SELECT * FROM couples WHERE code=$1 AND ended_at IS NULL FOR UPDATE',[code])).rows[0];
      if(!couple) throw new ApiError(404,'Convite invalido.');
      const inviter=(await c.query('SELECT couple_id FROM users WHERE id=$1',[couple.user1_id])).rows[0];
      if(inviter?.couple_id!==couple.id) throw new ApiError(404,'Convite indisponivel.');
      if(me.couple_id===couple.id) return coupleProfile(c,me.id);
      if(me.couple_id) {
        const own=(await c.query('SELECT * FROM couples WHERE id=$1 FOR UPDATE',[me.couple_id])).rows[0];
        if(!own || own.user1_id!==me.id || own.user2_id) throw new ApiError(409,'Desconecte do casal atual primeiro.');
        await c.query('UPDATE couples SET ended_at=NOW(),updated_at=NOW() WHERE id=$1',[own.id]);
      }
      if(couple.user2_id || (couple.invite_expires_at && new Date(couple.invite_expires_at)<new Date())) throw new ApiError(409,'Convite expirado ou casal completo.');
      await c.query('UPDATE couples SET user2_id=$1,updated_at=NOW(),invite_expires_at=NULL WHERE id=$2',[me.id,couple.id]);
      await c.query('UPDATE users SET couple_id=$1,updated_at=NOW() WHERE id=$2',[couple.id,me.id]);
      return coupleProfile(c,me.id);
    });
    const c=result.couple!;
    await transaction(db,async client=>{
      for(const userId of [c.user1_id,c.user2_id]) {
        const current=await coupleProfile(client,userId);
        const sockets=await io.in(`user:${userId}`).fetchSockets();
        for(const socket of sockets) {
          for(const room of socket.rooms) if(room.startsWith('couple:')) await socket.leave(room);
          if(current.couple) await socket.join(`couple:${current.couple.id}`);
        }
      }
      if((await coupleProfile(client,req.user!.id)).couple?.id===c.id) io.to(`couple:${c.id}`).emit('partner_joined',{couple_id:c.id});
    });
    res.json(result);
  }));
  app.post('/api/couples/unpair',auth,route(async(req,res)=>{
    const id=await transaction(db,async c=>{
      const id=await membership(c,req.user!.id);
      await c.query('UPDATE couples SET ended_at=NOW(),updated_at=NOW() WHERE id=$1',[id]);
      await c.query('UPDATE users SET couple_id=NULL,updated_at=NOW() WHERE couple_id=$1',[id]);
      return id;
    });
    io.to(`couple:${id}`).emit('couple_ended',{couple_id:id});
    io.in(`couple:${id}`).socketsLeave(`couple:${id}`);
    res.json({status:'success'});
  }));
  app.post('/api/couples/start-date',auth,route(async(req,res)=>{
    const start=date(object(req.body).start_date);
    await transaction(db,async c=>{const id=await membership(c,req.user!.id);await c.query('UPDATE couples SET start_date=$1,updated_at=NOW() WHERE id=$2',[start,id]);});res.json({status:'success'});
  }));
  app.post(['/api/users/relationship-type','/api/couples/relationship-type'],auth,route(async(req,res)=>{
    const type=choice(object(req.body).relationship_type,relationshipTypes);
    await transaction(db,c=>c.query('UPDATE users SET relationship_type=$1,updated_at=NOW() WHERE id=$2',[type,req.user!.id]));res.json({status:'success'});
  }));
  app.post('/api/users/fcm-token',auth,route(async(req,res)=>{
    const token=text(object(req.body).fcm_token,512);
    await transaction(db,async c=>{await c.query('UPDATE users SET fcm_token=NULL WHERE fcm_token=$1 AND id<>$2',[token,req.user!.id]);await c.query('UPDATE users SET fcm_token=$1 WHERE id=$2',[token,req.user!.id]);});res.json({status:'success'});
  }));
  app.delete('/api/users/fcm-token',auth,route(async(req,res)=>{
    const token=text(object(req.body).fcm_token,512);
    await transaction(db,c=>c.query('UPDATE users SET fcm_token=NULL WHERE id=$1 AND fcm_token=$2',[req.user!.id,token]));
    res.json({status:'success'});
  }));
  async function deliver(row:any) {
    const profile=await transaction(db,c=>coupleProfile(c,row.sender_id));
    if(!profile.couple || profile.couple.id!==row.couple_id) return;
    const sender=safeUser((await db.query('SELECT * FROM users WHERE id=$1',[row.sender_id])).rows[0]);
    const event={id:row.id,couple_id:row.couple_id,sender_id:row.sender_id,sender_name:sender.name,emote:row.type,text:row.text,timestamp:row.created_at};
    io.to(`couple:${row.couple_id}`).emit('receive_emote',event);
    if(profile.partner) await sendPushToUser(db,profile.partner.id,{title:`${sender.name} te mandou um chamego!`,body:row.text,data:Object.fromEntries(Object.entries({...event,type:row.type}).map(([k,v])=>[k,String(v)]))});
  }
  app.post('/api/notifications/emote',auth,limit,route(async(req,res)=>{
    const b=object(req.body);const result=await transaction(db,async c=>{
      const coupleId=await membership(c,req.user!.id);
      return writeRecord(c,'chamegos',{id:b.id ?? randomUUID(),couple_id:b.couple_id,text:b.text ?? b.emote,type:b.emote,created_at:b.timestamp ?? new Date().toISOString()},req.user!.id,coupleId);
    });
    if(result.inserted) void deliver(result.row).catch(()=>console.error(JSON.stringify({event:'message_delivery_failed',id:result.row.id})));
    res.json({status:'success',chamego:result.row});
  }));
  app.post('/api/sync',auth,route(async(req,res)=>{
    const result=await synchronize(db,req.user!.id,req.body,secret);
    for(const row of result.messages) void deliver(row).catch(()=>console.error(JSON.stringify({event:'message_delivery_failed',id:row.id})));
    const {messages,...response}=result;res.json(response);
  }));
  app.post('/api/recovery',auth,route(async(req,res)=>{
    const body=object(req.body);
    if(!Array.isArray(body.records)||body.records.length>100) throw new ApiError(400,'Lote de recuperação inválido.');
    const records=body.records.map((item:unknown)=>{const r=object(item);if(!Object.hasOwn(entities,r.entity)) throw new ApiError(400,'Recurso inválido.');uuid(object(r.record).id);return r;});
    const result=await transaction(db,async c=>{
      const coupleId=await membership(c,req.user!.id);
      const retry: {entity:string;id:string}[]=[];
      const quarantine: {entity:string;id:string}[]=[];
      for(const {entity,record:legacy} of records) {
        const record={...legacy};
        try {
          if(record.is_deleted===0 || record.is_deleted===1) record.is_deleted=record.is_deleted===1;
          if(entity==='memories' && typeof record.photo_urls==='string') record.photo_urls=JSON.parse(record.photo_urls);
          if(entity==='special_dates') {
            record.repeat_option=({'Não repete':'none','Todo ano':'yearly'} as Record<string,string>)[record.repeat_option] ?? record.repeat_option;
            record.notify_option=({'No dia':'day','1 dia antes':'1day_before','1 semana antes':'1week_before'} as Record<string,string>)[record.notify_option] ?? record.notify_option;
          }
          validateRecord(entity,record);
          date(entity==='chamegos' ? record.created_at : record.updated_at);
          if(record.legacy_created_at!==undefined) date(record.legacy_created_at);
        } catch {
          quarantine.push({entity,id:record.id});continue;
        }
        if(record.couple_id!==coupleId) {quarantine.push({entity,id:record.id});continue;}
        const existing=(await c.query(`SELECT * FROM ${entity} WHERE id=$1`,[record.id])).rows[0];
        if(existing && (existing.couple_id!==coupleId || (entity==='gifts' && existing.type==='secret' && existing.creator_id!==req.user!.id))) {quarantine.push({entity,id:record.id});continue;}
        if(!existing && entity==='gifts' && record.type==='secret' && record.creator_id!==req.user!.id) {quarantine.push({entity,id:record.id});continue;}
        if(entity==='chamegos') {
          if(record.sender_id!==req.user!.id) continue;
          if(!existing) {
            const duplicate=await c.query(`SELECT id FROM chamegos WHERE couple_id=$1 AND sender_id=$2 AND text=$3 AND type=$4 AND (ABS(EXTRACT(EPOCH FROM created_at-$5::timestamptz))<60 OR ABS(EXTRACT(EPOCH FROM created_at-$6::timestamptz))<60) LIMIT 1`,[coupleId,req.user!.id,record.text,record.type,date(record.created_at),date(record.legacy_created_at ?? record.created_at)]);
            if(duplicate.rowCount) {quarantine.push({entity,id:record.id});continue;}
            retry.push({entity,id:record.id});
          }
        } else if(!existing || (Date.parse(record.updated_at)>new Date(existing.updated_at).getTime() && record.is_deleted!==existing.is_deleted) || (!existing.is_deleted && Date.parse(record.updated_at)>new Date(existing.updated_at).getTime())) {
          retry.push({entity,id:record.id});
        }
      }
      return {retry,quarantine};
    });res.json(result);
  }));
  for(const entity of Object.keys(entities).filter(k=>k!=='chamegos')) {
    const path='/api/'+entity.replaceAll('_','-');
    app.get(path,auth,route(async(req,res)=>{
      const result=await transaction(db,async c=>{
        const id=await membership(c,req.user!.id);
        const offset=Number(req.query.offset ?? 0);const count=Number(req.query.limit ?? 100);
        if(!Number.isInteger(offset)||offset<0||!Number.isInteger(count)||count<1||count>500) throw new ApiError(400,'Paginacao invalida.');
        return (await c.query(`SELECT * FROM ${entity} WHERE couple_id=$1 AND is_deleted=FALSE ${entity==='gifts'?"AND (type<>'secret' OR creator_id=$2)":''} ORDER BY created_at DESC,id LIMIT ${count} OFFSET ${offset}`,entity==='gifts'?[id,req.user!.id]:[id])).rows;
      });res.json(result);
    }));
    app.post(path,auth,route(async(req,res)=>{const b=object(req.body);const r=await transaction(db,async c=>writeRecord(c,entity,b,req.user!.id,await membership(c,req.user!.id)));res.status(r.inserted?201:200).json(r.row);}));
    app.put(path+'/:id',auth,route(async(req,res)=>{const b={...object(req.body),id:uuid(req.params.id)};const r=await transaction(db,async c=>writeRecord(c,entity,b,req.user!.id,await membership(c,req.user!.id),true));res.json(r.row);}));
    app.delete(path+'/:id',auth,route(async(req,res)=>{const id=uuid(req.params.id);await transaction(db,async c=>writeRecord(c,entity,{id,is_deleted:true},req.user!.id,await membership(c,req.user!.id),true));res.json({status:'success',id});}));
  }
  io.use(async(socket,next)=>{
    try {
      const user=verify(socket.handshake.auth.token ?? socket.handshake.query.token);
      if(!(await db.query('SELECT id FROM users WHERE id=$1',[user.id])).rowCount) throw new Error();
      socket.data.userId=user.id;socket.data.expires=user.exp;next();
    } catch { next(new Error('Unauthorized')); }
  });
  io.on('connection',socket=>{
    socket.join(`user:${socket.data.userId}`);
    const expire=setTimeout(()=>socket.disconnect(true),Math.max(0,(socket.data.expires*1000)-Date.now()));expire.unref();
    const join=()=>transaction(db,async c=>{
      const id=await membership(c,socket.data.userId);
      for(const room of socket.rooms) if(room.startsWith('couple:')) await socket.leave(room);
      await socket.join(`couple:${id}`);
    });
    void join().catch(()=>{});
    socket.on('join_couple',(_data,ack)=>{void join().then(()=>{if(typeof ack==='function') ack({status:'success'});}).catch(()=>{if(typeof ack==='function') ack({error:'Unauthorized'});});});
    // Sending is HTTP/sync only: one persistence and identity path.
    socket.on('send_emote',(_data,ack)=>{if(typeof ack==='function') ack({error:'Use HTTP /api/notifications/emote'});});
    socket.on('disconnect',()=>clearTimeout(expire));
  });
  app.use((_req,res)=>res.status(404).json({error:'Rota nao encontrada.'}));
  app.use((err:any,_req:Request,res:Response,_next:NextFunction)=>{
    const status=err instanceof ApiError?err.status:err.type==='entity.parse.failed'?400:err.type==='entity.too.large'?413:err.code==='23505'?409:['22P02','22007','22008','23502','22001'].includes(err.code)?400:500;
    if(status===500) console.error(JSON.stringify({event:'request_error',code:err.code ?? 'internal'}));
    res.status(status).json({error:err instanceof ApiError?err.message:status===409?'Registro ja existe.':status<500?'Requisicao invalida.':'Erro interno do servidor.'});
  });
  return {app,server,io,dispose:()=>clearInterval(cleanup)};
}
async function main() {
  if(!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required');
  const runtime=createApplication(pool,process.env.JWT_SECRET ?? '');
  await initDb();
  if(!initFcm() && process.env.REQUIRE_FCM==='true') throw new Error('Firebase configuration is required');
  const port=Number(process.env.PORT ?? 34343);
  if(!Number.isInteger(port)||port<1||port>65535) throw new Error('Invalid PORT');
  runtime.server.listen(port,'0.0.0.0',()=>console.log(JSON.stringify({event:'listening',port})));
  let stopping=false;
  const stop=()=>{
    if(stopping) return;stopping=true;
    const timeout=setTimeout(()=>process.exit(1),10000);timeout.unref();
    runtime.dispose();runtime.io.close(()=>{void pool.end().then(()=>{clearTimeout(timeout);process.exit(0);});});
  };
  process.on('SIGTERM',stop);process.on('SIGINT',stop);
}
if(require.main===module) void main().catch(()=>{console.error(JSON.stringify({event:'startup_failed',hint:'Check configuration and database migration permissions'}));void pool.end().finally(()=>{process.exitCode=1;});});
