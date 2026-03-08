import jwt from 'jsonwebtoken';
import dotenv from 'dotenv';
import { query } from '../config/db.js';
dotenv.config();

export const authenticate = (req, res, next) => {
  const authHeader = req.headers.authorization;

  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ success: false, message: 'No token provided' });
  }

  const token = authHeader.split(' ')[1];

  if (token.split('.').length !== 3) {
    return res.status(401).json({ success: false, message: 'Invalid token format' });
  }

  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET_KEY);
    req.user = {
      userId: decoded?.id || decoded.identity,
      email: decoded.email || null
    };
    console.log('🔐 JWT DECODED:', decoded);
    console.log('✅ req.user set to:', req.user);
    next();
  } catch (error) {
    console.error('Authentication error:', error.message);

    // ✅ Distinguish expired vs invalid
    if (error.name === 'TokenExpiredError') {
      return res.status(401).json({
        success: false,
        message: 'Token expired',
        tokenExpired: true  // frontend checks this flag
      });
    }

    return res.status(401).json({ success: false, message: 'Invalid token' });
  }
};

export const isAdmin = async (req, res, next) => {
  const { group_id } = req.params;
  const userId = req.user.userId;

  if (!group_id) {
    return res.status(400).json({ message: 'Group ID is required in the URL.' });
  }

  try {
    const adminCheckQuery = `
      SELECT * 
      FROM group_members 
      WHERE group_id = $1 AND user_id = $2 AND role = 'admin' AND is_active = true
    `;
    const { rowCount } = await query(adminCheckQuery, [group_id, userId]);

    if (rowCount === 0) {
      return res.status(403).json({
        success: false,
        message: 'You must be an admin to invite members to this group.',
      });
    }

    next();
  } catch (error) {
    console.error('Admin check failed:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to verify admin role.',
      error: error.message,
    });
  }
};