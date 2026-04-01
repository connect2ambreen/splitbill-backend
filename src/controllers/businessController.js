import { query } from '../config/db.js';
import redis from '../config/redis.js';

// ── Cache key helper ─────────────────────────────────────────────────────────
const businessKey = (userId) => `business:${userId}`;

// ── Create business (one per user) ──────────────────────────────────────────
export const createBusiness = async (req, res) => {
  try {
    const userId = req.user?.userId;
    if (!userId) return res.status(401).json({ success: false, message: 'Unauthorized' });

    const { name, business_type, phone, address, currency } = req.body;

    if (!name?.trim()) {
      return res.status(400).json({ success: false, message: 'Business name is required' });
    }

    // Upsert — handles both fresh create and re-create after soft delete
    const result = await query(
      `INSERT INTO businesses (user_id, name, business_type, phone, address, currency)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (user_id) DO UPDATE
         SET name          = EXCLUDED.name,
             business_type = EXCLUDED.business_type,
             phone         = EXCLUDED.phone,
             address       = EXCLUDED.address,
             currency      = EXCLUDED.currency,
             is_active     = true,
             updated_at    = NOW()
       RETURNING *, (xmax = 0) AS was_inserted`,
      [
        userId,
        name.trim(),
        business_type || 'other',
        phone || null,
        address || null,
        currency || 'PKR',
      ]
    );

    const business = result.rows[0];
    const isNew = business.was_inserted;

    // Bust cache so next GET fetches fresh data
    await redis.del(businessKey(userId));

    res.status(isNew ? 201 : 200).json({
      success: true,
      message: isNew ? 'Business created successfully' : 'Business restored successfully',
      data: business,
    });
  } catch (error) {
    console.error('Create business error:', error);
    res.status(500).json({ success: false, message: error.message });
  }
};

// ── Get user's business ──────────────────────────────────────────────────────
export const getUserBusiness = async (req, res) => {
  try {
    const userId = req.user?.userId;
    if (!userId) return res.status(401).json({ success: false, message: 'Unauthorized' });

    const cacheKey = businessKey(userId);

    // 1. Check Redis first
    const cached = await redis.get(cacheKey);
    if (cached) {
      return res.json({ success: true, data: cached });
    }

    // 2. Cache miss — hit Postgres
    const result = await query(
      'SELECT * FROM businesses WHERE user_id = $1 AND is_active = true',
      [userId]
    );

    const data = result.rows[0] || null;

    // 3. Store in Redis for 5 minutes
    await redis.set(cacheKey, data, { ex: 300 });

    res.json({ success: true, data });
  } catch (error) {
    console.error('Get user business error:', error);
    res.status(500).json({ success: false, message: 'Server error while fetching business details' });
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

    // Bust cache
    await redis.del(businessKey(userId));

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

// ── Delete business ──────────────────────────────────────────────────────────
export const deleteBusiness = async (req, res) => {
  try {
    const userId = req.user?.userId;
    if (!userId) return res.status(401).json({ success: false, message: 'Unauthorized' });

    const { business_id } = req.params;

    const result = await query(
      'DELETE FROM businesses WHERE id = $1 AND user_id = $2 RETURNING id',
      [business_id, userId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, message: 'Business not found' });
    }

    // Bust cache
    await redis.del(businessKey(userId));

    res.json({ success: true, message: 'Business deleted successfully' });
  } catch (error) {
    console.error('Delete business error:', error);
    res.status(500).json({ success: false, message: error.message });
  }
};