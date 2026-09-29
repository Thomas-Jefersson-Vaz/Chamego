# Instructions for AI Server Developer: Chamego Backend

This document serves as the complete technical specification for building the backend server for the **Chamego** app. Read these instructions carefully to implement a compatible backend with **PostgreSQL** database, REST API, WebSocket, and Push Notification support for real-time emotes.

---

## 🚀 Overview & Tech Stack Recommendations

The backend serves the **Chamego** Flutter mobile app. The app is **offline-first**: it uses a local SQLite database and periodically synchronizes state with this main PostgreSQL backend via a single `/api/sync` endpoint and supplementary auth/pairing/notification endpoints.

### Recommended Stack
- **Node.js**: Express / NestJS with TypeScript, Socket.io / WebSockets, and Prisma or Drizzle ORM
- **Python**: FastAPI with WebSockets / FCM and SQLAlchemy or SQLModel
- **Go**: Gin or Fiber with Gorilla WebSockets and GORM / pgx
- **Database**: PostgreSQL 15+

---

## 🔑 Environment Variables (`.env`)

```env
PORT=3000
DATABASE_URL=postgresql://chamego_user:chamego_password@localhost:5432/chamego_db?schema=public
JWT_SECRET=chamego_super_secret_jwt_key_2026
FCM_SERVER_KEY=optional_fcm_server_key_for_push_notifications
```

---

## 🗄️ PostgreSQL Database Schema (DDL)

Execute the following SQL script to initialize the PostgreSQL database schema:

```sql
-- Enable UUID extension
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- 1. Users Table
CREATE TABLE users (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    name VARCHAR(255) NOT NULL,
    email VARCHAR(255) UNIQUE NOT NULL,
    password_hash VARCHAR(255) NOT NULL,
    couple_id UUID,
    fcm_token VARCHAR(512), -- Optional token for push notifications
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- 2. Couples Table
CREATE TABLE couples (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    code VARCHAR(20) UNIQUE NOT NULL,
    user1_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    user2_id UUID REFERENCES users(id) ON DELETE SET NULL,
    partner_name VARCHAR(255),
    start_date TIMESTAMP WITH TIME ZONE,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Foreign key for users.couple_id
ALTER TABLE users 
ADD CONSTRAINT fk_users_couple 
FOREIGN KEY (couple_id) REFERENCES couples(id) ON DELETE SET NULL;

-- 3. Chamegos (Messages/Interactions/Emotes) Table
CREATE TABLE chamegos (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    couple_id UUID NOT NULL REFERENCES couples(id) ON DELETE CASCADE,
    sender_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    text TEXT NOT NULL,
    type VARCHAR(50) NOT NULL DEFAULT 'custom', -- 'Abraço', 'Beijo', 'Saudade', 'Pensando em você', etc.
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- 4. Outings (Saídas/Encontros) Table
CREATE TABLE outings (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    couple_id UUID NOT NULL REFERENCES couples(id) ON DELETE CASCADE,
    title VARCHAR(255) NOT NULL,
    location VARCHAR(255),
    date TIMESTAMP WITH TIME ZONE,
    category VARCHAR(100) NOT NULL DEFAULT 'Geral',
    cost DECIMAL(10, 2),
    status VARCHAR(50) NOT NULL DEFAULT 'planned', -- 'planned', 'idea', 'done'
    rating INT,
    notify_option VARCHAR(100),
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    is_deleted BOOLEAN NOT NULL DEFAULT FALSE
);

-- 5. Memories Table
CREATE TABLE memories (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    couple_id UUID NOT NULL REFERENCES couples(id) ON DELETE CASCADE,
    title VARCHAR(255) NOT NULL,
    date TIMESTAMP WITH TIME ZONE NOT NULL,
    description TEXT,
    mood VARCHAR(100) NOT NULL DEFAULT 'Felizes',
    photo_urls JSONB DEFAULT '[]'::jsonb,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    is_deleted BOOLEAN NOT NULL DEFAULT FALSE
);

-- 6. Gifts (Presentes) Table
CREATE TABLE gifts (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    couple_id UUID NOT NULL REFERENCES couples(id) ON DELETE CASCADE,
    creator_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    type VARCHAR(50) NOT NULL DEFAULT 'wish', -- 'wish', 'secret', 'given'
    title VARCHAR(255) NOT NULL,
    store_url TEXT,
    price DECIMAL(10, 2),
    occasion VARCHAR(100),
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    is_deleted BOOLEAN NOT NULL DEFAULT FALSE
);

-- 7. Special Dates (Datas Especiais) Table
CREATE TABLE special_dates (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    couple_id UUID NOT NULL REFERENCES couples(id) ON DELETE CASCADE,
    title VARCHAR(255) NOT NULL,
    date TIMESTAMP WITH TIME ZONE NOT NULL,
    repeat_option VARCHAR(50) NOT NULL DEFAULT 'yearly', -- 'none', 'monthly', 'yearly'
    notify_option VARCHAR(50) NOT NULL DEFAULT 'day', -- 'day', '1day_before', '1week_before'
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    is_deleted BOOLEAN NOT NULL DEFAULT FALSE
);

-- Indexes for optimal query performance
CREATE INDEX idx_chamegos_couple ON chamegos(couple_id, created_at);
CREATE INDEX idx_outings_couple ON outings(couple_id, updated_at);
CREATE INDEX idx_memories_couple ON memories(couple_id, updated_at);
CREATE INDEX idx_gifts_couple ON gifts(couple_id, updated_at);
CREATE INDEX idx_special_dates_couple ON special_dates(couple_id, updated_at);
```

---

## 📡 REST API & Real-time Notification Endpoints Specification

### 1. Real-Time Emotes Endpoint: `POST /api/notifications/emote` *(Bearer Token Required)*
When a user selects an emote in the app ("Abraço", "Beijo", "Saudade", "Pensando em você"), the app calls this endpoint to trigger a real-time push notification to their partner.

**Request Body:**
```json
{
  "couple_id": "c92881a0-381f-4f81-a9e2-88221bca9821",
  "sender_id": "e4b3c072-7a2e-4b71-97a1-2b02888bf123",
  "sender_name": "Ana",
  "emote": "Abraço",
  "text": "Mandei um abraço 🤍",
  "timestamp": "2026-09-28T19:25:00.000Z"
}
```

**Server Actions:**
1. Insert new entry in `chamegos` table.
2. Find the partner's user ID associated with `couple_id`.
3. If using WebSockets: Broadcast real-time `emote_received` event to partner's connected socket channel.
4. If using FCM / Apple Push: Send high-priority Push Notification to partner's device with title `"❤️ {sender_name} te mandou um chamego!"` and body `"{text}"`.

**Response (200 OK):**
```json
{
  "status": "success",
  "message": "Notification sent to partner successfully.",
  "sent_at": "2026-09-28T19:25:00.000Z"
}
```

---

### 2. WebSocket Real-Time Connection Specification (`ws://<host>:3000/ws`)

When a client connects to the WebSocket gateway:
1. Client authenticates via query parameter `ws://<host>:3000/ws?token=<JWT_TOKEN>`.
2. Client joins room `couple:<couple_id>`.
3. When client emits event `send_emote`:
```json
{
  "event": "send_emote",
  "couple_id": "c92881a0-381f-4f81-a9e2-88221bca9821",
  "sender_name": "Ana",
  "emote": "Beijo",
  "text": "Um beijo carinhoso! 😘"
}
```
4. Server broadcasts `receive_emote` to all other sockets in room `couple:<couple_id>`:
```json
{
  "event": "receive_emote",
  "sender_name": "Ana",
  "emote": "Beijo",
  "text": "Um beijo carinhoso! 😘",
  "timestamp": "2026-09-28T19:25:00.000Z"
}
```

---

### 3. Authentication Endpoints

#### `POST /api/auth/register`
Creates a new user account and returns JWT token.

**Request Body:**
```json
{
  "name": "Ana",
  "email": "ana@chamego.app",
  "password": "secretpassword123"
}
```

**Response (201 Created):**
```json
{
  "user": {
    "id": "e4b3c072-7a2e-4b71-97a1-2b02888bf123",
    "name": "Ana",
    "email": "ana@chamego.app",
    "couple_id": null,
    "created_at": "2026-09-28T19:00:00.000Z",
    "updated_at": "2026-09-28T19:00:00.000Z"
  },
  "token": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9..."
}
```

---

#### `POST /api/auth/login`
Authenticates an existing user.

**Request Body:**
```json
{
  "email": "ana@chamego.app",
  "password": "secretpassword123"
}
```

**Response (200 OK):**
```json
{
  "user": {
    "id": "e4b3c072-7a2e-4b71-97a1-2b02888bf123",
    "name": "Ana",
    "email": "ana@chamego.app",
    "couple_id": "couple-demo-1",
    "created_at": "2026-09-28T19:00:00.000Z",
    "updated_at": "2026-09-28T19:00:00.000Z"
  },
  "token": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9..."
}
```

---

### 4. Couple Pairing Endpoints

#### `POST /api/couples/pair` *(Bearer Token Required)*
Pairs two users using a unique invitation code.

**Request Body:**
```json
{
  "code": "AMOR-4821"
}
```

**Response (200 OK):**
```json
{
  "couple": {
    "id": "c92881a0-381f-4f81-a9e2-88221bca9821",
    "code": "AMOR-4821",
    "user1_id": "e4b3c072-7a2e-4b71-97a1-2b02888bf123",
    "user2_id": "f5c4d183-8b3f-5c82-08b2-3c13999cf456",
    "partner_name": "Pedro",
    "start_date": "2025-08-14T00:00:00.000Z",
    "created_at": "2026-09-28T19:00:00.000Z",
    "updated_at": "2026-09-28T19:00:00.000Z"
  }
}
```

---

### 5. Bi-directional Synchronization Endpoint

#### `POST /api/sync` *(Bearer Token Required)*
Main synchronization endpoint called by the Flutter app.

**Request Body:**
```json
{
  "last_synced_at": "2026-09-28T18:00:00.000Z",
  "unsynced": {
    "chamegos": [
      {
        "id": "a1b2c3d4-0000-0000-0000-111122223333",
        "couple_id": "c92881a0-381f-4f81-a9e2-88221bca9821",
        "sender_id": "e4b3c072-7a2e-4b71-97a1-2b02888bf123",
        "text": "Um abraço apertado!",
        "type": "Abraço",
        "created_at": "2026-09-28T19:10:00.000Z"
      }
    ],
    "outings": [],
    "memories": [],
    "gifts": [],
    "special_dates": []
  }
}
```

**Response (200 OK):**
```json
{
  "synced_at": "2026-09-28T19:20:00.000Z",
  "status": "success",
  "remote_updates": {
    "chamegos": [],
    "outings": [],
    "memories": [],
    "gifts": [],
    "special_dates": []
  }
}
```

---

## 🐳 Docker Compose Configuration (`docker-compose.yml`)

```yaml
version: '3.8'

services:
  postgres:
    image: postgres:15-alpine
    container_name: chamego_postgres
    restart: always
    environment:
      POSTGRES_USER: chamego_user
      POSTGRES_PASSWORD: chamego_password
      POSTGRES_DB: chamego_db
    ports:
      - "5432:5432"
    volumes:
      - postgres_data:/var/lib/postgresql/data

volumes:
  postgres_data:
```

---

## 📋 Step-by-Step Implementation Task Checklist for the AI

- [ ] **Step 1:** Initialize repository & configure environment variables (`PORT`, `DATABASE_URL`, `JWT_SECRET`).
- [ ] **Step 2:** Start PostgreSQL container via `docker-compose up -d`.
- [ ] **Step 3:** Create database schema tables (`users`, `couples`, `chamegos`, `outings`, `memories`, `gifts`, `special_dates`).
- [ ] **Step 4:** Implement `/api/auth/register` and `/api/auth/login` with password hashing (bcrypt) and JWT generation.
- [ ] **Step 5:** Implement `/api/couples/pair` to link user couples.
- [ ] **Step 6:** Implement real-time emote notification handling (`POST /api/notifications/emote` and WebSocket `/ws` gateway).
- [ ] **Step 7:** Implement `/api/sync` bi-directional synchronization endpoint with PostgreSQL upsert logic.
- [ ] **Step 8:** Run and test API server on `http://localhost:3000`.
