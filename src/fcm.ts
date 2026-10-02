import { initializeApp, cert, App, ServiceAccount } from 'firebase-admin/app';
import { getMessaging } from 'firebase-admin/messaging';
import fs from 'fs';
import { Pool } from 'pg';

/**
 * FCM (HTTP v1) via firebase-admin.
 *
 * Credentials (one of):
 *   FIREBASE_SERVICE_ACCOUNT_JSON   -> the service account JSON content (raw JSON or base64)
 *   FIREBASE_SERVICE_ACCOUNT_PATH   -> path to the service account JSON file
 *
 * If neither is set, push is disabled (the rest of the server keeps working).
 */

let app: App | null = null;
let initTried = false;

function loadServiceAccount(): ServiceAccount | null {
  const raw = process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
  if (raw && raw.trim()) {
    const txt = raw.trim().startsWith('{') ? raw : Buffer.from(raw, 'base64').toString('utf8');
    return JSON.parse(txt);
  }
  const p = process.env.FIREBASE_SERVICE_ACCOUNT_PATH;
  if (p && fs.existsSync(p)) {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  }
  return null;
}

export function initFcm(): boolean {
  if (initTried) return app !== null;
  initTried = true;
  try {
    const sa = loadServiceAccount();
    if (!sa) {
      console.warn('[FCM] Credenciais do Firebase não configuradas — push notifications desativadas.');
      return false;
    }
    app = initializeApp({ credential: cert(sa) });
    console.log(`[FCM] Firebase Admin inicializado (project: ${(sa as any).project_id ?? 'n/a'}).`);
    return true;
  } catch (err) {
    console.error('[FCM] Falha ao inicializar Firebase Admin — push desativado.');
    app = null;
    return false;
  }
}

export function isFcmEnabled(): boolean {
  return initFcm();
}

export interface PushPayload {
  title: string;
  body: string;
  /** FCM data values must be strings. */
  data?: Record<string, string>;
}

/**
 * Sends a push to every device token stored for the user.
 * Never throws: push is best-effort and must not break the main request.
 * Tokens reported as invalid/unregistered by FCM are cleared from the DB.
 */
export async function sendPushToUser(
  pool: Pool,
  userId: string,
  payload: PushPayload
): Promise<{ sent: boolean; reason?: string }> {
  if (!isFcmEnabled() || !app) return { sent: false, reason: 'fcm_disabled' };

  let attemptedToken: string | null = null;
  try {
    const r = await pool.query('SELECT fcm_token FROM users WHERE id = $1', [userId]);
    const token: string | null = r.rows[0]?.fcm_token ?? null;
    attemptedToken = token;
    if (!token) return { sent: false, reason: 'no_token' };

    await getMessaging(app).send({
      token,
      notification: { title: payload.title, body: payload.body },
      data: payload.data ?? {},
      android: {
        priority: 'high',
        notification: { sound: 'default', channelId: 'chamegos_emotes_channel' },
      },
      apns: {
        headers: { 'apns-priority': '10' },
        payload: { aps: { sound: 'default' } },
      },
    });
    return { sent: true };
  } catch (err: any) {
    const code: string | undefined = err?.code;
    if (
      code === 'messaging/registration-token-not-registered' ||
      code === 'messaging/invalid-registration-token'
    ) {
      await pool.query('UPDATE users SET fcm_token = NULL, updated_at = NOW() WHERE id = $1 AND fcm_token = $2', [userId, attemptedToken]).catch(() => {});
      console.warn(`[FCM] Token inválido/expirado removido do usuário ${userId} (${code})`);
      return { sent: false, reason: 'token_invalid' };
    }
    console.error(JSON.stringify({event:'push_delivery_error',user_id:userId,code:code ?? 'unknown'}));
    return { sent: false, reason: 'send_error' };
  }
}
