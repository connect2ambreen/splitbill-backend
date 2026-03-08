// controllers/user.js
import { query } from '../config/db.js';

export const updateUserProfile = async (req, res) => {
  try {
    const userId = req.params.id;
    const { name, email, phone } = req.body;

    if (!name?.trim()) {
      return res.status(400).json({ success: false, message: 'Name is required.' });
    }

    if (email) {
      const existing = await query(
        'SELECT id FROM users WHERE email = $1 AND id != $2',
        [email.trim().toLowerCase(), userId]
      );
      if (existing.rows.length > 0) {
        return res.status(400).json({ success: false, message: 'Email already in use.' });
      }
    }

    const result = await query(
      `UPDATE users 
       SET name = $1, email = $2, phone = $3, updated_at = NOW()
       WHERE id = $4
       RETURNING id, name, email, phone, locale, profile_url, created_at, updated_at`,
      [name.trim(), email?.trim().toLowerCase(), phone?.trim() || null, userId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, message: 'User not found.' });
    }

    res.json({ success: true, message: 'Profile updated.', data: result.rows[0] });

  } catch (error) {
    console.error('Update profile error:', error);
    res.status(500).json({ success: false, message: 'Server error.' });
  }
};

export const updateLocale = async (req, res) => {
  try {
    const userId = req.user.userId; // ✅ was req.user.id — your middleware uses userId
    const { country, language, currency, currencySymbol, flag } = req.body;

    console.log('📍 updateLocale called, userId:', userId, 'body:', req.body);

    if (!country || !currency) {
      return res.status(400).json({ success: false, message: 'country and currency are required.' });
    }

    const newLocale = { country, language, currency, currencySymbol, flag };

    const result = await query(
      `UPDATE users SET locale = $1, updated_at = NOW()
       WHERE id = $2
       RETURNING id, name, email, locale`,
      [JSON.stringify(newLocale), userId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, message: 'User not found.' });
    }

    res.json({ success: true, message: 'Locale updated.', data: result.rows[0] });

  } catch (error) {
    console.error('Locale update error:', error);
    res.status(500).json({ success: false, message: 'Server error.' });
  }
};


export const saveFcmToken = async (req, res) => {
  const { fcm_token } = req.body;
  const user_id = req.user?.userId;

  console.log('📱 [FCM] Body received:', req.body);
  console.log('📱 [FCM] User from token:', req.user);
  console.log('📱 [FCM] user_id:', user_id);
  console.log('📱 [FCM] fcm_token:', fcm_token);

  if (!user_id) {
    console.error('📱 [FCM] ❌ No user_id found in request');
    return res.status(401).json({ error: 'No user ID found' });
  }

  if (!fcm_token) {
    console.error('📱 [FCM] ❌ No fcm_token in body');
    return res.status(400).json({ error: 'No FCM token provided' });
  }

  try {
    const result = await query(
      `UPDATE users SET fcm_token = $1 WHERE id = $2 RETURNING id, fcm_token`,
      [fcm_token, user_id]
    );

    console.log('📱 [FCM] DB update result:', result.rows);
    console.log('📱 [FCM] Rows affected:', result.rowCount);

    if (result.rowCount === 0) {
      console.error('📱 [FCM] ❌ No rows updated — user_id not found in DB:', user_id);
      return res.status(404).json({ error: 'User not found' });
    }

    res.json({ success: true });
  } catch (error) {
    console.error('📱 [FCM] ❌ DB error:', error);
    res.status(500).json({ error: 'Failed to save token' });
  }
};