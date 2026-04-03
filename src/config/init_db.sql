BEGIN;

-- ─────────────────────────────────────────────────────────────
-- USERS
-- ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS users (
    id               SERIAL PRIMARY KEY,
    name             VARCHAR(100) NOT NULL,
    email            VARCHAR(150) UNIQUE NOT NULL,
    password         TEXT NOT NULL,
    phone            VARCHAR(20),
    profile_url      TEXT,
    default_currency VARCHAR(10) DEFAULT 'USD',
    locale           JSONB DEFAULT '{"flag": "🇺🇸", "country": "US", "currency": "USD", "language": "en", "currencySymbol": "$"}',
    fcm_token        TEXT,
    bio_pub_key      TEXT,                          -- added from ALTER TABLE
    created_at       TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at       TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- ─────────────────────────────────────────────────────────────
-- PASSWORD RESETS
-- ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS password_resets (
    id         SERIAL PRIMARY KEY,
    user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    token      TEXT NOT NULL,
    expires_at TIMESTAMP NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- ─────────────────────────────────────────────────────────────
-- GROUPS
-- ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS groups (
    id               SERIAL PRIMARY KEY,
    name             VARCHAR(100) NOT NULL,
    description      TEXT,
    group_type       VARCHAR(50) DEFAULT 'general',
    created_by       INTEGER REFERENCES users(id) ON DELETE CASCADE,
    invite_code      VARCHAR(20) UNIQUE,
    default_currency VARCHAR(10) DEFAULT 'USD',
    avatar_url       TEXT,
    is_active        BOOLEAN DEFAULT true,
    created_at       TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS group_members (
    id        SERIAL PRIMARY KEY,
    group_id  INTEGER REFERENCES groups(id) ON DELETE CASCADE,
    user_id   INTEGER REFERENCES users(id) ON DELETE CASCADE,
    role      VARCHAR(20) DEFAULT 'member',
    is_active BOOLEAN DEFAULT true,
    joined_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(group_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_group_members_group ON group_members(group_id);
CREATE INDEX IF NOT EXISTS idx_group_members_user  ON group_members(user_id);

-- ─────────────────────────────────────────────────────────────
-- GROUP INVITATIONS
-- ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS group_invitations (
    id               SERIAL PRIMARY KEY,
    group_id         INTEGER REFERENCES groups(id),
    inviter_user_id  INTEGER REFERENCES users(id),
    invitee_email    VARCHAR(255) NOT NULL,
    invitee_name     VARCHAR(255),
    user_id          INTEGER REFERENCES users(id),
    invitation_token VARCHAR(255) UNIQUE NOT NULL,
    status           VARCHAR(50) DEFAULT 'pending',
    expires_at       TIMESTAMP NOT NULL,
    sent_at          TIMESTAMP DEFAULT now(),
    accepted_at      TIMESTAMP,
    created_at       TIMESTAMP DEFAULT now()
);

-- ─────────────────────────────────────────────────────────────
-- EXPENSE CATEGORIES
-- ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS expense_categories (
    id   SERIAL PRIMARY KEY,
    name VARCHAR(50) UNIQUE NOT NULL
);

-- Seed all 4 categories (safe re-run with ON CONFLICT DO NOTHING)
INSERT INTO expense_categories (name) VALUES
    ('Food'),
    ('Transport'),
    ('Entertainment'),
    ('Utilities')
ON CONFLICT (name) DO NOTHING;

-- ─────────────────────────────────────────────────────────────
-- EXPENSES
-- ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS expenses (
    id           SERIAL PRIMARY KEY,
    group_id     INTEGER REFERENCES groups(id) ON DELETE CASCADE,
    description  TEXT NOT NULL,
    total_amount NUMERIC(10, 2) NOT NULL,
    split_type   VARCHAR(20),
    paid_by      INTEGER REFERENCES users(id),
    currency     VARCHAR(10) DEFAULT 'USD',
    category_id  INTEGER REFERENCES expense_categories(id),
    is_deleted   BOOLEAN DEFAULT false,
    created_at   TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at   TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_expenses_group          ON expenses(group_id);
CREATE INDEX IF NOT EXISTS idx_expenses_deleted_created ON expenses(is_deleted, created_at);  -- dashboard filter

-- ─────────────────────────────────────────────────────────────
-- EXPENSE SHARES
-- ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS expense_shares (
    id         SERIAL PRIMARY KEY,
    expense_id INTEGER REFERENCES expenses(id) ON DELETE CASCADE,
    user_id    INTEGER REFERENCES users(id) ON DELETE CASCADE,
    owed_share NUMERIC(10, 2) NOT NULL,
    paid_share NUMERIC(10, 2) DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_expense_shares_user       ON expense_shares(user_id);
CREATE INDEX IF NOT EXISTS idx_expense_shares_expense_id ON expense_shares(expense_id);  -- JOIN performance

-- ─────────────────────────────────────────────────────────────
-- SETTLEMENTS
-- ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS settlements (
    id             SERIAL PRIMARY KEY,
    group_id       INTEGER REFERENCES groups(id) ON DELETE CASCADE,
    payer_user_id  INTEGER REFERENCES users(id),
    payee_user_id  INTEGER REFERENCES users(id),
    amount         NUMERIC(10, 2) NOT NULL,
    notes          TEXT,
    payment_method VARCHAR(50) DEFAULT 'cash',
    status         VARCHAR(20) DEFAULT 'pending',
    approved_by    INTEGER REFERENCES users(id),
    approved_at    TIMESTAMP,
    expense_id     INTEGER REFERENCES expenses(id) ON DELETE SET NULL,
    created_at     TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at     TIMESTAMP DEFAULT now()
);

-- ─────────────────────────────────────────────────────────────
-- NOTIFICATIONS
-- ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS notifications (
    id                    SERIAL PRIMARY KEY,
    user_id               INTEGER REFERENCES users(id) ON DELETE CASCADE,
    group_id              INTEGER REFERENCES groups(id),
    type                  VARCHAR(50),
    title                 VARCHAR(100),
    message               TEXT,
    related_expense_id    INTEGER,
    related_settlement_id INTEGER,
    is_read               BOOLEAN DEFAULT false,
    created_at            TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_notifications_user ON notifications(user_id);

-- ─────────────────────────────────────────────────────────────
-- ACTIVITIES
-- ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS activities (
    id                 SERIAL PRIMARY KEY,
    group_id           INTEGER REFERENCES groups(id) ON DELETE CASCADE,
    user_id            INTEGER REFERENCES users(id) ON DELETE CASCADE,
    activity_type      VARCHAR(50),
    description        TEXT,
    amount             NUMERIC(10, 2),
    currency           VARCHAR(10),
    related_expense_id INTEGER REFERENCES expenses(id),
    created_at         TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Composite index: user_id + created_at DESC for ORDER BY DESC LIMIT queries
CREATE INDEX IF NOT EXISTS idx_activities_user_created ON activities(user_id, created_at DESC);

-- ─────────────────────────────────────────────────────────────
-- LEDGER MODULE (DIGIKHATA / HISAAB STYLE)
-- ─────────────────────────────────────────────────────────────

-- Business type enum (safe re-run)
DO $$ BEGIN
    CREATE TYPE business_type_enum AS ENUM (
        'retail_shop',
        'wholesale',
        'restaurant_cafe',
        'pharmacy',
        'freelancer',
        'manufacturer',
        'distributor',
        'service_provider',
        'other'
    );
EXCEPTION
    WHEN duplicate_object THEN null;
END $$;

-- BUSINESSES (one per user)
CREATE TABLE IF NOT EXISTS businesses (
    id            SERIAL PRIMARY KEY,
    user_id       INTEGER UNIQUE NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name          VARCHAR(255) NOT NULL,
    business_type business_type_enum DEFAULT 'other',
    phone         VARCHAR(20),
    address       TEXT,
    currency      VARCHAR(10) DEFAULT 'PKR',
    is_active     BOOLEAN DEFAULT true,
    created_at    TIMESTAMP DEFAULT NOW(),
    updated_at    TIMESTAMP DEFAULT NOW()
);

-- CUSTOMERS
CREATE TABLE IF NOT EXISTS customers (
    id          SERIAL PRIMARY KEY,
    business_id INTEGER NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
    user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name        VARCHAR(255) NOT NULL,
    phone       VARCHAR(20),
    address     TEXT,
    notes       TEXT,
    is_active   BOOLEAN DEFAULT true,
    created_at  TIMESTAMP DEFAULT NOW(),
    updated_at  TIMESTAMP DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_customers_business_id ON customers(business_id);
CREATE INDEX IF NOT EXISTS idx_customers_user_id     ON customers(user_id);

-- LEDGER TRANSACTIONS
CREATE TABLE IF NOT EXISTS ledger_transactions (
    id               SERIAL PRIMARY KEY,
    business_id      INTEGER NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
    customer_id      INTEGER NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
    user_id          INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    type             VARCHAR(10) NOT NULL CHECK (type IN ('gave', 'got')),
    amount           NUMERIC(12, 2) NOT NULL CHECK (amount > 0),
    note             TEXT,
    transaction_date TIMESTAMPTZ,      -- added from ALTER TABLE
    attachments      TEXT DEFAULT '[]', -- added from ALTER TABLE
    created_at       TIMESTAMP DEFAULT NOW(),
    updated_at       TIMESTAMP DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_ledger_customer_id ON ledger_transactions(customer_id);
CREATE INDEX IF NOT EXISTS idx_ledger_business_id ON ledger_transactions(business_id);

COMMIT;