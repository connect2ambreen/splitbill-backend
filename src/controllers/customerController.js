import { query } from '../config/db.js';
import cloudinary from 'cloudinary';
import { v4 as uuidv4 } from 'uuid';
import redis from '../config/redis.js';

cloudinary.v2.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
});

// ── Cache key helpers ────────────────────────────────────────────────────────
const customersKey = (userId) => `customers:${userId}`;
const transactionsKey = (customerId) => `transactions:${customerId}`;

// ── Upload URL ───────────────────────────────────────────────────────────────
export const getUploadUrl = async (req, res) => {
  try {
    const { type, ext } = req.query;
    if (!type || !ext) {
      return res.status(400).json({ success: false, message: 'type and ext are required' });
    }

    const public_id = `attachments/${uuidv4()}`;

    return res.json({
      success: true,
      uploadUrl: null,
      fileUrl: null,
      cloudinary: {
        url: 'https://api.cloudinary.com/v1_1/' + process.env.CLOUDINARY_CLOUD_NAME + '/auto/upload',
        upload_preset: process.env.CLOUDINARY_UPLOAD_PRESET,
        folder: process.env.CLOUDINARY_UPLOAD_FOLDER || 'splitbill',
        public_id,
      },
    });
  } catch (err) {
    console.error('Get upload URL error:', err);
    res.status(500).json({ success: false, message: err.message });
  }
};

// ── Delete Cloudinary asset ──────────────────────────────────────────────────
export const deleteCloudinaryAsset = async (req, res) => {
  try {
    const userId = req.user?.userId;
    if (!userId) return res.status(401).json({ success: false, message: 'Unauthorized' });

    const { public_id } = req.body;
    if (!public_id) {
      return res.status(400).json({ success: false, message: 'public_id is required' });
    }

    const result = await cloudinary.v2.uploader.destroy(public_id, {
      invalidate: true,
      resource_type: 'auto',
    });

    if (result.result === 'ok' || result.result === 'not found') {
      return res.json({ success: true, result: result.result });
    }

    return res.status(500).json({ success: false, message: `Cloudinary returned: ${result.result}` });
  } catch (err) {
    console.error('Delete Cloudinary asset error:', err);
    res.status(500).json({ success: false, message: err.message });
  }
};

// ── Helper: get business ID for user ────────────────────────────────────────
async function getBusinessId(userId) {
  const result = await query(
    'SELECT id FROM businesses WHERE user_id = $1 AND is_active = true',
    [userId]
  );
  return result.rows[0]?.id || null;
}

// ═════════════════════════════════════════════════════════════════════════════
//  CUSTOMERS
// ═════════════════════════════════════════════════════════════════════════════

export const getCustomers = async (req, res) => {
  try {
    const userId = req.user?.userId;
    if (!userId) return res.status(401).json({ success: false, message: 'Unauthorized' });

    const businessId = await getBusinessId(userId);
    if (!businessId) {
      return res.status(404).json({ success: false, message: 'No business found. Please create a business first.' });
    }

    const cacheKey = customersKey(userId);

    // 1. Check Redis first
    const cached = await redis.get(cacheKey);
    if (cached) {
      return res.json({ success: true, ...cached });
    }

    // 2. Cache miss — hit Postgres
    const result = await query(
      `SELECT
        c.id,
        c.name,
        c.phone,
        c.address,
        c.notes,
        c.created_at,
        COALESCE(SUM(CASE WHEN lt.type = 'gave' THEN lt.amount ELSE 0 END), 0) AS total_gave,
        COALESCE(SUM(CASE WHEN lt.type = 'got'  THEN lt.amount ELSE 0 END), 0) AS total_got,
        COALESCE(SUM(CASE WHEN lt.type = 'gave' THEN lt.amount ELSE -lt.amount END), 0) AS balance
      FROM customers c
      LEFT JOIN ledger_transactions lt ON lt.customer_id = c.id
      WHERE c.business_id = $1 AND c.is_active = true
      GROUP BY c.id, c.name, c.phone, c.address, c.notes, c.created_at
      ORDER BY c.name ASC`,
      [businessId]
    );

    const totalOweMe = result.rows
      .filter(r => parseFloat(r.balance) > 0)
      .reduce((sum, r) => sum + parseFloat(r.balance), 0);

    const totalIOwe = result.rows
      .filter(r => parseFloat(r.balance) < 0)
      .reduce((sum, r) => sum + Math.abs(parseFloat(r.balance)), 0);

    const data = result.rows.map(r => ({
      ...r,
      total_gave: parseFloat(r.total_gave).toFixed(2),
      total_got: parseFloat(r.total_got).toFixed(2),
      balance: parseFloat(r.balance).toFixed(2),
    }));

    const summary = {
      total_customers: result.rows.length,
      total_owe_me: parseFloat(totalOweMe).toFixed(2),
      total_i_owe: parseFloat(totalIOwe).toFixed(2),
      net_balance: parseFloat(totalOweMe - totalIOwe).toFixed(2),
    };

    // 3. Store in Redis for 60 seconds
    await redis.set(cacheKey, { data, summary }, { ex: 60 });

    res.json({ success: true, data, summary });
  } catch (error) {
    console.error('Get customers error:', error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
};

export const createCustomer = async (req, res) => {
  try {
    const userId = req.user?.userId;
    if (!userId) return res.status(401).json({ success: false, message: 'Unauthorized' });

    const businessId = await getBusinessId(userId);
    if (!businessId) {
      return res.status(404).json({ success: false, message: 'No business found. Please create a business first.' });
    }

    const { name, phone, address, notes } = req.body;

    if (!name?.trim()) {
      return res.status(400).json({ success: false, message: 'Customer name is required' });
    }

    const result = await query(
      `INSERT INTO customers (business_id, user_id, name, phone, address, notes)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
      [businessId, userId, name.trim(), phone || null, address || null, notes || null]
    );

    // Bust customers cache
    await redis.del(customersKey(userId));

    res.status(201).json({
      success: true,
      message: 'Customer added successfully',
      data: result.rows[0],
    });
  } catch (error) {
    console.error('Create customer error:', error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
};

export const updateCustomer = async (req, res) => {
  try {
    const userId = req.user?.userId;
    if (!userId) return res.status(401).json({ success: false, message: 'Unauthorized' });

    const { customer_id } = req.params;
    const { name, phone, address, notes } = req.body;

    if (!name?.trim()) {
      return res.status(400).json({ success: false, message: 'Customer name is required' });
    }

    const check = await query(
      'SELECT id FROM customers WHERE id = $1 AND user_id = $2 AND is_active = true',
      [customer_id, userId]
    );
    if (check.rows.length === 0) {
      return res.status(404).json({ success: false, message: 'Customer not found' });
    }

    const result = await query(
      `UPDATE customers
       SET name = $1, phone = $2, address = $3, notes = $4, updated_at = NOW()
       WHERE id = $5 AND user_id = $6
       RETURNING *`,
      [name.trim(), phone || null, address || null, notes || null, customer_id, userId]
    );

    // Bust customers cache
    await redis.del(customersKey(userId));

    res.json({
      success: true,
      message: 'Customer updated successfully',
      data: result.rows[0],
    });
  } catch (error) {
    console.error('Update customer error:', error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
};

export const deleteCustomer = async (req, res) => {
  try {
    const userId = req.user?.userId;
    if (!userId) return res.status(401).json({ success: false, message: 'Unauthorized' });

    const { customer_id } = req.params;

    const check = await query(
      'SELECT id FROM customers WHERE id = $1 AND user_id = $2 AND is_active = true',
      [customer_id, userId]
    );
    if (check.rows.length === 0) {
      return res.status(404).json({ success: false, message: 'Customer not found' });
    }

    await query(
      'UPDATE customers SET is_active = false WHERE id = $1 AND user_id = $2',
      [customer_id, userId]
    );

    // Bust customers cache
    await redis.del(customersKey(userId));

    res.json({ success: true, message: 'Customer deleted successfully' });
  } catch (error) {
    console.error('Delete customer error:', error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
};

// ═════════════════════════════════════════════════════════════════════════════
//  LEDGER TRANSACTIONS
// ═════════════════════════════════════════════════════════════════════════════

export const getTransactions = async (req, res) => {
  try {
    const userId = req.user?.userId;
    if (!userId) return res.status(401).json({ success: false, message: 'Unauthorized' });

    const { customer_id } = req.params;

    const check = await query(
      'SELECT id FROM customers WHERE id = $1 AND user_id = $2 AND is_active = true',
      [customer_id, userId]
    );
    if (check.rows.length === 0) {
      return res.status(404).json({ success: false, message: 'Customer not found' });
    }

    const cacheKey = transactionsKey(customer_id);

    // 1. Check Redis first
    const cached = await redis.get(cacheKey);
    if (cached) {
      return res.json({ success: true, data: cached });
    }

    // 2. Cache miss — hit Postgres
    const result = await query(
      `SELECT id, customer_id, user_id, business_id, type, amount, note,
              transaction_date, attachments, created_at, updated_at
       FROM ledger_transactions
       WHERE customer_id = $1
       ORDER BY created_at DESC`,
      [customer_id]
    );

    const rows = [...result.rows].reverse();
    let running = 0;
    const withBalance = rows.map(r => {
      running += r.type === 'gave' ? parseFloat(r.amount) : -parseFloat(r.amount);
      return {
        ...r,
        amount: parseFloat(r.amount).toFixed(2),
        running_balance: running.toFixed(2),
        attachments: r.attachments || '[]',
      };
    });

    const data = withBalance.reverse();

    // 3. Store in Redis for 30 seconds
    await redis.set(cacheKey, data, { ex: 30 });

    res.json({ success: true, data });
  } catch (error) {
    console.error('Get transactions error:', error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
};

export const addTransaction = async (req, res) => {
  try {
    const userId = req.user?.userId;
    if (!userId) return res.status(401).json({ success: false, message: 'Unauthorized' });

    const { customer_id } = req.params;
    const { type, amount, note, transaction_date, attachments } = req.body;

    if (!['gave', 'got'].includes(type)) {
      return res.status(400).json({ success: false, message: "Type must be 'gave' or 'got'" });
    }
    if (!amount || parseFloat(amount) <= 0) {
      return res.status(400).json({ success: false, message: 'Amount must be greater than 0' });
    }

    const check = await query(
      'SELECT id, business_id FROM customers WHERE id = $1 AND user_id = $2 AND is_active = true',
      [customer_id, userId]
    );
    if (check.rows.length === 0) {
      return res.status(404).json({ success: false, message: 'Customer not found' });
    }

    const businessId = check.rows[0].business_id;

    const result = await query(
      `INSERT INTO ledger_transactions
        (business_id, customer_id, user_id, type, amount, note, transaction_date, attachments)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       RETURNING *`,
      [
        businessId,
        customer_id,
        userId,
        type,
        parseFloat(amount),
        note || null,
        transaction_date || new Date(),
        attachments || '[]',
      ]
    );

    // Bust both caches — transaction list AND customer balance summary
    await Promise.all([
      redis.del(transactionsKey(customer_id)),
      redis.del(customersKey(userId)),
    ]);

    res.status(201).json({
      success: true,
      message: type === 'gave' ? 'Gave entry added' : 'Got entry added',
      data: {
        ...result.rows[0],
        amount: parseFloat(result.rows[0].amount).toFixed(2),
        attachments: result.rows[0].attachments || '[]',
      },
    });
  } catch (error) {
    console.error('Add transaction error:', error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
};

export const updateTransaction = async (req, res) => {
  try {
    const userId = req.user?.userId;
    if (!userId) return res.status(401).json({ success: false, message: 'Unauthorized' });

    const { transaction_id, customer_id } = req.params;
    const { type, amount, note, transaction_date, attachments } = req.body;

    if (!['gave', 'got'].includes(type)) {
      return res.status(400).json({ success: false, message: "Type must be 'gave' or 'got'" });
    }
    if (!amount || parseFloat(amount) <= 0) {
      return res.status(400).json({ success: false, message: 'Amount must be greater than 0' });
    }

    const check = await query(
      'SELECT id FROM ledger_transactions WHERE id = $1 AND user_id = $2',
      [transaction_id, userId]
    );
    if (check.rows.length === 0) {
      return res.status(404).json({ success: false, message: 'Transaction not found' });
    }

    const result = await query(
      `UPDATE ledger_transactions
       SET type=$1, amount=$2, note=$3, transaction_date=$4, attachments=$5, updated_at=NOW()
       WHERE id=$6 AND user_id=$7
       RETURNING *`,
      [
        type,
        parseFloat(amount),
        note || null,
        transaction_date || new Date(),
        attachments || '[]',
        transaction_id,
        userId,
      ]
    );

    // Bust both caches
    await Promise.all([
      redis.del(transactionsKey(customer_id)),
      redis.del(customersKey(userId)),
    ]);

    res.json({
      success: true,
      message: 'Transaction updated successfully',
      data: {
        ...result.rows[0],
        amount: parseFloat(result.rows[0].amount).toFixed(2),
        attachments: result.rows[0].attachments || '[]',
      },
    });
  } catch (error) {
    console.error('Update transaction error:', error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
};

export const deleteTransaction = async (req, res) => {
  try {
    const userId = req.user?.userId;
    if (!userId) return res.status(401).json({ success: false, message: 'Unauthorized' });

    const { transaction_id, customer_id } = req.params;

    const check = await query(
      'SELECT id FROM ledger_transactions WHERE id = $1 AND user_id = $2',
      [transaction_id, userId]
    );
    if (check.rows.length === 0) {
      return res.status(404).json({ success: false, message: 'Transaction not found' });
    }

    await query('DELETE FROM ledger_transactions WHERE id = $1', [transaction_id]);

    // Bust both caches
    await Promise.all([
      redis.del(transactionsKey(customer_id)),
      redis.del(customersKey(userId)),
    ]);

    res.json({ success: true, message: 'Transaction deleted successfully' });
  } catch (error) {
    console.error('Delete transaction error:', error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
};