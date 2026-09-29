-- Enable UUID extension
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- 1. Users Table
CREATE TABLE IF NOT EXISTS users (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    name VARCHAR(255) NOT NULL,
    email VARCHAR(255) UNIQUE NOT NULL,
    password_hash VARCHAR(255) NOT NULL,
    couple_id UUID,
    fcm_token VARCHAR(512),
    relationship_type VARCHAR(50) NOT NULL DEFAULT 'Monogâmico(a)',
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- 2. Couples Table
CREATE TABLE IF NOT EXISTS couples (
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
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1
        FROM information_schema.table_constraints
        WHERE constraint_name = 'fk_users_couple'
        AND table_name = 'users'
    ) THEN
        ALTER TABLE users 
        ADD CONSTRAINT fk_users_couple 
        FOREIGN KEY (couple_id) REFERENCES couples(id) ON DELETE SET NULL;
    END IF;
END $$;

-- 3. Chamegos (Messages/Interactions/Emotes) Table
CREATE TABLE IF NOT EXISTS chamegos (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    couple_id UUID NOT NULL REFERENCES couples(id) ON DELETE CASCADE,
    sender_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    text TEXT NOT NULL,
    type VARCHAR(50) NOT NULL DEFAULT 'custom',
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- 4. Outings (Saídas/Encontros) Table
CREATE TABLE IF NOT EXISTS outings (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    couple_id UUID NOT NULL REFERENCES couples(id) ON DELETE CASCADE,
    title VARCHAR(255) NOT NULL,
    location VARCHAR(255),
    date TIMESTAMP WITH TIME ZONE,
    category VARCHAR(100) NOT NULL DEFAULT 'Geral',
    cost DECIMAL(10, 2),
    status VARCHAR(50) NOT NULL DEFAULT 'planned',
    rating INT,
    notify_option VARCHAR(100),
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    is_deleted BOOLEAN NOT NULL DEFAULT FALSE
);

-- 5. Memories Table
CREATE TABLE IF NOT EXISTS memories (
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
CREATE TABLE IF NOT EXISTS gifts (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    couple_id UUID NOT NULL REFERENCES couples(id) ON DELETE CASCADE,
    creator_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    type VARCHAR(50) NOT NULL DEFAULT 'wish',
    title VARCHAR(255) NOT NULL,
    store_url TEXT,
    price DECIMAL(10, 2),
    occasion VARCHAR(100),
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    is_deleted BOOLEAN NOT NULL DEFAULT FALSE
);

-- 7. Special Dates (Datas Especiais) Table
CREATE TABLE IF NOT EXISTS special_dates (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    couple_id UUID NOT NULL REFERENCES couples(id) ON DELETE CASCADE,
    title VARCHAR(255) NOT NULL,
    date TIMESTAMP WITH TIME ZONE NOT NULL,
    repeat_option VARCHAR(50) NOT NULL DEFAULT 'yearly',
    notify_option VARCHAR(50) NOT NULL DEFAULT 'day',
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    is_deleted BOOLEAN NOT NULL DEFAULT FALSE
);

-- Indexes for optimal query performance
CREATE INDEX IF NOT EXISTS idx_chamegos_couple ON chamegos(couple_id, created_at);
CREATE INDEX IF NOT EXISTS idx_outings_couple ON outings(couple_id, updated_at);
CREATE INDEX IF NOT EXISTS idx_memories_couple ON memories(couple_id, updated_at);
CREATE INDEX IF NOT EXISTS idx_gifts_couple ON gifts(couple_id, updated_at);
CREATE INDEX IF NOT EXISTS idx_special_dates_couple ON special_dates(couple_id, updated_at);
