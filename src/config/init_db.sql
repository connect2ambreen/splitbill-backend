BEGIN;

-- ─────────────────────────────────────────────────────────────
-- USERS
-- ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS users (
    id SERIAL PRIMARY KEY,
    name VARCHAR(100) NOT NULL,
    email VARCHAR(150) UNIQUE NOT NULL,
    password TEXT NOT NULL,
    phone VARCHAR(20),
    profile_url TEXT,
    default_currency VARCHAR(10) DEFAULT 'USD',
    locale JSONB DEFAULT '{"currencySymbol": "$"}',
    fcm_token TEXT,
    bio_pub_key TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- ─────────────────────────────────────────────────────────────
-- GROUPS
-- ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS groups (
    id SERIAL PRIMARY KEY,
    name VARCHAR(100) NOT NULL,
    description TEXT,
    created_by INTEGER REFERENCES users(id) ON DELETE CASCADE,
    default_currency VARCHAR(10) DEFAULT 'USD',
    is_active BOOLEAN DEFAULT true,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS group_members (
    id SERIAL PRIMARY KEY,
    group_id INTEGER REFERENCES groups(id) ON DELETE CASCADE,
    user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
    role VARCHAR(20) DEFAULT 'member',
    is_active BOOLEAN DEFAULT true,
    UNIQUE(group_id, user_id)
);

-- ─────────────────────────────────────────────────────────────
-- EXPENSES
-- ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS expenses (
    id SERIAL PRIMARY KEY,
    group_id INTEGER REFERENCES groups(id) ON DELETE CASCADE,
    description TEXT NOT NULL,
    total_amount NUMERIC(10,2) NOT NULL,
    paid_by INTEGER REFERENCES users(id),
    currency VARCHAR(10) DEFAULT 'USD',
    is_deleted BOOLEAN DEFAULT false,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS expense_shares (
    id SERIAL PRIMARY KEY,
    expense_id INTEGER REFERENCES expenses(id) ON DELETE CASCADE,
    user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
    owed_share NUMERIC(10,2) NOT NULL,
    paid_share NUMERIC(10,2) DEFAULT 0
);

-- ─────────────────────────────────────────────────────────────
-- NOTIFICATIONS
-- ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS notifications (
    id SERIAL PRIMARY KEY,
    user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
    group_id INTEGER REFERENCES groups(id),
    type VARCHAR(50),
    title VARCHAR(100),
    message TEXT,
    related_expense_id INTEGER,
    is_read BOOLEAN DEFAULT false,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- ─────────────────────────────────────────────────────────────
-- SETTLEMENTS
-- ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS settlements (
    id SERIAL PRIMARY KEY,
    group_id INTEGER REFERENCES groups(id) ON DELETE CASCADE,
    payer_user_id INTEGER REFERENCES users(id),
    payee_user_id INTEGER REFERENCES users(id),
    amount NUMERIC(10,2) NOT NULL,
    status VARCHAR(20) DEFAULT 'pending',
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- ─────────────────────────────────────────────────────────────
-- ACTIVITIES (OPTIONAL FEED)
-- ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS activities (
    id SERIAL PRIMARY KEY,
    user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
    group_id INTEGER REFERENCES groups(id) ON DELETE CASCADE,
    activity_type VARCHAR(50),
    description TEXT,
    amount NUMERIC(10,2),
    related_expense_id INTEGER,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- ─────────────────────────────────────────────────────────────
-- 🔥 LEDGER MODULE (DIGIKHATA STYLE)
-- ─────────────────────────────────────────────────────────────

-- ENUM
DO $$ BEGIN
    CREATE TYPE business_type_enum AS ENUM (
        'retail_shop',
        'wholesale',
        'restaurant_cafe',
        'pharmacy',
        'freelancer',
        'service_provider',
        'other'
    );
EXCEPTION
    WHEN duplicate_object THEN null;
END $$;

-- BUSINESS (1 per user)
CREATE TABLE IF NOT EXISTS businesses (
    id SERIAL PRIMARY KEY,
    user_id INTEGER UNIQUE NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name VARCHAR(255) NOT NULL,
    business_type business_type_enum DEFAULT 'other',
    phone VARCHAR(20),
    address TEXT,
    currency VARCHAR(10) DEFAULT 'PKR',
    is_active BOOLEAN DEFAULT true,
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW()
);

-- CUSTOMERS
CREATE TABLE IF NOT EXISTS customers (
    id SERIAL PRIMARY KEY,
    business_id INTEGER REFERENCES businesses(id) ON DELETE CASCADE,
    name VARCHAR(255) NOT NULL,
    phone VARCHAR(20),
    created_at TIMESTAMP DEFAULT NOW()
);

-- TRANSACTIONS (CORE OF LEDGER)
CREATE TABLE IF NOT EXISTS ledger_transactions (
    id SERIAL PRIMARY KEY,
    business_id INTEGER REFERENCES businesses(id) ON DELETE CASCADE,
    customer_id INTEGER REFERENCES customers(id) ON DELETE CASCADE,
    amount NUMERIC(10,2) NOT NULL,
    type VARCHAR(10) CHECK (type IN ('gave', 'got')),
    note TEXT,
    created_at TIMESTAMP DEFAULT NOW()
);

-- ─────────────────────────────────────────────────────────────
-- INDEXES (PERFORMANCE)
-- ─────────────────────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_expenses_group ON expenses(group_id);
CREATE INDEX IF NOT EXISTS idx_expense_shares_user ON expense_shares(user_id);
CREATE INDEX IF NOT EXISTS idx_notifications_user ON notifications(user_id);
CREATE INDEX IF NOT EXISTS idx_ledger_customer ON ledger_transactions(customer_id);

COMMIT;