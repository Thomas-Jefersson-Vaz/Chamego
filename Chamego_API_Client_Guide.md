# Chamego — Guia de Integração do Client (API REST + WebSocket + FCM)

Documento para o desenvolvedor do app (Flutter). Descreve **exatamente o que o servidor implementa hoje**: autenticação, casal/pareamento, CRUD, sincronização offline-first, tempo real (WebSocket) e push (FCM).

> **Base URL:** `https://<SERVER_URL>` (em Docker a porta padrão é `34343`)
> Todos os exemplos abaixo usam `{{BASE}}` como base.

---

## 0. Convenções gerais

| Item | Regra |
|---|---|
| Formato | JSON (`Content-Type: application/json`) |
| Autenticação | Header `Authorization: Bearer <token>` em tudo, exceto `/api/auth/*` e `/health` |
| IDs | UUID v4. Nos recursos CRUD o **client pode gerar o `id`** (offline-first) |
| Datas | ISO 8601 em UTC, ex.: `2026-09-28T19:25:00.000Z` |
| Valores monetários | `cost` e `price` são **números** (ex.: `120.5`), nunca strings |
| Validade do token | **30 dias**. Expirou → 403 → refazer login |

### Formato de erro

Erros de negócio sempre vêm assim (use `message` para exibir ao usuário):

```json
{ "error": "E-mail ou senha incorretos.", "message": "E-mail ou senha incorretos." }
```

### Status de autenticação (corpo vazio)

| Status | Significado | Ação no app |
|---|---|---|
| `401` | Header `Authorization` ausente | Ir para login |
| `403` | Token inválido ou expirado | Limpar sessão e ir para login |

### Health check

`GET /health` ou `GET /api/health` → `200 { "status": "ok", "uptime": 123.4, "timestamp": "..." }`

---

## 1. Autenticação

### `POST /api/auth/register`

```json
{ "name": "Ana", "email": "ana@chamego.app", "password": "secret123" }
```

- Senha: mínimo **6 caracteres**. E-mail é normalizado (trim + minúsculas).

**201 Created**
```json
{
  "user": {
    "id": "e4b3c072-7a2e-4b71-97a1-2b02888bf123",
    "name": "Ana",
    "email": "ana@chamego.app",
    "couple_id": null,
    "relationship_type": "Monogâmico(a)",
    "created_at": "2026-09-28T19:00:00.000Z",
    "updated_at": "2026-09-28T19:00:00.000Z"
  },
  "token": "eyJhbGciOiJIUzI1NiIs..."
}
```

Erros: `400` (campos ausentes, e-mail inválido, senha curta) · `409` (e-mail já cadastrado).

### `POST /api/auth/login`

```json
{ "email": "ana@chamego.app", "password": "secret123" }
```

**200 OK** — mesmo formato do register (`user` + `token`). Erros: `400` · `401` (e-mail ou senha incorretos).

### `GET /api/users/me`

**200 OK** → `{ "user": { id, name, email, couple_id, relationship_type, created_at, updated_at } }`
Erro `404` se o usuário não existir mais.

### `POST /api/users/relationship-type` (alias: `POST /api/couples/relationship-type`)

```json
{ "relationship_type": "Bi-amoroso(a)" }
```

Valores aceitos (exatamente assim): `"Monogâmico(a)"`, `"Bi-amoroso(a)"`, `"Poliamoroso(a)"`.
**200** → `{ "status": "success", "relationship_type": "Bi-amoroso(a)" }` · `400` se o valor for inválido.

> O tipo de relacionamento é **por usuário** (campo `users.relationship_type`).

---

## 2. Casal e pareamento

### `GET /api/couples/me`

Sem casal: `200 { "couple": null, "partner": null }`

Com casal:
```json
{
  "couple": {
    "id": "c92881a0-381f-4f81-a9e2-88221bca9821",
    "code": "AMOR-4821",
    "user1_id": "e4b3c072-...",
    "user2_id": "f5c4d183-...",
    "partner_name": "Pedro",
    "start_date": "2024-11-02T00:00:00.000Z",
    "created_at": "...",
    "updated_at": "..."
  },
  "partner": { "id": "f5c4d183-...", "name": "Pedro", "email": "pedro@chamego.app", "relationship_type": "Monogâmico(a)", "created_at": "..." }
}
```

Enquanto o parceiro não entrou: `user2_id`, `partner_name` e `partner` vêm `null`.

### `POST /api/couples/pair`

```json
{ "code": "AMOR-4821" }
```

**O código é gerado pelo client** (ex.: `AMOR-4821`; o servidor converte para maiúsculas). A mesma rota serve para criar e para entrar:

| Situação | Resultado |
|---|---|
| Código **não existe** | Cria um casal novo com você como `user1` (`start_date = agora`). `partner_name: null` |
| Código existe e **falta o parceiro** | Você entra como `user2`. Resposta traz `partner_name` = nome do `user1`. O `user1` recebe o evento WebSocket `partner_joined` |
| Você **já faz parte** desse casal | Devolve o casal (idempotente) |
| Casal já completo (2 pessoas) | `400` "Este código é inválido ou o casal já está completo." |
| Código já em uso por corrida | `409` |

**200** → `{ "couple": { ...mesmos campos do /couples/me, "partner_name": "Pedro" } }`

**Fluxo recomendado:** Ana abre a tela de pareamento, o app gera `AMOR-4821`, chama `/pair` (cria o casal) e mostra o código. Pedro digita o código e chama `/pair`. Ana é avisada por `partner_joined` (WebSocket) — ou, se estiver offline, via `GET /api/couples/me` / sync na próxima abertura.

### `POST /api/couples/start-date`

```json
{ "start_date": "2024-11-02T00:00:00.000Z" }
```
**200** → `{ "status": "success", "start_date": "..." }` · `400` se faltar `start_date` ou se o usuário não tiver casal.

---

## 3. CRUD REST (requer token **e** casal)

Recursos: `/api/outings`, `/api/memories`, `/api/gifts`, `/api/special-dates`. Todos seguem o mesmo padrão:

| Método | Rota | Descrição | Sucesso |
|---|---|---|---|
| `GET` | `/api/<recurso>` | Lista os registros **não excluídos** do seu casal (mais recentes primeiro) | `200 [ ... ]` |
| `POST` | `/api/<recurso>` | Cria (ou atualiza, se o `id` já existir — **idempotente**) | `201` novo · `200` já existia |
| `PUT` | `/api/<recurso>/:id` | Atualização parcial (só envie os campos que mudam) | `200 { registro }` |
| `DELETE` | `/api/<recurso>/:id` | **Soft delete** | `200 { "status": "success", "id": "..." }` |

Regras comuns:

- **`couple_id` no body é ignorado.** O servidor usa o casal do usuário autenticado. Pode enviar, mas não influencia.
- `id` é opcional no `POST`; se enviado, precisa ser UUID válido (`400` caso contrário). Se omitido, o servidor gera.
- Repetir o mesmo `POST` com o mesmo `id` **não duplica** (seguro para retry offline).
- `PUT` aceita também `"is_deleted": false` para restaurar um registro excluído.
- Erros: `400` (campo obrigatório ausente / UUID ou data inválidos / casal ausente) · `404` (registro não existe no seu casal) · `409` (`id` já pertence a outro casal).
- O `DELETE` é lógico: o registro some do `GET`, mas continua existindo e aparece no `/api/sync` com `is_deleted: true` (é assim que o parceiro fica sabendo).

### 3.1 Outings (saídas) — `/api/outings`

| Campo | Tipo | Obrigatório | Observações |
|---|---|---|---|
| `title` | string | ✅ | |
| `location` | string | | |
| `date` | ISO date | | |
| `category` | string | | padrão `"Geral"` |
| `cost` | number | | |
| `status` | string | | padrão `"planned"` (`planned`, `idea`, `done`) |
| `rating` | int | | |
| `notify_option` | string | | texto livre (ex.: `"1 dia antes"`) |

```json
{ "id": "uuid", "title": "Jantar", "location": "Restaurante", "date": "2026-10-10T20:00:00.000Z",
  "category": "Comida", "cost": 120.0, "status": "planned", "notify_option": "1 dia antes" }
```

### 3.2 Memories (memórias) — `/api/memories`

| Campo | Tipo | Obrigatório | Observações |
|---|---|---|---|
| `title` | string | ✅ | |
| `date` | ISO date | ✅ | |
| `description` | string | | |
| `mood` | string | | padrão `"Felizes"` |
| `photo_urls` | array de string | | padrão `[]` |

> **Atenção:** não existe endpoint de upload de imagem. `photo_urls` guarda apenas as URLs/strings que o client enviar. Se as fotos precisarem ser compartilhadas entre os dois aparelhos, hospede-as em outro serviço (ex.: Firebase Storage) e envie a URL.

### 3.3 Gifts (presentes) — `/api/gifts`

| Campo | Tipo | Obrigatório | Observações |
|---|---|---|---|
| `title` | string | ✅ | |
| `type` | string | | padrão `"wish"` (`wish`, `secret`, `given`) |
| `store_url` | string | | |
| `price` | number | | |
| `occasion` | string | | |

`creator_id` é preenchido pelo servidor com o usuário autenticado (não é editável) e vem nas respostas.

### 3.4 Special dates (datas especiais) — `/api/special-dates`

| Campo | Tipo | Obrigatório | Observações |
|---|---|---|---|
| `title` | string | ✅ | |
| `date` | ISO date | ✅ | |
| `repeat_option` | string | | padrão `"yearly"` (texto livre, até 50 caracteres) |
| `notify_option` | string | | padrão `"day"` (texto livre, até 50 caracteres) |

> `notify_option` (aqui e em outings) é **apenas armazenado**. O servidor **não** dispara lembretes agendados. Agende as notificações locais no próprio app a partir desses campos.

Toda resposta de registro inclui também `id`, `couple_id`, `created_at`, `updated_at`, `is_deleted`.

---

## 4. Sincronização offline-first — `POST /api/sync`

Alternativa/complemento ao CRUD: envia tudo que foi alterado offline e recebe o que mudou no servidor, em uma chamada.

**Request**
```json
{
  "last_synced_at": "2026-09-28T18:00:00.000Z",
  "unsynced": {
    "couple": { "start_date": "2024-11-02T00:00:00.000Z" },
    "chamegos":      [ { "id": "uuid", "couple_id": "uuid", "sender_id": "uuid", "text": "Um abraço!", "type": "Abraço", "created_at": "..." } ],
    "outings":       [ { "id": "uuid", "couple_id": "uuid", "title": "...", "location": null, "date": null, "category": "Geral", "cost": null, "status": "planned", "rating": null, "notify_option": null, "created_at": "...", "updated_at": "...", "is_deleted": false } ],
    "memories":      [ { "id": "uuid", "couple_id": "uuid", "title": "...", "date": "...", "description": null, "mood": "Felizes", "photo_urls": [], "created_at": "...", "updated_at": "...", "is_deleted": false } ],
    "gifts":         [ { "id": "uuid", "couple_id": "uuid", "creator_id": "uuid", "type": "wish", "title": "...", "store_url": null, "price": null, "occasion": null, "created_at": "...", "updated_at": "...", "is_deleted": false } ],
    "special_dates": [ { "id": "uuid", "couple_id": "uuid", "title": "...", "date": "...", "repeat_option": "yearly", "notify_option": "day", "created_at": "...", "updated_at": "...", "is_deleted": false } ]
  }
}
```

Todas as chaves de `unsynced` são opcionais. Nesta rota o client envia `created_at`/`updated_at` próprios (o servidor usa o que vier).

**Response 200**
```json
{
  "synced_at": "2026-09-28T19:20:00.000Z",
  "status": "success",
  "remote_updates": {
    "couple": { "...": "...", "partner_name": "Pedro" },
    "users": [ { "id": "...", "name": "...", "email": "...", "couple_id": "...", "relationship_type": "...", "created_at": "...", "updated_at": "..." } ],
    "chamegos": [], "outings": [], "memories": [], "gifts": [], "special_dates": []
  }
}
```

Regras importantes:

- Guarde o `synced_at` retornado e envie-o como `last_synced_at` na próxima chamada. Sem ele (ou vazio), o servidor devolve **tudo** desde 1970.
- `remote_updates` filtra por `updated_at > last_synced_at` (chamegos: por `created_at`) e **inclui registros com `is_deleted: true`** — aplique as exclusões no SQLite local.
- Resolução de conflito: **último a gravar vence** (upsert por `id`).
- Chamegos no sync são **somente inserção** (`ON CONFLICT DO NOTHING`).
- Sem casal: `remote_updates` volta vazio (`couple: null`).
- O sync **não dispara push nem WebSocket**. Para o parceiro ser avisado na hora, use `POST /api/notifications/emote` (seção 5).

---

## 5. Chamegos em tempo real — `POST /api/notifications/emote`

Quando o usuário toca em um emote ("Abraço", "Beijo", "Saudade", "Pensando em você"...).

**Request**
```json
{
  "couple_id": "c92881a0-381f-4f81-a9e2-88221bca9821",
  "sender_name": "Ana",
  "emote": "Abraço",
  "text": "Mandei um abraço 🤍",
  "timestamp": "2026-09-28T19:25:00.000Z"
}
```

| Campo | Obrigatório | Observações |
|---|---|---|
| `couple_id` | ✅ | Precisa ser o casal do usuário logado, senão `403` |
| `emote` | ✅ | Gravado na coluna `type` do chamego |
| `text` | | Se vazio, usa o próprio `emote` |
| `sender_name` | | Se vazio, usa o nome do usuário |
| `timestamp` | | Se vazio, usa a hora do servidor |
| `id` | | Apenas repassado no evento WebSocket (**não** é o id gravado no banco) |

O **remetente é sempre o usuário do token** (`sender_id` no body é ignorado).

**O que o servidor faz, em ordem:**
1. Grava o chamego em `chamegos`.
2. Emite `receive_emote` por WebSocket para a sala do casal.
3. Envia push FCM ao parceiro (se ele tiver token registrado e o servidor estiver com o Firebase configurado).

**200 OK**
```json
{ "status": "success", "message": "Emote processed.", "push_sent": true, "sent_at": "2026-09-28T19:25:00.000Z" }
```

`push_sent: false` **não é erro**: o parceiro não tem token, o Firebase não está configurado no servidor, ou o envio falhou. O chamego foi salvo e o evento WebSocket foi emitido do mesmo jeito.

Erros: `400` (falta `couple_id`/`emote`) · `403` (não pertence ao casal) · `500`.

> ⚠️ **Evite duplicar:** como o servidor grava o chamego com um **id próprio** (ignora o `id` do client), **não** inclua o mesmo chamego também em `unsynced.chamegos`, ou ele aparecerá duplicado para o parceiro. Para chamegos enviados por esta rota, deixe o sync apenas baixá-los (`remote_updates.chamegos`) e deduplique localmente por (`sender_id`, `type`, `created_at`) se necessário.

---

## 6. WebSocket (Socket.IO)

> ⚠️ O `/ws` é o **path** do Socket.IO, **não** um namespace. Conectar com `io('https://host/ws')` está **errado** (isso tenta o namespace `/ws`, que não existe). O correto é informar `path: '/ws'`.

**JavaScript (referência)**
```js
const socket = io('https://<SERVER_URL>', {
  path: '/ws',
  transports: ['websocket'],
  query: { token: '<JWT>' },
});
```

**Flutter (`socket_io_client`)**
```dart
import 'package:socket_io_client/socket_io_client.dart' as IO;

final socket = IO.io(
  'https://<SERVER_URL>',
  IO.OptionBuilder()
      .setPath('/ws')
      .setTransports(['websocket'])
      .setQuery({'token': jwt})
      .disableAutoConnect()
      .build(),
);
socket.connect();

socket.on('receive_emote', (data) { /* ... */ });
socket.on('partner_joined', (data) { /* ... */ });
```

Se o token for inválido, o servidor **desconecta** o socket imediatamente.

### Salas (automático)

Ao conectar, o servidor entra o socket nas salas `user:<user_id>` e, se o usuário tiver casal, `couple:<couple_id>`. Ao parear, as salas são atualizadas sem reconectar. Se precisar, é possível forçar com `join_couple`.

### Eventos

| Direção | Evento | Payload |
|---|---|---|
| client → servidor | `join_couple` | `{ "couple_id": "uuid" }` |
| client → servidor | `send_emote` | `{ "id"?, "couple_id", "sender_id"?, "sender_name", "emote", "text" }` |
| servidor → client | `receive_emote` | ver abaixo |
| servidor → client | `partner_joined` | `{ "couple_id", "partner_id", "partner_name" }` |

**`receive_emote`**
```json
{
  "event": "receive_emote",
  "id": "uuid-ou-ausente",
  "couple_id": "uuid",
  "sender_id": "uuid",
  "sender_name": "Ana",
  "emote": "Abraço",
  "text": "Mandei um abraço 🤍",
  "timestamp": "2026-09-28T19:25:00.000Z"
}
```

### `send_emote` (WebSocket) × `POST /api/notifications/emote` (HTTP)

| | WebSocket `send_emote` | HTTP `/notifications/emote` |
|---|---|---|
| Entrega em tempo real ao parceiro online | ✅ | ✅ |
| Grava no banco | ❌ | ✅ |
| Envia push FCM | ❌ | ✅ |
| Remetente também recebe o evento | ❌ (só os outros) | ✅ (**toda a sala**, inclusive você) |

**Recomendação:** use sempre o **HTTP** para enviar chamegos. Ignore no client os `receive_emote` cujo `sender_id` seja o do próprio usuário (para não exibir seu próprio chamego como recebido). Use o WebSocket principalmente para **receber** (`receive_emote`, `partner_joined`).

---

## 7. Push Notifications (FCM)

O servidor usa a **FCM HTTP v1** via Firebase Admin SDK. A *server key* legada não é mais usada.

### 7.1 Endpoints de token

#### `POST /api/users/fcm-token`
```json
{ "fcm_token": "c_X9...token_do_dispositivo..." }
```
**200** → `{ "status": "success" }` · `400` se o token for vazio, não-string ou maior que 512 caracteres.

- Cada usuário guarda **um** token. Registrar de outro aparelho substitui o anterior.
- Se o mesmo token já estava em outra conta (troca de login no mesmo aparelho), ele é removido da conta antiga.

#### `DELETE /api/users/fcm-token`
**200** → `{ "status": "success" }`. **Chame no logout**, para o aparelho deixar de receber pushes dessa conta.

> Se o FCM informar que um token é inválido/expirado, o servidor o apaga sozinho. O app só volta a receber push depois de registrar um token novo — por isso, registre o token a cada abertura do app logado.

### 7.2 Payload recebido pelo app

O push é uma *notification message* com `data`:

| | Conteúdo |
|---|---|
| `notification.title` | `❤️ {sender_name} te mandou um chamego!` |
| `notification.body` | texto do chamego |
| `data.type` | emote (ex.: `"Abraço"`) |
| `data.couple_id` | id do casal |
| `data.sender_id` | id de quem enviou |
| `data.sender_name` | nome de quem enviou |
| `data.text` | texto do chamego |
| `data.timestamp` | ISO 8601 |

Android: prioridade alta, som padrão e `channelId = "chamegos_emotes_channel"`. iOS: prioridade 10, som padrão.

### 7.3 Implementação no Flutter

**1) Dependências (`pubspec.yaml`)**
```yaml
dependencies:
  firebase_core: ^3.8.0
  firebase_messaging: ^15.1.5
  flutter_local_notifications: ^18.0.0   # canal Android + exibir push em primeiro plano
```

**2) Configuração do projeto Firebase**
- Rode `flutterfire configure` (gera `firebase_options.dart`) ou adicione `google-services.json` (Android) / `GoogleService-Info.plist` (iOS).
- **iOS:** faça upload da chave **APNs (.p8)** em *Firebase Console → Project Settings → Cloud Messaging*; no Xcode ative as capabilities **Push Notifications** e **Background Modes → Remote notifications**.
- **Android 13+:** declare `POST_NOTIFICATIONS` no `AndroidManifest.xml` (a permissão é pedida em runtime pelo `requestPermission`).

> O **mesmo projeto Firebase** do app precisa ser o da service account configurada no servidor. Se forem projetos diferentes, o FCM rejeita o envio.

**3) `main.dart`**
```dart
import 'package:firebase_core/firebase_core.dart';
import 'package:firebase_messaging/firebase_messaging.dart';
import 'package:flutter_local_notifications/flutter_local_notifications.dart';

@pragma('vm:entry-point')
Future<void> _firebaseMessagingBackgroundHandler(RemoteMessage message) async {
  await Firebase.initializeApp();
  // Mensagens com `notification` já são exibidas pelo sistema em background/encerrado.
  // Aqui só trate lógica extra (ex.: atualizar cache local) se precisar.
}

final _localNotifications = FlutterLocalNotificationsPlugin();

const _emoteChannel = AndroidNotificationChannel(
  'chamegos_emotes_channel',            // DEVE ser exatamente este id
  'Chamegos',
  description: 'Chamegos enviados pelo seu amor',
  importance: Importance.high,
);

Future<void> main() async {
  WidgetsFlutterBinding.ensureInitialized();
  await Firebase.initializeApp();
  FirebaseMessaging.onBackgroundMessage(_firebaseMessagingBackgroundHandler);

  // Cria o canal Android (obrigatório para o heads-up funcionar no Android 8+)
  await _localNotifications.initialize(
    const InitializationSettings(
      android: AndroidInitializationSettings('@mipmap/ic_launcher'),
      iOS: DarwinInitializationSettings(),
    ),
  );
  await _localNotifications
      .resolvePlatformSpecificImplementation<AndroidFlutterLocalNotificationsPlugin>()
      ?.createNotificationChannel(_emoteChannel);

  await FirebaseMessaging.instance.requestPermission(alert: true, badge: true, sound: true);

  runApp(const ChamegoApp());
}
```

**4) Registrar o token no servidor** — chame após login/registro **e** a cada abertura do app já logado:
```dart
Future<void> registerFcmToken(String jwt) async {
  final messaging = FirebaseMessaging.instance;

  Future<void> send(String token) => http.post(
        Uri.parse('$baseUrl/api/users/fcm-token'),
        headers: {'Authorization': 'Bearer $jwt', 'Content-Type': 'application/json'},
        body: jsonEncode({'fcm_token': token}),
      );

  final token = await messaging.getToken();
  if (token != null) await send(token);

  // O Firebase pode trocar o token a qualquer momento
  messaging.onTokenRefresh.listen(send);
}
```

**5) Logout**
```dart
await http.delete(Uri.parse('$baseUrl/api/users/fcm-token'),
    headers: {'Authorization': 'Bearer $jwt'});
await FirebaseMessaging.instance.deleteToken();
```

**6) Mensagens com o app aberto (primeiro plano)** — no Android o sistema **não** exibe a notificação sozinho; mostre uma local ou um aviso no app:
```dart
FirebaseMessaging.onMessage.listen((RemoteMessage m) {
  final n = m.notification;
  if (n == null) return;
  _localNotifications.show(
    m.hashCode,
    n.title,
    n.body,
    NotificationDetails(
      android: AndroidNotificationDetails(_emoteChannel.id, _emoteChannel.name,
          importance: Importance.high, priority: Priority.high),
      iOS: const DarwinNotificationDetails(),
    ),
  );
});
```
> Se o WebSocket estiver conectado, o mesmo chamego chega também por `receive_emote`. Escolha **uma** forma de exibir quando o app está em primeiro plano (sugestão: WebSocket em primeiro plano, FCM em background/encerrado) para não mostrar duplicado.

**7) Toque na notificação**
```dart
// App em background
FirebaseMessaging.onMessageOpenedApp.listen((m) => openChamego(m.data));
// App estava encerrado
final initial = await FirebaseMessaging.instance.getInitialMessage();
if (initial != null) openChamego(initial.data);
```

### 7.4 Checklist de teste de push

1. Ana e Pedro logam em aparelhos **físicos** (push no simulador iOS não funciona) e pareiam.
2. Ambos chamam `POST /api/users/fcm-token` (confirme `200`).
3. Feche o app do Pedro e, no da Ana, envie um emote.
4. A resposta de `POST /api/notifications/emote` deve trazer `"push_sent": true`.
5. Se vier `push_sent: false`: Pedro não registrou token, ou o servidor está sem credenciais do Firebase, ou o projeto Firebase do app é diferente do configurado no servidor.

---

## 8. O que o servidor **não** faz (planeje no client)

- **Lembretes agendados** (`notify_option` de saídas e datas especiais): só armazenados — agende notificações locais no app.
- **Upload de fotos:** não há endpoint; `photo_urls` guarda apenas strings.
- **Recuperação de senha, troca de senha, exclusão de conta e desfazer pareamento:** não implementados.
- **Push em outros eventos:** hoje só chamegos (`/api/notifications/emote`) geram push. `partner_joined` é só WebSocket.
- **Vários dispositivos por usuário:** só um token FCM por conta (o último registrado vale).

---

## 9. Resumo das rotas

| Método | Rota | Auth |
|---|---|---|
| GET | `/health`, `/api/health` | — |
| POST | `/api/auth/register` | — |
| POST | `/api/auth/login` | — |
| GET | `/api/users/me` | ✅ |
| POST | `/api/users/relationship-type` (alias `/api/couples/relationship-type`) | ✅ |
| POST | `/api/users/fcm-token` | ✅ |
| DELETE | `/api/users/fcm-token` | ✅ |
| GET | `/api/couples/me` | ✅ |
| POST | `/api/couples/pair` | ✅ |
| POST | `/api/couples/start-date` | ✅ |
| GET · POST | `/api/outings` · `/api/memories` · `/api/gifts` · `/api/special-dates` | ✅ |
| PUT · DELETE | `/api/outings/:id` · `/api/memories/:id` · `/api/gifts/:id` · `/api/special-dates/:id` | ✅ |
| POST | `/api/sync` | ✅ |
| POST | `/api/notifications/emote` | ✅ |
| WS | Socket.IO em `path: '/ws'`, `query: { token }` | ✅ |
