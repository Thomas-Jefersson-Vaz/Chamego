import express, { Request, Response, NextFunction } from 'express';
import http from 'http';
import { Server, Socket } from 'socket.io';
import cors from 'cors';
import dotenv from 'dotenv';
import bcrypt from 'bcrypt';
import jwt from 'jsonwebtoken';
import { pool, initDb } from './db';
import { registerCrudRoutes } from './crud';
import { initFcm, sendPushToUser } from './fcm';

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
// System & Health Routes
// ──────────────────────────────────────────────
app.get(['/health', '/api/health'], (_req: Request, res: Response): void => {
  res.status(200).json({
    status: 'ok',
    uptime: process.uptime(),
    timestamp: new Date().toISOString(),
  });
});

// ──────────────────────────────────────────────
// Auth & Profile Routes
// ──────────────────────────────────────────────

// GET /api/users/me (Bearer Token Required)
app.get('/api/users/me', authenticateToken, async (req: AuthRequest, res: Response): Promise<void> => {
  const userId = req.user!.id;
  try {
    const result = await pool.query(
      'SELECT id, name, email, couple_id, relationship_type, created_at, updated_at FROM users WHERE id = $1',
      [userId]
    );
    const user = result.rows[0];
    if (!user) {
      res.status(404).json({ error: 'Usuário não encontrado.', message: 'Usuário não encontrado.' });
      return;
    }
    res.status(200).json({ user });
  } catch (error: any) {
    log.error('USER', `Erro ao buscar dados do usuário ${userId}`, error);
    res.status(500).json({ error: 'Erro interno ao obter perfil.', message: 'Erro interno ao obter perfil.' });
  }
});

// POST /api/auth/register
app.post('/api/auth/register', async (req: Request, res: Response): Promise<void> => {
  const { name, email, password } = req.body;
  log.info('REGISTER', `Tentativa de registro: ${email} (nome: ${name})`);

  if (!name || !email || !password) {
    log.warn('REGISTER', 'Campos obrigatórios ausentes', { name: !!name, email: !!email, password: !!password });
    res.status(400).json({ error: 'name, email e password são obrigatórios', message: 'name, email e password são obrigatórios' });
    return;
  }

  const cleanEmail = email.trim().toLowerCase();
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  if (!emailRegex.test(cleanEmail)) {
    res.status(400).json({ error: 'Formato de e-mail inválido.', message: 'Formato de e-mail inválido.' });
    return;
  }

  if (password.length < 6) {
    res.status(400).json({ error: 'A senha deve ter pelo menos 6 caracteres.', message: 'A senha deve ter pelo menos 6 caracteres.' });
    return;
  }

  try {
    const hashedPassword = await bcrypt.hash(password, 10);
    log.info('REGISTER', `Senha hash gerada para ${cleanEmail}`);

    const result = await pool.query(
      `INSERT INTO users (name, email, password_hash)
       VALUES ($1, $2, $3)
       RETURNING id, name, email, couple_id, relationship_type, created_at, updated_at`,
      [name.trim(), cleanEmail, hashedPassword]
    );
    const user = result.rows[0];
    const token = jwt.sign({ id: user.id }, JWT_SECRET, { expiresIn: '30d' });

    log.success('REGISTER', `Usuário criado com sucesso`, { id: user.id, email: user.email });
    res.status(201).json({ user, token });
  } catch (error: any) {
    log.error('REGISTER', `Falha ao registrar ${cleanEmail}`, error);
    if (error.code === '23505') {
      res.status(409).json({ error: 'Este e-mail já está cadastrado.', message: 'Este e-mail já está cadastrado.' });
    } else {
      res.status(500).json({ error: 'Erro interno ao criar conta. Tente novamente mais tarde.', message: 'Erro interno ao criar conta. Tente novamente mais tarde.' });
    }
  }
});

// POST /api/auth/login
app.post('/api/auth/login', async (req: Request, res: Response): Promise<void> => {
  const { email, password } = req.body;
  const cleanEmail = (email || '').trim().toLowerCase();
  log.info('LOGIN', `Tentativa de login: ${cleanEmail}`);

  if (!cleanEmail || !password) {
    res.status(400).json({ error: 'E-mail e senha são obrigatórios.', message: 'E-mail e senha são obrigatórios.' });
    return;
  }

  try {
    const result = await pool.query(
      'SELECT id, name, email, couple_id, relationship_type, password_hash, created_at, updated_at FROM users WHERE email = $1',
      [cleanEmail]
    );
    const user = result.rows[0];
    if (!user) {
      log.warn('LOGIN', `Usuário não encontrado: ${cleanEmail}`);
      res.status(401).json({ error: 'E-mail ou senha incorretos.', message: 'E-mail ou senha incorretos.' });
      return;
    }

    log.info('LOGIN', `Usuário encontrado: ${user.id}, verificando senha...`);
    const match = await bcrypt.compare(password, user.password_hash);
    if (!match) {
      log.warn('LOGIN', `Senha incorreta para ${cleanEmail}`);
      res.status(401).json({ error: 'E-mail ou senha incorretos.', message: 'E-mail ou senha incorretos.' });
      return;
    }
    const token = jwt.sign({ id: user.id }, JWT_SECRET, { expiresIn: '30d' });

    // Omit password_hash from response
    const { password_hash: _, ...safeUser } = user;
    log.success('LOGIN', `Login bem-sucedido`, { id: user.id, email: cleanEmail });
    res.status(200).json({ user: safeUser, token });
  } catch (error: any) {
    log.error('LOGIN', `Erro no login de ${cleanEmail}`, error);
    res.status(500).json({ error: 'Erro interno ao fazer login. Tente novamente mais tarde.', message: 'Erro interno ao fazer login. Tente novamente mais tarde.' });
  }
});

// ──────────────────────────────────────────────
// Couples Pairing & Profile
// ──────────────────────────────────────────────

// GET /api/couples/me (Bearer Token Required)
app.get('/api/couples/me', authenticateToken, async (req: AuthRequest, res: Response): Promise<void> => {
  const userId = req.user!.id;
  try {
    const userRes = await pool.query('SELECT couple_id FROM users WHERE id = $1', [userId]);
    const coupleId = userRes.rows[0]?.couple_id;

    if (!coupleId) {
      res.status(200).json({ couple: null, partner: null });
      return;
    }

    const coupleRes = await pool.query('SELECT * FROM couples WHERE id = $1', [coupleId]);
    const couple = coupleRes.rows[0];

    if (!couple) {
      res.status(200).json({ couple: null, partner: null });
      return;
    }

    const partnerId = couple.user1_id === userId ? couple.user2_id : couple.user1_id;
    let partnerName: string | null = null;
    let partnerUser: any = null;

    if (partnerId) {
      const partnerRes = await pool.query(
        'SELECT id, name, email, relationship_type, created_at FROM users WHERE id = $1',
        [partnerId]
      );
      partnerUser = partnerRes.rows[0] || null;
      partnerName = partnerUser?.name || null;
    }

    res.status(200).json({
      couple: {
        ...couple,
        partner_name: partnerName,
      },
      partner: partnerUser,
    });
  } catch (error: any) {
    log.error('COUPLE', `Erro ao buscar casal do usuário ${userId}`, error);
    res.status(500).json({
      error: 'Erro ao obter dados do casal.',
      message: 'Erro ao obter dados do casal.',
    });
  }
});

// POST /api/couples/pair  (Bearer Token Required)
app.post('/api/couples/pair', authenticateToken, async (req: AuthRequest, res: Response): Promise<void> => {
  const { code } = req.body;
  const userId = req.user!.id;
  log.info('PAIR', `Usuário ${userId} tentando parear com código: ${code}`);

  if (!code || typeof code !== 'string') {
    res.status(400).json({
      error: 'Código de pareamento obrigatório.',
      message: 'Código de pareamento obrigatório.',
    });
    return;
  }

  const cleanCode = code.trim().toUpperCase();

  try {
    await pool.query('BEGIN');

    // Buscar nome do usuário atual
    const currentUserRes = await pool.query('SELECT name FROM users WHERE id = $1', [userId]);
    const currentUserName = currentUserRes.rows[0]?.name || 'Amor';

    // Verificar se o código já existe
    let coupleResult = await pool.query('SELECT * FROM couples WHERE code = $1', [cleanCode]);
    let couple = coupleResult.rows[0];

    if (couple) {
      log.info('PAIR', `Código ${cleanCode} já existe (couple_id: ${couple.id}), user1: ${couple.user1_id}, user2: ${couple.user2_id}`);

      // Se o usuário já faz parte deste casal, retornar dados com o partner_name resolvido
      if (couple.user1_id === userId || couple.user2_id === userId) {
        await pool.query('COMMIT');
        const partnerId = couple.user1_id === userId ? couple.user2_id : couple.user1_id;
        let partnerName: string | null = null;
        if (partnerId) {
          const partnerRes = await pool.query('SELECT name FROM users WHERE id = $1', [partnerId]);
          partnerName = partnerRes.rows[0]?.name || null;
        }
        res.status(200).json({
          couple: {
            ...couple,
            partner_name: partnerName,
          },
        });
        return;
      }

      // Juntar-se ao casal existente como user2
      if (!couple.user2_id) {
        await pool.query(
          'UPDATE couples SET user2_id = $1, updated_at = NOW() WHERE id = $2',
          [userId, couple.id]
        );
        await pool.query('UPDATE users SET couple_id = $1, updated_at = NOW() WHERE id = $2', [couple.id, userId]);

        coupleResult = await pool.query('SELECT * FROM couples WHERE id = $1', [couple.id]);
        couple = coupleResult.rows[0];

        // Obter nome do user1 para passar ao user2 como partner_name
        const user1Res = await pool.query('SELECT name FROM users WHERE id = $1', [couple.user1_id]);
        const user1Name = user1Res.rows[0]?.name || 'Amor';

        await pool.query('COMMIT');
        log.success('PAIR', `Usuário ${userId} pareado com sucesso ao couple ${couple.id}`);

        // Notificar via WebSocket na sala do casal e no canal individual do user1, e juntar sockets à sala do casal
        const roomName = `couple:${couple.id}`;
        io.in(`user:${couple.user1_id}`).socketsJoin(roomName);
        io.in(`user:${userId}`).socketsJoin(roomName);

        io.to(roomName).emit('partner_joined', {
          couple_id: couple.id,
          partner_id: userId,
          partner_name: currentUserName,
        });
        io.to(`user:${couple.user1_id}`).emit('partner_joined', {
          couple_id: couple.id,
          partner_id: userId,
          partner_name: currentUserName,
        });

        res.status(200).json({
          couple: {
            ...couple,
            partner_name: user1Name,
          },
        });
        return;
      } else {
        await pool.query('ROLLBACK');
        log.warn('PAIR', `Casal já completo ou operação inválida para código ${cleanCode}`);
        res.status(400).json({
          error: 'Este código é inválido ou o casal já está completo.',
          message: 'Este código é inválido ou o casal já está completo.',
        });
        return;
      }
    } else {
      // Criar novo casal com este usuário como user1
      log.info('PAIR', `Criando novo casal com código ${cleanCode}, user1: ${userId}`);
      coupleResult = await pool.query(
        'INSERT INTO couples (code, user1_id, start_date) VALUES ($1, $2, NOW()) RETURNING *',
        [cleanCode, userId]
      );
      couple = coupleResult.rows[0];
      await pool.query('UPDATE users SET couple_id = $1, updated_at = NOW() WHERE id = $2', [couple.id, userId]);
      await pool.query('COMMIT');
      log.success('PAIR', `Novo casal criado`, { coupleId: couple.id, code: cleanCode });

      res.status(200).json({
        couple: {
          ...couple,
          partner_name: null,
        },
      });
      return;
    }
  } catch (error: any) {
    await pool.query('ROLLBACK');
    log.error('PAIR', `Erro ao parear usuário ${userId} com código ${cleanCode}`, error);
    if (error.code === '23505') {
      res.status(409).json({
        error: 'Este código já está em uso, tente outro.',
        message: 'Este código já está em uso, tente outro.',
      });
    } else {
      res.status(500).json({
        error: 'Não foi possível completar o pareamento. Tente novamente mais tarde.',
        message: 'Não foi possível completar o pareamento. Tente novamente mais tarde.',
      });
    }
  }
});

// POST /api/couples/start-date (Bearer Token Required)
app.post('/api/couples/start-date', authenticateToken, async (req: AuthRequest, res: Response): Promise<void> => {
  const { start_date } = req.body;
  const userId = req.user!.id;
  log.info('COUPLE', `Atualizando data de início do casal pelo usuário ${userId}`, { start_date });

  if (!start_date) {
    res.status(400).json({ error: 'start_date é obrigatório.', message: 'start_date é obrigatório.' });
    return;
  }

  try {
    const userRes = await pool.query('SELECT couple_id FROM users WHERE id = $1', [userId]);
    const coupleId = userRes.rows[0]?.couple_id;

    if (!coupleId) {
      res.status(400).json({ error: 'Usuário não possui casal associado.', message: 'Usuário não possui casal associado.' });
      return;
    }

    await pool.query(
      'UPDATE couples SET start_date = $1, updated_at = NOW() WHERE id = $2',
      [start_date, coupleId]
    );

    log.success('COUPLE', `Data de início do casal atualizada com sucesso para ${start_date}`);
    res.status(200).json({ status: 'success', start_date });
  } catch (error: any) {
    log.error('COUPLE', 'Erro ao atualizar data de início', error);
    res.status(500).json({ error: 'Erro ao atualizar data de início do casal.', message: 'Erro ao atualizar data de início do casal.' });
  }
});

// Handler compartilhado para atualização de tipo de relacionamento (suporta /api/users/... e /api/couples/...)
const handleRelationshipType = async (req: AuthRequest, res: Response): Promise<void> => {
  const { relationship_type } = req.body;
  const userId = req.user!.id;
  log.info('USER', `Atualizando tipo de relacionamento para ${relationship_type} (usuário: ${userId})`);

  if (!['Monogâmico(a)', 'Bi-amoroso(a)', 'Poliamoroso(a)'].includes(relationship_type)) {
    res.status(400).json({
      error: 'Tipo de relacionamento inválido.',
      message: 'Tipo de relacionamento inválido.',
    });
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
    res.status(500).json({
      error: 'Erro ao atualizar o tipo de relacionamento.',
      message: 'Erro ao atualizar o tipo de relacionamento.',
    });
  }
};

app.post('/api/users/relationship-type', authenticateToken, handleRelationshipType);
app.post('/api/couples/relationship-type', authenticateToken, handleRelationshipType);

// ──────────────────────────────────────────────
// Real-Time Emote Notification
// ──────────────────────────────────────────────

// POST /api/users/fcm-token  (Bearer Token Required)
// Registra/atualiza o token FCM do dispositivo do usuário logado.
app.post('/api/users/fcm-token', authenticateToken, async (req: AuthRequest, res: Response): Promise<void> => {
  const { fcm_token } = req.body ?? {};
  const userId = req.user!.id;

  if (!fcm_token || typeof fcm_token !== 'string' || fcm_token.length > 512) {
    res.status(400).json({ error: 'fcm_token inválido.', message: 'fcm_token inválido.' });
    return;
  }

  try {
    // Um token pertence a um único usuário (evita push para a conta errada após troca de login no mesmo aparelho)
    await pool.query('UPDATE users SET fcm_token = NULL WHERE fcm_token = $1 AND id <> $2', [fcm_token, userId]);
    await pool.query('UPDATE users SET fcm_token = $1, updated_at = NOW() WHERE id = $2', [fcm_token, userId]);
    log.success('FCM', `Token FCM registrado para o usuário ${userId}`);
    res.status(200).json({ status: 'success' });
  } catch (error: any) {
    log.error('FCM', `Erro ao salvar token FCM do usuário ${userId}`, error);
    res.status(500).json({ error: 'Erro ao salvar o token de notificação.', message: 'Erro ao salvar o token de notificação.' });
  }
});

// DELETE /api/users/fcm-token  (Bearer Token Required) — chamar no logout
app.delete('/api/users/fcm-token', authenticateToken, async (req: AuthRequest, res: Response): Promise<void> => {
  const userId = req.user!.id;
  try {
    await pool.query('UPDATE users SET fcm_token = NULL, updated_at = NOW() WHERE id = $1', [userId]);
    res.status(200).json({ status: 'success' });
  } catch (error: any) {
    log.error('FCM', `Erro ao remover token FCM do usuário ${userId}`, error);
    res.status(500).json({ error: 'Erro ao remover o token de notificação.', message: 'Erro ao remover o token de notificação.' });
  }
});

// POST /api/notifications/emote  (Bearer Token Required)
app.post('/api/notifications/emote', authenticateToken, async (req: AuthRequest, res: Response): Promise<void> => {
  const { couple_id, sender_name, emote, text, timestamp: ts } = req.body ?? {};
  const userId = req.user!.id;
  log.info('EMOTE', `Emote recebido de ${sender_name} (${userId})`, { couple_id, emote, text });

  if (!couple_id || !emote) {
    res.status(400).json({ error: 'couple_id e emote são obrigatórios.', message: 'couple_id e emote são obrigatórios.' });
    return;
  }

  try {
    // O remetente é sempre o usuário autenticado, e precisa pertencer ao casal informado
    const me = await pool.query('SELECT couple_id, name FROM users WHERE id = $1', [userId]);
    if (!me.rows[0]?.couple_id || me.rows[0].couple_id !== couple_id) {
      res.status(403).json({ error: 'Você não pertence a este casal.', message: 'Você não pertence a este casal.' });
      return;
    }
    const senderName: string = sender_name || me.rows[0].name || 'Seu amor';
    const messageText: string = text || emote;

    // 1. Salva o chamego
    const createdAt = ts || new Date().toISOString();
    await pool.query(
      'INSERT INTO chamegos (couple_id, sender_id, text, type, created_at) VALUES ($1, $2, $3, $4, $5)',
      [couple_id, userId, messageText, emote, createdAt]
    );

    // 2. Descobre o parceiro
    const coupleResult = await pool.query('SELECT user1_id, user2_id FROM couples WHERE id = $1', [couple_id]);
    const couple = coupleResult.rows[0];
    const partnerId: string | null = couple ? (couple.user1_id === userId ? couple.user2_id : couple.user1_id) : null;

    // 3. Broadcast em tempo real para a sala do casal
    io.to(`couple:${couple_id}`).emit('receive_emote', {
      event: 'receive_emote',
      id: req.body.id || undefined,
      couple_id,
      sender_id: userId,
      sender_name: senderName,
      emote,
      text: messageText,
      timestamp: createdAt,
    });

    // 4. Push FCM (best-effort: falha no push não derruba a requisição)
    let push: { sent: boolean; reason?: string } = { sent: false, reason: 'no_partner' };
    if (partnerId) {
      push = await sendPushToUser(pool, partnerId, {
        title: `❤️ ${senderName} te mandou um chamego!`,
        body: messageText,
        data: {
          type: String(emote),
          couple_id: String(couple_id),
          sender_id: userId,
          sender_name: String(senderName),
          text: String(messageText),
          timestamp: String(createdAt),
        },
      });
      log.info('FCM', `Push para ${partnerId}: ${push.sent ? 'enviado' : `não enviado (${push.reason})`}`);
    }

    log.success('EMOTE', `Emote processado com sucesso`);
    res.status(200).json({
      status: 'success',
      message: 'Emote processed.',
      push_sent: push.sent,
      sent_at: new Date().toISOString(),
    });
  } catch (error: any) {
    log.error('EMOTE', `Erro ao processar emote de ${userId}`, error);
    res.status(500).json({ error: 'Não foi possível enviar o chamego no momento.', message: 'Não foi possível enviar o chamego no momento.' });
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
    const syncSince = (last_synced_at && typeof last_synced_at === 'string' && last_synced_at.trim().length > 0)
      ? last_synced_at
      : '1970-01-01T00:00:00.000Z';

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
      // Upsert start_date if sent in unsynced couple
      if (unsynced?.couple?.start_date) {
        await pool.query(
          'UPDATE couples SET start_date = $1, updated_at = NOW() WHERE id = $2',
          [unsynced.couple.start_date, coupleId]
        );
      }

      const chamegos = await pool.query(
        'SELECT * FROM chamegos WHERE couple_id = $1 AND created_at > $2',
        [coupleId, syncSince]
      );
      remote_updates.chamegos = chamegos.rows;

      const outings = await pool.query(
        'SELECT * FROM outings WHERE couple_id = $1 AND updated_at > $2',
        [coupleId, syncSince]
      );
      remote_updates.outings = outings.rows;

      const memories = await pool.query(
        'SELECT * FROM memories WHERE couple_id = $1 AND updated_at > $2',
        [coupleId, syncSince]
      );
      remote_updates.memories = memories.rows;

      const gifts = await pool.query(
        'SELECT * FROM gifts WHERE couple_id = $1 AND updated_at > $2',
        [coupleId, syncSince]
      );
      remote_updates.gifts = gifts.rows;

      const special_dates = await pool.query(
        'SELECT * FROM special_dates WHERE couple_id = $1 AND updated_at > $2',
        [coupleId, syncSince]
      );
      remote_updates.special_dates = special_dates.rows;

      const coupleResult = await pool.query(
        'SELECT * FROM couples WHERE id = $1',
        [coupleId]
      );
      if (coupleResult.rows.length > 0) {
        const c = coupleResult.rows[0];
        const partnerId = c.user1_id === userId ? c.user2_id : c.user1_id;
        let partnerName: string | null = null;
        if (partnerId) {
          const partnerRes = await pool.query('SELECT name FROM users WHERE id = $1', [partnerId]);
          partnerName = partnerRes.rows[0]?.name || null;
        }
        remote_updates.couple = {
          ...c,
          partner_name: partnerName,
        };
      }

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
    res.status(500).json({
      error: 'Houve um erro ao sincronizar os dados. Tentaremos novamente em breve.',
      message: 'Houve um erro ao sincronizar os dados. Tentaremos novamente em breve.',
    });
  }
});

// ──────────────────────────────────────────────
// REST CRUD: outings, memories, gifts, special-dates
// ──────────────────────────────────────────────
registerCrudRoutes(app, pool, authenticateToken as any);

// ──────────────────────────────────────────────
// REST CRUD: outings, memories, gifts, special-dates
// ──────────────────────────────────────────────
registerCrudRoutes(app, pool, authenticateToken as any);

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
    socket.join(`user:${userId}`);
    log.ws(`Usuário ${userId} autenticado via WebSocket e registrado na sala user:${userId}`);
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

  // 3. Handle explicit join_couple event
  socket.on('join_couple', (data: { couple_id: string }) => {
    if (data?.couple_id) {
      socket.join(`couple:${data.couple_id}`);
      log.ws(`Socket ${socket.id} (user ${userId}) entrou manualmente na sala couple:${data.couple_id}`);
    }
  });

  // 4. Handle send_emote event
  socket.on('send_emote', (data: { id?: string; couple_id: string; sender_id?: string; sender_name: string; emote: string; text: string }) => {
    const { id, couple_id, sender_id, sender_name, emote, text } = data;
    const effectiveSenderId = sender_id || userId;
    log.ws(`Emote recebido via WS de ${sender_name}`, { couple_id, sender_id: effectiveSenderId, emote, text });

    // Broadcast receive_emote to all OTHER sockets in the couple room
    socket.to(`couple:${couple_id}`).emit('receive_emote', {
      event: 'receive_emote',
      id: id || undefined,
      couple_id,
      sender_id: effectiveSenderId,
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
// Start Server & Graceful Shutdown
// ──────────────────────────────────────────────
const PORT = process.env.PORT || 3000;

server.listen(PORT, async () => {
  log.success('SERVER', `Chamego server rodando em http://localhost:${PORT}`);
  log.info('SERVER', `Ambiente: DATABASE_URL=${process.env.DATABASE_URL ? '✔ definido' : '✖ ausente'}, JWT_SECRET=${process.env.JWT_SECRET ? '✔ definido' : '✖ ausente'}`);
  await initDb();
  initFcm();
});

const gracefulShutdown = async (signal: string) => {
  log.info('SERVER', `Sinal de encerramento recebido (${signal}). Finalizando conexões...`);
  server.close(async () => {
    try {
      await pool.end();
      log.success('SERVER', 'Pool do banco de dados e servidor HTTP finalizados com sucesso.');
    } catch (err) {
      log.error('SERVER', 'Erro ao fechar conexões do banco de dados', err);
    }
    process.exit(0);
  });
};

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));
