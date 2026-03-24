import { query } from '../config/db.js';

// ── helpers ───────────────────────────────────────────────────────────────────

// verify business belongs to user and return business_id
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

// ── Get all customers (with balance) ─────────────────────────────────────────
export const getCustomers = async (req, res) => {
  try {
    const userId = req.user?.userId;
    if (!userId) return res.status(401).json({ success: false, message: 'Unauthorized' });

    const businessId = await getBusinessId(userId);
    if (!businessId) {
      return res.status(404).json({ success: false, message: 'No business found. Please create a business first.' });
    }

    const result = await query(
      `SELECT
        c.id,
        c.name,
        c.phone,
        c.address,
        c.notes,
        c.created_at,
        -- gave = customer owes you (positive), got = you owe customer (negative)
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

    // overall summary
    const totalOweMe = result.rows
      .filter(r => parseFloat(r.balance) > 0)
      .reduce((sum, r) => sum + parseFloat(r.balance), 0);

    const totalIOwe = result.rows
      .filter(r => parseFloat(r.balance) < 0)
      .reduce((sum, r) => sum + Math.abs(parseFloat(r.balance)), 0);

    res.json({
      success: true,
      data: result.rows.map(r => ({
        ...r,
        total_gave: parseFloat(r.total_gave).toFixed(2),
        total_got: parseFloat(r.total_got).toFixed(2),
        balance: parseFloat(r.balance).toFixed(2),
      })),
      summary: {
        total_customers: result.rows.length,
        total_owe_me: parseFloat(totalOweMe).toFixed(2),   // customers owe you
        total_i_owe: parseFloat(totalIOwe).toFixed(2),    // you owe customers
        net_balance: parseFloat(totalOweMe - totalIOwe).toFixed(2),
      },
    });
  } catch (error) {
    console.error('Get customers error:', error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
};

// ── Create customer ───────────────────────────────────────────────────────────
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

// ── Update customer ───────────────────────────────────────────────────────────
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

// ── Delete customer (soft) ────────────────────────────────────────────────────
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

    res.json({ success: true, message: 'Customer deleted successfully' });
  } catch (error) {
    console.error('Delete customer error:', error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
};

// ═════════════════════════════════════════════════════════════════════════════
//  LEDGER TRANSACTIONS
// ═════════════════════════════════════════════════════════════════════════════

// ── Get all transactions for a customer ──────────────────────────────────────
export const getTransactions = async (req, res) => {
  try {
    const userId = req.user?.userId;
    if (!userId) return res.status(401).json({ success: false, message: 'Unauthorized' });

    const { customer_id } = req.params;

    // verify customer belongs to this user
    const check = await query(
      'SELECT id FROM customers WHERE id = $1 AND user_id = $2 AND is_active = true',
      [customer_id, userId]
    );
    if (check.rows.length === 0) {
      return res.status(404).json({ success: false, message: 'Customer not found' });
    }

    const result = await query(
      `SELECT * FROM ledger_transactions
       WHERE customer_id = $1
       ORDER BY created_at DESC`,
      [customer_id]
    );

    // running balance (latest first, so we calculate from oldest)
    const rows = [...result.rows].reverse();
    let running = 0;
    const withBalance = rows.map(r => {
      running += r.type === 'gave' ? parseFloat(r.amount) : -parseFloat(r.amount);
      return { ...r, amount: parseFloat(r.amount).toFixed(2), running_balance: running.toFixed(2) };
    });

    res.json({
      success: true,
      data: withBalance.reverse(), // back to latest first
    });
  } catch (error) {
    console.error('Get transactions error:', error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
};

// ── Add transaction ───────────────────────────────────────────────────────────
export const addTransaction = async (req, res) => {
  try {
    const userId = req.user?.userId;
    if (!userId) return res.status(401).json({ success: false, message: 'Unauthorized' });

    const { customer_id } = req.params;
    const { type, amount, note } = req.body;

    if (!['gave', 'got'].includes(type)) {
      return res.status(400).json({ success: false, message: "Type must be 'gave' or 'got'" });
    }
    if (!amount || parseFloat(amount) <= 0) {
      return res.status(400).json({ success: false, message: 'Amount must be greater than 0' });
    }

    // verify customer belongs to this user
    const check = await query(
      'SELECT id, business_id FROM customers WHERE id = $1 AND user_id = $2 AND is_active = true',
      [customer_id, userId]
    );
    if (check.rows.length === 0) {
      return res.status(404).json({ success: false, message: 'Customer not found' });
    }

    const businessId = check.rows[0].business_id;

    const result = await query(
      `INSERT INTO ledger_transactions (business_id, customer_id, user_id, type, amount, note)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
      [businessId, customer_id, userId, type, parseFloat(amount), note || null]
    );

    res.status(201).json({
      success: true,
      message: type === 'gave' ? 'Gave entry added' : 'Got entry added',
      data: { ...result.rows[0], amount: parseFloat(result.rows[0].amount).toFixed(2) },
    });
  } catch (error) {
    console.error('Add transaction error:', error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
};

// ── Delete transaction ────────────────────────────────────────────────────────
export const deleteTransaction = async (req, res) => {
  try {
    const userId = req.user?.userId;
    if (!userId) return res.status(401).json({ success: false, message: 'Unauthorized' });

    const { transaction_id } = req.params;

    const check = await query(
      'SELECT id FROM ledger_transactions WHERE id = $1 AND user_id = $2',
      [transaction_id, userId]
    );
    if (check.rows.length === 0) {
      return res.status(404).json({ success: false, message: 'Transaction not found' });
    }

    await query('DELETE FROM ledger_transactions WHERE id = $1', [transaction_id]);

    res.json({ success: true, message: 'Transaction deleted successfully' });
  } catch (error) {
    console.error('Delete transaction error:', error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
};