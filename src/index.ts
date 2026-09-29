import express, { Request, Response, NextFunction } from 'express';
import http from 'http';
import { Server, Socket } from 'socket.io';
import cors from 'cors';
import dotenv from 'dotenv';
import bcrypt from 'bcrypt';
import jwt from 'jsonwebtoken';
import { pool, initDb } from './db';

dotenv.config();

// ──────────────────────────────────────────────
// Logger Utility
// ──────────────────────────────────────────────
const colors = {
  reset: '\x1b[0m',
  dim: '\x1b[2m',
  cyan: '\x1b[36m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  red: '\x1b[31m',
  magenta: '\x1b[35m',
  blue: '\x1b[34m',
};

function timestamp(): string {
  return new Date().toISOString();
}

const log = {
  info: (tag: string, msg: string, data?: any) => {
    console.log(`${colors.dim}${timestamp()}${colors.reset} ${colors.cyan}[${tag}]${colors.reset} ${msg}`);
    if (data !== undefined) console.log(`  ${colors.dim}↳${colors.reset}`, typeof data === 'string' ? data : JSON.stringify(data, null, 2));
  },
  success: (tag: string, msg: string, data?: any) => {
    console.log(`${colors.dim}${timestamp()}${colors.reset} ${colors.green}[${tag}]${colors.reset} ✔ ${msg}`);
    if (data !== undefined) console.log(`  ${colors.dim}↳${colors.reset}`, typeof data === 'string' ? data : JSON.stringify(data, null, 2));
  },
  warn: (tag: string, msg: string, data?: any) => {
    console.log(`${colors.dim}${timestamp()}${colors.reset} ${colors.yellow}[${tag}]${colors.reset} ⚠ ${msg}`);
    if (data !== undefined) console.log(`  ${colors.dim}↳${colors.reset}`, typeof data === 'string' ? data : JSON.stringify(data, null, 2));
  },
  error: (tag: string, msg: string, error?: any) => {
    console.error(`${colors.dim}${timestamp()}${colors.reset} ${colors.red}[${tag}]${colors.reset} ✖ ${msg}`);
    if (error) {
      const detail = error instanceof Error ? { message: error.message, stack: error.stack } : error;
      console.error(`  ${colors.dim}↳${colors.reset}`, typeof detail === 'string' ? detail : JSON.stringify(detail, null, 2));
    }
  },
  ws: (msg: string, data?: any) => {
    console.log(`${colors.dim}${timestamp()}${colors.reset} ${colors.magenta}[WS]${colors.reset} ${msg}`);
    if (data !== undefined) console.log(`  ${colors.dim}↳${colors.reset}`, typeof data === 'string' ? data : JSON.stringify(data, null, 2));
  },
  http: (method: string, path: string, status: number, durationMs: number) => {
    const color = status < 400 ? colors.green : status < 500 ? colors.yellow : colors.red;
    console.log(`${colors.dim}${timestamp()}${colors.reset} ${colors.blue}[HTTP]${colors.reset} ${method} ${path} ${color}${status}${colors.reset} ${colors.dim}(${durationMs}ms)${colors.reset}`);
  },
};

const app = express();
const server = http.createServer(app);

// Socket.IO on path /ws as specified in the guide
const io = new Server(server, {
  cors: { origin: '*' },
  path: '/ws',
});

app.use(cors());
app.use(express.json());

// ──────────────────────────────────────────────
// Request Logger Middleware
// ──────────────────────────────────────────────
app.use((req: Request, res: Response, next: NextFunction) => {
  const start = Date.now();
  log.info('HTTP', `→ ${req.method} ${req.originalUrl}`, {
    ip: req.ip,
    userAgent: req.get('user-agent'),
    contentLength: req.get('content-length'),
  });

  res.on('finish', () => {
    const duration = Date.now() - start;
    log.http(req.method, req.originalUrl, res.statusCode, duration);
  });

  next();
});

const JWT_SECRET = process.env.JWT_SECRET || 'fallback_secret';

// ──────────────────────────────────────────────
// Auth Middleware
// ──────────────────────────────────────────────
interface AuthRequest extends Request {
  user?: { id: string };
}

function authenticateToken(req: AuthRequest, res: Response, next: NextFunction): void {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];

  if (!token) {
    log.warn('AUTH', `Token ausente em ${req.method} ${req.originalUrl}`);
    res.sendStatus(401);
    return;
  }

  try {
    const decoded = jwt.verify(token, JWT_SECRET) as { id: string };
    req.user = decoded;
    log.info('AUTH', `Usuário autenticado: ${decoded.id}`);
    next();
  } catch (err) {
    log.warn('AUTH', `Token inválido em ${req.method} ${req.originalUrl}`, err);
    res.sendStatus(403);
    return;
  }
}

// ──────────────────────────────────────────────
// Auth Routes
// ──────────────────────────────────────────────

// POST /api/auth/register
app.post('/api/auth/register', async (req: Request, res: Response): Promise<void> => {
  const { name, email, password } = req.body;
  log.info('REGISTER', `Tentativa de registro: ${email} (nome: ${name})`);

  if (!name || !email || !password) {
    log.warn('REGISTER', 'Campos obrigatórios ausentes', { name: !!name, email: !!email, password: !!password });
    res.status(400).json({ error: 'name, email e password são obrigatórios' });
    return;
  }

  try {
    const hashedPassword = await bcrypt.hash(password, 10);
    log.info('REGISTER', `Senha hash gerada para ${email}`);

    const result = await pool.query(
      `INSERT INTO users (name, email, password_hash)
       VALUES ($1, $2, $3)
       RETURNING id, name, email, couple_id, relationship_type, created_at, updated_at`,
      [name, email, hashedPassword]
    );
    const user = result.rows[0];
    const token = jwt.sign({ id: user.id }, JWT_SECRET);

    log.success('REGISTER', `Usuário criado com sucesso`, { id: user.id, email: user.email });
    res.status(201).json({ user, token });
  } catch (error: any) {
    log.error('REGISTER', `Falha ao registrar ${email}`, error);
    if (error.code === '23505') {
      res.status(409).json({ error: 'Este e-mail já está cadastrado.' });
    } else {
      res.status(500).json({ error: 'Erro interno ao criar conta. Tente novamente mais tarde.' });
    }
  }
});

// POST /api/auth/login
app.post('/api/auth/login', async (req: Request, res: Response): Promise<void> => {
  const { email, password } = req.body;
  log.info('LOGIN', `Tentativa de login: ${email}`);

  try {
    const result = await pool.query(
      'SELECT id, name, email, couple_id, relationship_type, password_hash, created_at, updated_at FROM users WHERE email = $1',
      [email]
    );
    const user = result.rows[0];
    if (!user) {
      log.warn('LOGIN', `Usuário não encontrado: ${email}`);
      res.status(401).json({ error: 'E-mail ou senha incorretos.' });
      return;
    }

    log.info('LOGIN', `Usuário encontrado: ${user.id}, verificando senha...`);
    const match = await bcrypt.compare(password, user.password_hash);
    if (!match) {
      log.warn('LOGIN', `Senha incorreta para ${email}`);
      res.status(401).json({ error: 'E-mail ou senha incorretos.' });
      return;
    }
    const token = jwt.sign({ id: user.id }, JWT_SECRET);

    // Omit password_hash from response
    const { password_hash: _, ...safeUser } = user;
    log.success('LOGIN', `Login bem-sucedido`, { id: user.id, email });
    res.status(200).json({ user: safeUser, token });
  } catch (error: any) {
    log.error('LOGIN', `Erro no login de ${email}`, error);
    res.status(500).json({ error: 'Erro interno ao fazer login. Tente novamente mais tarde.' });
  }
});

// ──────────────────────────────────────────────
// Couples Pairing
// ──────────────────────────────────────────────

// POST /api/couples/pair  (Bearer Token Required)
app.post('/api/couples/pair', authenticateToken, async (req: AuthRequest, res: Response): Promise<void> => {
  const { code } = req.body;
  const userId = req.user!.id;
  log.info('PAIR', `Usuário ${userId} tentando parear com código: ${code}`);

  try {
    await pool.query('BEGIN');

    // Check if code already exists
    let coupleResult = await pool.query('SELECT * FROM couples WHERE code = $1', [code]);
    let couple = coupleResult.rows[0];

    if (couple) {
      log.info('PAIR', `Código ${code} já existe (couple_id: ${couple.id}), user1: ${couple.user1_id}, user2: ${couple.user2_id}`);
      // Join existing couple as user2
      if (!couple.user2_id && couple.user1_id !== userId) {
        await pool.query(
          'UPDATE couples SET user2_id = $1, updated_at = NOW() WHERE id = $2',
          [userId, couple.id]
        );
        await pool.query('UPDATE users SET couple_id = $1, updated_at = NOW() WHERE id = $2', [couple.id, userId]);

        coupleResult = await pool.query('SELECT * FROM couples WHERE id = $1', [couple.id]);
        couple = coupleResult.rows[0];
        log.success('PAIR', `Usuário ${userId} pareado com sucesso ao couple ${couple.id}`);
      } else {
        await pool.query('ROLLBACK');
        log.warn('PAIR', `Casal já completo ou operação inválida para código ${code}`);
        res.status(400).json({ error: 'Este código é inválido ou o casal já está completo.' });
        return;
      }
    } else {
      // Create new couple with this user as user1
      log.info('PAIR', `Criando novo casal com código ${code}, user1: ${userId}`);
      coupleResult = await pool.query(
        'INSERT INTO couples (code, user1_id, start_date) VALUES ($1, $2, NOW()) RETURNING *',
        [code, userId]
      );
      couple = coupleResult.rows[0];
      await pool.query('UPDATE users SET couple_id = $1, updated_at = NOW() WHERE id = $2', [couple.id, userId]);
      log.success('PAIR', `Novo casal criado`, { coupleId: couple.id, code });
    }

    await pool.query('COMMIT');
    res.status(200).json({ couple });
  } catch (error: any) {
    await pool.query('ROLLBACK');
    log.error('PAIR', `Erro ao parear usuário ${userId} com código ${code}`, error);
    if (error.code === '23505') {
      res.status(409).json({ error: 'Este código já está em uso, tente outro.' });
    } else {
      res.status(500).json({ error: 'Não foi possível completar o pareamento. Tente novamente mais tarde.' });
    }
  }
});

// POST /api/users/relationship-type (Bearer Token Required)
app.post('/api/users/relationship-type', authenticateToken, async (req: AuthRequest, res: Response): Promise<void> => {
  const { relationship_type } = req.body;
  const userId = req.user!.id;
  log.info('USER', `Atualizando tipo de relacionamento para ${relationship_type} (usuário: ${userId})`);

  if (!['Monogâmico(a)', 'Bi-amoroso(a)', 'Poliamoroso(a)'].includes(relationship_type)) {
    res.status(400).json({ error: 'Tipo de relacionamento inválido.' });
    return;
  }

  try {
    await pool.query(
      'UPDATE users SET relationship_type = $1, updated_at = NOW() WHERE id = $2',
      [relationship_type, userId]
    );

    log.success('USER', `Tipo de relacionamento atualizado com sucesso`);
    res.status(200).json({
      status: 'success',
      relationship_type,
    });
  } catch (error: any) {
    log.error('USER', `Erro ao atualizar tipo de relacionamento`, error);
    res.status(500).json({ error: 'Erro ao atualizar o tipo de relacionamento.' });
  }
});

// ──────────────────────────────────────────────
// Real-Time Emote Notification
// ──────────────────────────────────────────────

// POST /api/notifications/emote  (Bearer Token Required)
app.post('/api/notifications/emote', authenticateToken, async (req: AuthRequest, res: Response): Promise<void> => {
  const { couple_id, sender_id, sender_name, emote, text, timestamp: ts } = req.body;
  log.info('EMOTE', `Emote recebido de ${sender_name} (${sender_id})`, { couple_id, emote, text });

  try {
    // 1. Insert new entry in chamegos table
    const createdAt = ts || new Date().toISOString();
    await pool.query(
      'INSERT INTO chamegos (couple_id, sender_id, text, type, created_at) VALUES ($1, $2, $3, $4, $5)',
      [couple_id, sender_id, text, emote, createdAt]
    );
    log.info('EMOTE', `Chamego salvo no DB (couple: ${couple_id})`);

    // 2. Find the partner's user ID
    const coupleResult = await pool.query('SELECT user1_id, user2_id FROM couples WHERE id = $1', [couple_id]);
    const couple = coupleResult.rows[0];

    if (couple) {
      const partnerId = couple.user1_id === sender_id ? couple.user2_id : couple.user1_id;
      log.info('EMOTE', `Parceiro identificado: ${partnerId}`);

      // 3. Broadcast real-time emote_received event via WebSocket to the couple room
      io.to(`couple:${couple_id}`).emit('emote_received', {
        event: 'emote_received',
        sender_name,
        emote,
        text,
        timestamp: createdAt,
      });
      log.info('EMOTE', `Evento emote_received emitido para sala couple:${couple_id}`);

      // 4. If FCM configured, send push notification to partner's device
      if (partnerId && process.env.FCM_SERVER_KEY && process.env.FCM_SERVER_KEY !== 'optional_fcm_server_key_for_push_notifications') {
        const partnerResult = await pool.query('SELECT fcm_token FROM users WHERE id = $1', [partnerId]);
        const partnerFcmToken = partnerResult.rows[0]?.fcm_token;
        if (partnerFcmToken) {
          // FCM push notification placeholder
          log.info('FCM', `Push notification enviado para ${partnerId}: ❤️ ${sender_name} te mandou um chamego!`);
        } else {
          log.warn('FCM', `Parceiro ${partnerId} sem fcm_token registrado`);
        }
      }
    } else {
      log.warn('EMOTE', `Casal ${couple_id} não encontrado`);
    }

    log.success('EMOTE', `Emote processado com sucesso`);
    res.status(200).json({
      status: 'success',
      message: 'Notification sent to partner successfully.',
      sent_at: new Date().toISOString(),
    });
  } catch (error: any) {
    log.error('EMOTE', `Erro ao processar emote de ${sender_id}`, error);
    res.status(500).json({ error: 'Não foi possível enviar o chamego no momento.' });
  }
});

// ──────────────────────────────────────────────
// Bi-directional Sync
// ──────────────────────────────────────────────

// POST /api/sync  (Bearer Token Required)
app.post('/api/sync', authenticateToken, async (req: AuthRequest, res: Response): Promise<void> => {
  const { last_synced_at, unsynced } = req.body;
  const userId = req.user!.id;
  log.info('SYNC', `Sync iniciado pelo usuário ${userId}`, { last_synced_at });

  try {
    const userResult = await pool.query('SELECT couple_id FROM users WHERE id = $1', [userId]);
    const coupleId = userResult.rows[0]?.couple_id;
    log.info('SYNC', `Couple ID do usuário: ${coupleId ?? 'nenhum'}`);

    // ── Upsert unsynced data from client ──
    if (coupleId && unsynced) {
      const counts = {
        chamegos: unsynced.chamegos?.length ?? 0,
        outings: unsynced.outings?.length ?? 0,
        memories: unsynced.memories?.length ?? 0,
        gifts: unsynced.gifts?.length ?? 0,
        special_dates: unsynced.special_dates?.length ?? 0,
      };
      log.info('SYNC', `Dados não sincronizados recebidos do cliente`, counts);

      // Chamegos (insert-only, no updates)
      if (unsynced.chamegos && unsynced.chamegos.length > 0) {
        for (const c of unsynced.chamegos) {
          await pool.query(
            `INSERT INTO chamegos (id, couple_id, sender_id, text, type, created_at)
             VALUES ($1, $2, $3, $4, $5, $6)
             ON CONFLICT (id) DO NOTHING`,
            [c.id, c.couple_id, c.sender_id, c.text, c.type, c.created_at]
          );
        }
        log.info('SYNC', `${counts.chamegos} chamegos processados`);
      }

      // Outings (upsert with update on conflict)
      if (unsynced.outings && unsynced.outings.length > 0) {
        for (const o of unsynced.outings) {
          await pool.query(
            `INSERT INTO outings (id, couple_id, title, location, date, category, cost, status, rating, notify_option, created_at, updated_at, is_deleted)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
             ON CONFLICT (id) DO UPDATE SET
               title = EXCLUDED.title,
               location = EXCLUDED.location,
               date = EXCLUDED.date,
               category = EXCLUDED.category,
               cost = EXCLUDED.cost,
               status = EXCLUDED.status,
               rating = EXCLUDED.rating,
               notify_option = EXCLUDED.notify_option,
               updated_at = EXCLUDED.updated_at,
               is_deleted = EXCLUDED.is_deleted`,
            [o.id, o.couple_id, o.title, o.location, o.date, o.category, o.cost, o.status, o.rating, o.notify_option, o.created_at, o.updated_at, o.is_deleted ?? false]
          );
        }
        log.info('SYNC', `${counts.outings} outings processados`);
      }

      // Memories (upsert with update on conflict)
      if (unsynced.memories && unsynced.memories.length > 0) {
        for (const m of unsynced.memories) {
          await pool.query(
            `INSERT INTO memories (id, couple_id, title, date, description, mood, photo_urls, created_at, updated_at, is_deleted)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
             ON CONFLICT (id) DO UPDATE SET
               title = EXCLUDED.title,
               date = EXCLUDED.date,
               description = EXCLUDED.description,
               mood = EXCLUDED.mood,
               photo_urls = EXCLUDED.photo_urls,
               updated_at = EXCLUDED.updated_at,
               is_deleted = EXCLUDED.is_deleted`,
            [m.id, m.couple_id, m.title, m.date, m.description, m.mood, JSON.stringify(m.photo_urls ?? []), m.created_at, m.updated_at, m.is_deleted ?? false]
          );
        }
        log.info('SYNC', `${counts.memories} memories processadas`);
      }

      // Gifts (upsert with update on conflict)
      if (unsynced.gifts && unsynced.gifts.length > 0) {
        for (const g of unsynced.gifts) {
          await pool.query(
            `INSERT INTO gifts (id, couple_id, creator_id, type, title, store_url, price, occasion, created_at, updated_at, is_deleted)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
             ON CONFLICT (id) DO UPDATE SET
               type = EXCLUDED.type,
               title = EXCLUDED.title,
               store_url = EXCLUDED.store_url,
               price = EXCLUDED.price,
               occasion = EXCLUDED.occasion,
               updated_at = EXCLUDED.updated_at,
               is_deleted = EXCLUDED.is_deleted`,
            [g.id, g.couple_id, g.creator_id, g.type, g.title, g.store_url, g.price, g.occasion, g.created_at, g.updated_at, g.is_deleted ?? false]
          );
        }
        log.info('SYNC', `${counts.gifts} gifts processados`);
      }

      // Special Dates (upsert with update on conflict)
      if (unsynced.special_dates && unsynced.special_dates.length > 0) {
        for (const sd of unsynced.special_dates) {
          await pool.query(
            `INSERT INTO special_dates (id, couple_id, title, date, repeat_option, notify_option, created_at, updated_at, is_deleted)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
             ON CONFLICT (id) DO UPDATE SET
               title = EXCLUDED.title,
               date = EXCLUDED.date,
               repeat_option = EXCLUDED.repeat_option,
               notify_option = EXCLUDED.notify_option,
               updated_at = EXCLUDED.updated_at,
               is_deleted = EXCLUDED.is_deleted`,
            [sd.id, sd.couple_id, sd.title, sd.date, sd.repeat_option, sd.notify_option, sd.created_at, sd.updated_at, sd.is_deleted ?? false]
          );
        }
        log.info('SYNC', `${counts.special_dates} special_dates processados`);
      }
    } else if (!coupleId) {
      log.warn('SYNC', `Usuário ${userId} não está em nenhum casal, pulando upsert`);
    }

    // ── Fetch remote updates since last sync ──
    const remote_updates: Record<string, any> = {
      couple: null,
      users: [],
      chamegos: [],
      outings: [],
      memories: [],
      gifts: [],
      special_dates: [],
    };

    if (coupleId) {
      const chamegos = await pool.query(
        'SELECT * FROM chamegos WHERE couple_id = $1 AND created_at > $2',
        [coupleId, last_synced_at]
      );
      remote_updates.chamegos = chamegos.rows;

      const outings = await pool.query(
        'SELECT * FROM outings WHERE couple_id = $1 AND updated_at > $2',
        [coupleId, last_synced_at]
      );
      remote_updates.outings = outings.rows;

      const memories = await pool.query(
        'SELECT * FROM memories WHERE couple_id = $1 AND updated_at > $2',
        [coupleId, last_synced_at]
      );
      remote_updates.memories = memories.rows;

      const gifts = await pool.query(
        'SELECT * FROM gifts WHERE couple_id = $1 AND updated_at > $2',
        [coupleId, last_synced_at]
      );
      remote_updates.gifts = gifts.rows;

      const special_dates = await pool.query(
        'SELECT * FROM special_dates WHERE couple_id = $1 AND updated_at > $2',
        [coupleId, last_synced_at]
      );
      remote_updates.special_dates = special_dates.rows;

      const coupleResult = await pool.query(
        'SELECT * FROM couples WHERE id = $1',
        [coupleId]
      );
      remote_updates.couple = coupleResult.rows[0];

      const usersResult = await pool.query(
        'SELECT id, name, email, couple_id, relationship_type, created_at, updated_at FROM users WHERE couple_id = $1',
        [coupleId]
      );
      remote_updates.users = usersResult.rows;

      const remoteCounts = {
        chamegos: remote_updates.chamegos.length,
        outings: remote_updates.outings.length,
        memories: remote_updates.memories.length,
        gifts: remote_updates.gifts.length,
        special_dates: remote_updates.special_dates.length,
      };
      log.info('SYNC', `Atualizações remotas encontradas`, remoteCounts);
    }

    log.success('SYNC', `Sync concluído para usuário ${userId}`);
    res.status(200).json({
      synced_at: new Date().toISOString(),
      status: 'success',
      remote_updates,
    });
  } catch (error: any) {
    log.error('SYNC', `Erro no sync do usuário ${userId}`, error);
    res.status(500).json({ error: 'Houve um erro ao sincronizar os dados. Tentaremos novamente em breve.' });
  }
});

// ──────────────────────────────────────────────
// WebSocket Gateway  (ws://<host>:3000/ws)
// ──────────────────────────────────────────────
io.on('connection', (socket: Socket) => {
  const token = socket.handshake.query.token as string;
  let userId: string;

  log.ws(`Nova conexão (socket: ${socket.id}, ip: ${socket.handshake.address})`);

  // 1. Authenticate via query parameter token
  try {
    const decoded = jwt.verify(token, JWT_SECRET) as { id: string };
    userId = decoded.id;
    log.ws(`Usuário ${userId} autenticado via WebSocket`);
  } catch (err) {
    log.warn('WS', `Autenticação falhou, desconectando socket ${socket.id}`, err);
    socket.disconnect();
    return;
  }

  // 2. Auto-join couple room based on user's couple_id
  (async () => {
    try {
      const result = await pool.query('SELECT couple_id FROM users WHERE id = $1', [userId]);
      const coupleId = result.rows[0]?.couple_id;
      if (coupleId) {
        socket.join(`couple:${coupleId}`);
        log.ws(`Usuário ${userId} entrou na sala couple:${coupleId}`);
      } else {
        log.ws(`Usuário ${userId} não está em nenhum casal, sem sala para entrar`);
      }
    } catch (err) {
      log.error('WS', `Erro ao entrar na sala do casal para usuário ${userId}`, err);
    }
  })();

  // 3. Handle send_emote event
  socket.on('send_emote', (data: { couple_id: string; sender_name: string; emote: string; text: string }) => {
    const { couple_id, sender_name, emote, text } = data;
    log.ws(`Emote recebido via WS de ${sender_name}`, { couple_id, emote, text });

    // 4. Broadcast receive_emote to all OTHER sockets in the couple room
    socket.to(`couple:${couple_id}`).emit('receive_emote', {
      event: 'receive_emote',
      sender_name,
      emote,
      text,
      timestamp: new Date().toISOString(),
    });
    log.ws(`Emote retransmitido para sala couple:${couple_id}`);
  });

  socket.on('disconnect', (reason: string) => {
    log.ws(`Usuário ${userId} desconectado (motivo: ${reason})`);
  });
});

// ──────────────────────────────────────────────
// Start Server
// ──────────────────────────────────────────────
const PORT = process.env.PORT || 3000;

server.listen(PORT, async () => {
  log.success('SERVER', `Chamego server rodando em http://localhost:${PORT}`);
  log.info('SERVER', `Ambiente: DATABASE_URL=${process.env.DATABASE_URL ? '✔ definido' : '✖ ausente'}, JWT_SECRET=${process.env.JWT_SECRET ? '✔ definido' : '✖ ausente'}`);
  await initDb();
});
