import { query } from '../config/db.js';

// ── Create business (one per user) ──────────────────────────────────────────
export const createBusiness = async (req, res) => {
  try {
    const userId = req.user?.userId;
    if (!userId) return res.status(401).json({ success: false, message: 'Unauthorized' });

    const { name, business_type, phone, address, currency } = req.body;

    if (!name?.trim()) {
      return res.status(400).json({ success: false, message: 'Business name is required' });
    }

    // One business per user check
    const existing = await query(
      'SELECT id FROM businesses WHERE user_id = $1 AND is_active = true',
      [userId]
    );
    if (existing.rows.length > 0) {
      return res.status(400).json({
        success: false,
        message: 'You already have a business. Please edit your existing one.',
      });
    }

    const result = await query(
      `INSERT INTO businesses (user_id, name, business_type, phone, address, currency)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
      [
        userId,
        name.trim(),
        business_type || 'other',
        phone || null,
        address || null,
        currency || 'PKR',
      ]
    );

    res.status(201).json({
      success: true,
      message: 'Business created successfully',
      data: result.rows[0],
    });
  } catch (error) {
    console.error('Create business error:', error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
};

// ── Get user's business ──────────────────────────────────────────────────────
export const getUserBusiness = async (req, res) => {
  try {
    const userId = req.user?.userId;
    if (!userId) return res.status(401).json({ success: false, message: 'Unauthorized' });

    console.log("REQ USER:", req.user);
    console.log("USER ID:", userId);

    const result = await query(
      'SELECT * FROM businesses WHERE user_id = $1 AND is_active = true',
      [userId]
    );

    res.json({
      success: true,
      data: result.rows[0] || null,
    });
  } catch (error) {
    console.error("Get user business error:", error); // 👈 IMPORTANT
    res.status(500).json({
      success: false,
      message: "Server error while fetching business details",
    });
  }
};

// ── Update business ──────────────────────────────────────────────────────────
export const updateBusiness = async (req, res) => {
  try {
    const userId = req.user?.userId;
    if (!userId) return res.status(401).json({ success: false, message: 'Unauthorized' });

    const { business_id } = req.params;
    const { name, business_type, phone, address, currency } = req.body;

    if (!name?.trim()) {
      return res.status(400).json({ success: false, message: 'Business name is required' });
    }

    const check = await query(
      'SELECT id FROM businesses WHERE id = $1 AND user_id = $2 AND is_active = true',
      [business_id, userId]
    );
    if (check.rows.length === 0) {
      return res.status(404).json({ success: false, message: 'Business not found' });
    }

    const result = await query(
      `UPDATE businesses
       SET name = $1, business_type = $2, phone = $3, address = $4, currency = $5, updated_at = NOW()
       WHERE id = $6 AND user_id = $7
       RETURNING *`,
      [
        name.trim(),
        business_type || 'other',
        phone || null,
        address || null,
        currency || 'PKR',
        business_id,
        userId,
      ]
    );

    res.json({
      success: true,
      message: 'Business updated successfully',
      data: result.rows[0],
    });
  } catch (error) {
    console.error('Update business error:', error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
};

// ── Delete business (soft delete) ────────────────────────────────────────────
export const deleteBusiness = async (req, res) => {
  try {
    const userId = req.user?.userId;
    if (!userId) return res.status(401).json({ success: false, message: 'Unauthorized' });

    const { business_id } = req.params;

    const check = await query(
      'SELECT id FROM businesses WHERE id = $1 AND user_id = $2 AND is_active = true',
      [business_id, userId]
    );
    if (check.rows.length === 0) {
      return res.status(404).json({ success: false, message: 'Business not found' });
    }

    await query(
      'UPDATE businesses SET is_active = false WHERE id = $1 AND user_id = $2',
      [business_id, userId]
    );

    res.json({ success: true, message: 'Business deleted successfully' });
  } catch (error) {
    console.error('Delete business error:', error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
};