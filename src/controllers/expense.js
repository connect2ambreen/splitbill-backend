import { query, pool } from "../config/db.js";
import { notifyGroupMembers } from "../utils/notifyUsers.js";
import redis from '../config/redis.js';

// ─── Cache helpers ────────────────────────────────────────────────────────────
const bustExpenseCache = async (groupId) => {
  try {
    if (groupId) await redis.del(`expenses:${groupId}`);
  } catch (e) {
    console.error('Redis bust error (expenses):', e);
  }
};

// ─── Helper: get user name ────────────────────────────────────────────────────
const getActorName = async (userId) => {
  const result = await query(`SELECT name FROM users WHERE id = $1`, [userId]);
  return result.rows[0]?.name ?? 'Someone';
};

// ─── Group Balance ────────────────────────────────────────────────────────────
export const getGroupBalance = async (req, res) => {
  try {
    const { group_id } = req.params;
    const { rows } = await query(
      `SELECT u.name AS user_name, SUM(es.paid_share - es.owed_share) AS balance
       FROM expense_shares es
       JOIN expenses e ON es.expense_id = e.id
       JOIN users u ON es.user_id = u.id
       WHERE e.group_id = $1
       GROUP BY u.name ORDER BY u.name`,
      [group_id]
    );
    const data = rows.map(r => ({ user_name: r.user_name, balance: Number(r.balance).toFixed(2) + ' USD' }));
    return res.json({ success: true, data });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ success: false, message: 'Server error' });
  }
};

// ─── Expense Details ──────────────────────────────────────────────────────────
export const getExpenseDetails = async (req, res) => {
  try {
    const expenseId = parseInt(req.params.expense_id, 10);  // Parse to integer
    if (isNaN(expenseId)) {
      return res.status(400).json({ success: false, message: 'Invalid expense ID' });
    }

    const result = await query(
      'SELECT * FROM expenses WHERE id = $1',
      [expenseId]  // Use the parsed integer
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, message: 'Expense not found' });
    }

    const splitsResult = await query(`
      SELECT es.user_id, es.owed_share, es.paid_share, u.name as user_name, u.email as user_email
      FROM expense_shares es
      JOIN users u ON es.user_id = u.id
      WHERE es.expense_id = $1 ORDER BY es.user_id
    `, [expenseId]);

    res.json({ success: true, data: { ...result.rows[0], splits: splitsResult.rows } });
  } catch (error) {
    console.error('Get expense details error:', error);
    res.status(500).json({ success: false, message: 'Server error while fetching expense details' });
  }
};

// ─── Get Pending Settlements ──────────────────────────────────────────────────
export const getPendingSettlements = async (req, res) => {
  try {
    const userId = req.user.userId;
    const result = await query(`
      SELECT s.*, u.name as payer_name
      FROM settlements s
      JOIN users u ON s.payer_user_id = u.id
      WHERE s.payee_user_id = $1 AND s.status = 'pending'
      ORDER BY s.created_at DESC
    `, [userId]);
    res.json({ success: true, data: result.rows });
  } catch (err) {
    console.error('Get pending settlements error:', err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
};

// ─── Get Settlement Detail ────────────────────────────────────────────────────
export const getSettlementDetail = async (req, res) => {
  try {
    const { settlement_id } = req.params;
    const result = await query(`
      SELECT s.*,
             payer.name  AS payer_name,
             payer.email AS payer_email,
             payee.name  AS payee_name,
             payee.email AS payee_email
      FROM settlements s
      JOIN users payer ON s.payer_user_id = payer.id
      JOIN users payee ON s.payee_user_id = payee.id
      WHERE s.id = $1
    `, [settlement_id]);

    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, message: 'Settlement not found' });
    }

    res.json({ success: true, data: result.rows[0] });
  } catch (err) {
    console.error('Get settlement detail error:', err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
};

// ─── Respond to Settlement ────────────────────────────────────────────────────
export const respondToSettlement = async (req, res) => {
  try {
    const { settlement_id } = req.params;
    const { action } = req.body;
    const approverUserId = req.user.userId;

    const settlementRes = await query(`SELECT * FROM settlements WHERE id = $1`, [settlement_id]);
    if (settlementRes.rows.length === 0) {
      return res.status(404).json({ success: false, message: 'Settlement not found' });
    }

    const settlement = settlementRes.rows[0];

    if (String(settlement.payee_user_id) !== String(approverUserId)) {
      return res.status(403).json({
        success: false,
        message: 'Only the person who originally paid the expense can approve this settlement.'
      });
    }

    if (settlement.status !== 'pending') {
      return res.status(400).json({ success: false, message: `Settlement is already ${settlement.status}` });
    }

    const newStatus = action === 'approve' ? 'approved' : 'rejected';

    await query(
      `UPDATE settlements SET status=$1, approved_by=$2, approved_at=CURRENT_TIMESTAMP, updated_at=NOW() WHERE id=$3`,
      [newStatus, approverUserId, settlement_id]
    );

    if (newStatus === 'approved' && settlement.expense_id) {

      await query(
        `UPDATE expense_shares SET paid_share = paid_share + $1 WHERE expense_id = $2 AND user_id = $3`,
        [settlement.amount, settlement.expense_id, settlement.payer_user_id]
      );

      const shareRes = await query(
        `SELECT owed_share, paid_share FROM expense_shares WHERE expense_id = $1 AND user_id = $2`,
        [settlement.expense_id, settlement.payer_user_id]
      );

      if (shareRes.rows.length > 0) {
        const { owed_share, paid_share } = shareRes.rows[0];
        const overpay = parseFloat(paid_share) - parseFloat(owed_share);

        if (overpay > 0) {
          const otherExpenses = await query(
            `SELECT es.expense_id, es.owed_share, es.paid_share
             FROM expense_shares es
             JOIN expenses e ON es.expense_id = e.id
             WHERE es.user_id = $1
               AND e.group_id = $2
               AND e.id != $3
               AND e.is_deleted = false
               AND es.owed_share > es.paid_share
             ORDER BY e.created_at ASC`,
            [settlement.payer_user_id, settlement.group_id, settlement.expense_id]
          );

          let remaining = overpay;
          for (const row of otherExpenses.rows) {
            if (remaining <= 0) break;
            const stillOwed = parseFloat(row.owed_share) - parseFloat(row.paid_share);
            const toApply = Math.min(remaining, stillOwed);
            await query(
              `UPDATE expense_shares SET paid_share = paid_share + $1 WHERE expense_id = $2 AND user_id = $3`,
              [toApply, row.expense_id, settlement.payer_user_id]
            );
            remaining -= toApply;
          }
        }
      }

      // Bust expense cache for the group
      await bustExpenseCache(settlement.group_id);
    }

    await query(
      `INSERT INTO activities (group_id, user_id, activity_type, description, amount, currency)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [settlement.group_id, approverUserId, `settlement_${newStatus}`,
      `${newStatus} settlement of $${settlement.amount}`, settlement.amount, 'USD']
    );

    try {
      const actorName = await getActorName(approverUserId);
      await notifyGroupMembers({
        group_id: settlement.group_id,
        actor_user_id: approverUserId,
        type: `settlement_${newStatus}`,
        title: newStatus === 'approved' ? '✅ Settlement Approved' : '❌ Settlement Rejected',
        message: `${actorName} ${newStatus} a settlement of $${settlement.amount}`,
        related_expense_id: settlement.expense_id || null,
        related_settlement_id: settlement_id,
      });
    } catch (notifyError) {
      console.error('Notification failed (respondToSettlement):', notifyError);
    }

    res.json({ success: true, message: `Settlement ${newStatus}` });
  } catch (error) {
    console.error('Error responding to settlement:', error);
    res.status(500).json({ success: false, message: 'Server error while responding to settlement.' });
  }
};

// ─── Add Expense ──────────────────────────────────────────────────────────────
export const addExpense = async (req, res) => {
  try {
    const { group_id } = req.params;
    const { description, total_amount, split_type, paid_by, divided_on, currency, category_id } = req.body;

    let dbSplitType = split_type;
    if (split_type === 'percentage') dbSplitType = 'percent';
    else if (split_type === 'fixed') dbSplitType = 'exact';

    const expenseResult = await query(
      `INSERT INTO expenses (group_id, description, total_amount, split_type, paid_by, currency, category_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
      [group_id, description, total_amount, dbSplitType, paid_by, currency || 'USD', category_id]
    );

    const expenseId = expenseResult.rows[0].id;
    let owedShares = [];

    if (split_type === 'equal') {
      const equalShare = total_amount / divided_on.length;
      owedShares = divided_on.map(item => ({
        user_id: typeof item === 'object' ? item.user_id : item,
        owed_share: equalShare,
        paid_share: (typeof item === 'object' ? item.user_id : item) === paid_by ? total_amount : 0
      }));
    } else if (split_type === 'percentage' || split_type === 'fixed') {
      owedShares = divided_on.map(item => ({
        user_id: item.user_id,
        owed_share: item.amount,
        paid_share: item.user_id === paid_by ? total_amount : 0
      }));
    } else {
      return res.status(400).json({ success: false, message: 'Invalid split_type.' });
    }

    for (const share of owedShares) {
      await query(
        `INSERT INTO expense_shares (expense_id, user_id, owed_share, paid_share) VALUES ($1, $2, $3, $4)`,
        [expenseId, share.user_id, share.owed_share, share.paid_share]
      );
    }

    await query(
      `INSERT INTO activities (group_id, user_id, activity_type, description, amount, currency, related_expense_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [group_id, req.user.userId, 'expense_added', `Added expense: ${description}`, total_amount, currency || 'USD', expenseId]
    );

    await bustExpenseCache(group_id);

    try {
      const actorName = await getActorName(req.user.userId);
      await notifyGroupMembers({
        group_id,
        actor_user_id: req.user.userId,
        type: 'expense_added',
        title: '💸 New Expense Added',
        message: `${actorName} added "${description}" for $${total_amount}`,
        related_expense_id: expenseId,
      });
    } catch (notifyError) {
      console.error('Notification failed (addExpense):', notifyError);
    }

    res.status(201).json({ success: true, message: 'Expense added successfully', data: { expenseId } });
  } catch (error) {
    console.error('Error adding expense:', error);
    res.status(500).json({ success: false, message: 'Server error while adding expense' });
  }
};

// ─── Get Expenses By User (not cached — cross-group, invalidation too complex) ─
export const getExpensesByUser = async (req, res) => {
  try {
    const { user_id } = req.params;
    const result = await query(
      `SELECT e.id AS expense_id, e.description, e.total_amount, e.currency, e.paid_by, e.category_id,
              es.user_id AS shared_with, es.owed_share, es.paid_share, e.created_at, ec.name AS category_name
       FROM expenses e
       LEFT JOIN expense_shares es ON e.id = es.expense_id
       LEFT JOIN expense_categories ec ON e.category_id = ec.id
       WHERE e.paid_by = $1 OR es.user_id = $1
       ORDER BY e.created_at DESC`,
      [user_id]
    );
    res.json({ success: true, data: result.rows });
  } catch (error) {
    console.error('Error fetching user expenses:', error);
    res.status(500).json({ success: false, message: 'Server error while fetching user expenses' });
  }
};

// ─── Get Expenses By Group (cached) ──────────────────────────────────────────
export const getExpensesByGroup = async (req, res) => {
  try {
    const { group_id } = req.params;
    const cacheKey = `expenses:${group_id}`;

    try {
      const cached = await redis.get(cacheKey);
      if (cached) {
        return res.json({ success: true, data: cached, fromCache: true });
      }
    } catch (e) {
      console.error('Redis get error (getExpensesByGroup):', e);
    }

    const result = await query(
      `SELECT e.id, e.description, e.total_amount AS amount, e.currency, e.paid_by,
              u.name AS paid_by_name, e.category_id, e.created_at AS date,
              ec.name AS category_name, e.is_deleted
       FROM expenses e
       LEFT JOIN users u ON e.paid_by = u.id
       LEFT JOIN expense_categories ec ON e.category_id = ec.id
       WHERE e.group_id = $1 AND e.is_deleted = false
       ORDER BY e.created_at DESC`,
      [group_id]
    );

    try {
      await redis.set(cacheKey, result.rows, { ex: 30 });
    } catch (e) {
      console.error('Redis set error (getExpensesByGroup):', e);
    }

    res.json({ success: true, data: result.rows });
  } catch (error) {
    console.error('Error fetching group expenses:', error);
    res.status(500).json({ success: false, message: 'Server error while fetching group expenses' });
  }
};

// ─── Delete Expense ───────────────────────────────────────────────────────────
export const deleteExpense = async (req, res) => {
  try {
    const expenseId = req.params.expense_id || req.params.id;
    const requesterId = req.user.userId;

    if (!expenseId) return res.status(400).json({ success: false, message: 'Expense ID is required' });

    const { rows } = await query(
      `SELECT group_id, paid_by, description FROM expenses WHERE id = $1 AND is_deleted = false`,
      [expenseId]
    );
    if (rows.length === 0) return res.status(404).json({ success: false, message: 'Expense not found or already deleted.' });
    if (rows[0].paid_by !== requesterId) return res.status(403).json({ success: false, message: 'Only the payer can delete this expense.' });

    const groupId = rows[0].group_id;
    const expenseDescription = rows[0].description;

    await query(`UPDATE expenses SET is_deleted = true, updated_at = NOW() WHERE id = $1`, [expenseId]);

    await bustExpenseCache(groupId);

    try {
      const actorName = await getActorName(requesterId);
      await notifyGroupMembers({
        group_id: groupId,
        actor_user_id: requesterId,
        type: 'expense_deleted',
        title: '🗑️ Expense Deleted',
        message: `${actorName} deleted "${expenseDescription}" from the group`,
        related_expense_id: expenseId,
      });
    } catch (notifyError) {
      console.error('Notification failed (deleteExpense):', notifyError);
    }

    res.json({ success: true, message: 'Expense deleted successfully' });
  } catch (err) {
    console.error('Error deleting expense:', err);
    res.status(500).json({ success: false, message: 'Server error while deleting expense' });
  }
};

// ─── Update Expense ───────────────────────────────────────────────────────────
export const updateExpense = async (req, res) => {
  try {
    const { expense_id } = req.params;
    const { description, total_amount, currency, category_id } = req.body;
    const requesterId = req.user.userId;

    const { rows } = await query(
      `SELECT paid_by, group_id FROM expenses WHERE id = $1 AND is_deleted = false`, [expense_id]
    );
    if (rows.length === 0) return res.status(404).json({ success: false, message: 'Expense not found.' });
    if (rows[0].paid_by !== requesterId) return res.status(403).json({ success: false, message: 'Only the payer can update this expense.' });

    const groupId = rows[0].group_id;

    await query(
      `UPDATE expenses SET description=$1, total_amount=$2, currency=$3, category_id=$4, updated_at=NOW() WHERE id=$5`,
      [description, total_amount, currency || 'USD', category_id, expense_id]
    );

    await bustExpenseCache(groupId);

    try {
      const actorName = await getActorName(requesterId);
      await notifyGroupMembers({
        group_id: groupId,
        actor_user_id: requesterId,
        type: 'expense_updated',
        title: '✏️ Expense Updated',
        message: `${actorName} updated "${description}" to $${total_amount}`,
        related_expense_id: expense_id,
      });
    } catch (notifyError) {
      console.error('Notification failed (updateExpense):', notifyError);
    }

    res.json({ success: true, message: 'Expense updated successfully' });
  } catch (err) {
    console.error('Error updating expense:', err);
    res.status(500).json({ success: false, message: 'Server error while updating expense' });
  }
};

// ─── Request Settlement ───────────────────────────────────────────────────────
export const requestSettlement = async (req, res) => {
  try {
    const { group_id } = req.params;
    const { payer_user_id, payee_user_id, amount, notes, payment_method, expense_id } = req.body;

    if (!payer_user_id || !payee_user_id || !amount) {
      return res.status(400).json({ success: false, message: 'payer_user_id, payee_user_id and amount are required' });
    }

    if (expense_id) {
      const expenseCheck = await query(`SELECT paid_by FROM expenses WHERE id = $1`, [expense_id]);
      if (expenseCheck.rows.length > 0 && String(expenseCheck.rows[0].paid_by) === String(payer_user_id)) {
        return res.status(403).json({ success: false, message: 'You paid this expense. You can only approve settlements, not send them.' });
      }
    }

    const duplicate = await query(
      `SELECT id FROM settlements WHERE payer_user_id = $1 AND payee_user_id = $2 AND expense_id = $3 AND status = 'pending'`,
      [payer_user_id, payee_user_id, expense_id || null]
    );
    if (duplicate.rows.length > 0) {
      return res.status(400).json({ success: false, message: 'You already have a pending settlement request for this expense.' });
    }

    const result = await query(
      `INSERT INTO settlements (group_id, payer_user_id, payee_user_id, amount, notes, payment_method, status, expense_id)
       VALUES ($1, $2, $3, $4, $5, $6, 'pending', $7) RETURNING id`,
      [group_id, payer_user_id, payee_user_id, amount, notes, payment_method || 'online', expense_id || null]
    );

    const settlementId = result.rows[0].id;

    await query(
      `INSERT INTO activities (group_id, user_id, activity_type, description, amount, currency)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [group_id, payer_user_id, 'settlement_requested', `Requested settlement with user ${payee_user_id}`, amount, 'USD']
    );

    // Bust expense cache since settlement changes the balance picture
    await bustExpenseCache(group_id);

    try {
      const actorName = await getActorName(req.user.userId);
      await notifyGroupMembers({
        group_id,
        actor_user_id: req.user.userId,
        type: 'settlement_requested',
        title: '🤝 Settlement Requested',
        message: `${actorName} wants to settle $${amount}`,
        related_expense_id: null,
        related_settlement_id: settlementId,
      });
    } catch (notifyError) {
      console.error('Notification failed (requestSettlement):', notifyError);
    }

    res.status(201).json({ success: true, message: 'Settlement request sent', data: { settlementId } });
  } catch (error) {
    console.error('Settlement request failed:', error);
    res.status(500).json({ success: false, message: 'Error requesting settlement' });
  }
};

// ─── Get Notifications ────────────────────────────────────────────────────────
export const getNotifications = async (req, res) => {
  const client = await pool.connect();
  try {
    const userId = req.user.userId;

    await client.query('BEGIN');

    await client.query(
      `UPDATE notifications SET is_read = true WHERE user_id = $1`,
      [userId]
    );

    const result = await client.query(`
      SELECT n.*, g.name as group_name
      FROM notifications n
      LEFT JOIN groups g ON n.group_id = g.id
      WHERE n.user_id = $1
      ORDER BY n.created_at DESC
      LIMIT 50
    `, [userId]);

    await client.query('COMMIT');

    res.json({ success: true, data: result.rows });

  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Get notifications error:', err);
    res.status(500).json({ success: false, message: 'Server error' });
  } finally {
    client.release();
  }
};

// ─── Mark Notifications Read ──────────────────────────────────────────────────
export const markNotificationsRead = async (req, res) => {
  try {
    const userId = req.user.userId;
    await query(`UPDATE notifications SET is_read = true WHERE user_id = $1`, [userId]);
    res.json({ success: true });
  } catch (err) {
    console.error('Mark notifications read error:', err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
};