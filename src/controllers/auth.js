import { query } from '../config/db.js';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import dotenv from 'dotenv';
import crypto from 'crypto';
import { sendPasswordChangedNotification } from '../utils/emailService.js';
import axios from 'axios';
import { OAuth2Client } from 'google-auth-library';
dotenv.config();
const client = new OAuth2Client(process.env.GOOGLE_WEB_CLIENT_ID);


export const signup = async (req, res) => {
  try {
    const { name, email, password, invitation_token, profile_url, phone, locale } = req.body;

    if (!name || !email || !password) {
      return res.status(400).json({ success: false, message: 'Name, email, and password are required.' });
    }

    const existingUser = await query('SELECT * FROM users WHERE email = $1', [email]);
    if (existingUser.rows.length > 0) {
      return res.status(400).json({ success: false, message: 'User already exists with this email.' });
    }

    const hashedPassword = await bcrypt.hash(password, 10);

    // Build locale object — use what frontend sends, fallback to US defaults
    const userLocale = {
      country: locale?.country || 'US',
      language: locale?.language || 'en',
      currency: locale?.currency || 'USD',
      currencySymbol: locale?.currencySymbol || '$',
      flag: locale?.flag || '🇺🇸',
    };

    const userResult = await query(
      `INSERT INTO users (name, email, password, profile_url, phone, locale) 
       VALUES ($1, $2, $3, $4, $5, $6) 
       RETURNING id, name, email, profile_url, phone, locale, created_at, updated_at`,
      [name, email, hashedPassword, profile_url, phone, JSON.stringify(userLocale)]
    );

    const user = userResult.rows[0];

    if (invitation_token) {
      const invitationResult = await query(
        `SELECT * FROM group_invitations WHERE invitation_token = $1 AND expires_at > NOW() AND status = 'pending'`,
        [invitation_token]
      );
      if (invitationResult.rows.length > 0) {
        const invitation = invitationResult.rows[0];
        await query(
          `INSERT INTO group_members (group_id, user_id, role) VALUES ($1, $2, 'member')`,
          [invitation.group_id, user.id]
        );
        await query(
          `UPDATE group_invitations SET status = 'accepted' WHERE invitation_token = $1`,
          [invitation_token]
        );
      }
    }

    const token = jwt.sign(
      { id: user.id, email: user.email },
      process.env.JWT_SECRET_KEY,
      { expiresIn: '7d' }
    );

    res.json({ success: true, message: 'Signup successful', data: user, token });

  } catch (error) {
    console.error('Signup error:', error);
    res.status(500).json({ success: false, message: 'Server error during signup.' });
  }
};


export const login = async (req, res) => {
  try {
    const { email, password } = req.body;

    if (!email || !password) {
      return res.status(400).json({
        success: false,
        message: 'Email and password are required',
      });
    }

    // Fetch user from the database
    const result = await query('SELECT * FROM users WHERE email = $1', [email]);
    if (result.rows.length === 0) {
      return res.status(404).json({
        success: false,
        message: 'User not found',
      });
    }

    const user = result.rows[0];

    // Compare passwords
    const isValidPassword = await bcrypt.compare(password, user.password);
    if (!isValidPassword) {
      return res.status(400).json({
        success: false,
        message: 'Incorrect password',
        forgot: true
      });
    }

    // Remove sensitive fields
    const { password: userPassword, ...userWithoutPassword } = user;

    // Generate JWT
    const secretKey = process.env.JWT_SECRET_KEY;
    if (!secretKey) {
      throw new Error('JWT_SECRET_KEY is not defined in the environment');
    }

    const token = jwt.sign({ identity: user.id }, secretKey, { expiresIn: '7d' }); // ✅ was '1d'

    res.json({
      success: true,
      message: 'Login successful',
      data: {
        user: userWithoutPassword,
        token,
      },
    });
  } catch (error) {
    console.error('Login error:', error.message);
    res.status(500).json({
      success: false,
      message: 'Server error during login',
    });
  }
};

export const registerBiometric = async (req, res) => {
  try {
    const { userId, publicKey } = req.body;
    if (!userId || !publicKey) {
      return res.status(400).json({ success: false, message: 'userId and publicKey are required' });
    }

    await query(
      `UPDATE users SET bio_pub_key = $1, updated_at = NOW() WHERE id = $2`,
      [publicKey, userId]
    );

    res.json({ success: true, message: 'Biometric registered successfully' });
  } catch (error) {
    console.error('Biometric register error:', error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
};

export const biometricLogin = async (req, res) => {
  try {
    const { userId, signature, payload } = req.body;
    if (!userId || !signature || !payload) {
      return res.status(400).json({ success: false, message: 'userId, signature, and payload are required' });
    }

    const result = await query(
      'SELECT * FROM users WHERE id = $1 AND bio_pub_key IS NOT NULL',
      [userId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, message: 'No biometric registered for this user' });
    }

    const user = result.rows[0];

    const verify = crypto.createVerify('SHA256');
    verify.update(payload);
    const isValid = verify.verify(
      `-----BEGIN PUBLIC KEY-----\n${user.bio_pub_key}\n-----END PUBLIC KEY-----`,
      signature,
      'base64'
    );

    if (!isValid) {
      return res.status(401).json({ success: false, message: 'Biometric verification failed' });
    }

    const { password: _, bio_pub_key: __, ...userWithoutSensitive } = user;

    const token = jwt.sign({ identity: user.id }, process.env.JWT_SECRET_KEY, { expiresIn: '1d' });

    res.json({
      success: true,
      message: 'Biometric login successful',
      data: { user: userWithoutSensitive, token },
    });
  } catch (error) {
    console.error('Biometric login error:', error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
};


export const forgotPassword = async (req, res) => {
  try {
    const { email } = req.body;

    console.log('📨 Forgot Password Request Received');
    console.log('   Email:', email);

    if (!email) {
      console.log('❌ Email is missing');
      return res.status(400).json({ success: false, message: 'Email is required' });
    }

    const result = await query('SELECT id, name, email FROM users WHERE email = $1', [email]);
    console.log('🔍 Database Query Result:', result.rows);

    if (result.rows.length === 0) {
      console.log('❌ User not found for email:', email);
      return res.status(404).json({ success: false, message: 'User not found' });
    }

    const user = result.rows[0];
    console.log('✅ User found:', { id: user.id, name: user.name, email: user.email });

    // Generate 6-digit code
    const code = Math.floor(100000 + Math.random() * 900000).toString();
    const expiresAt = new Date(Date.now() + 15 * 60 * 1000); // 15 minutes

    console.log('🔐 Generated Reset Code:', code);
    console.log('⏰ Code Expires At:', expiresAt);

    // Delete old codes for this user
    await query('DELETE FROM password_resets WHERE user_id = $1', [user.id]);
    console.log('🗑️ Old codes deleted for user:', user.id);

    // Insert new code with attempts counter
    await query(
      `INSERT INTO password_resets (user_id, token, expires_at, created_at)
       VALUES ($1, $2, $3, NOW())`,
      [user.id, code, expiresAt]
    );
    console.log('✅ Reset code inserted into database');

    // Send email with code
    const emailResult = await sendPasswordResetCodeEmail(user.email, code, user.name);
    console.log('📧 Email Result:', emailResult);

    if (!emailResult.success) {
      console.error('❌ Email sending failed:', emailResult.error);
      await query('DELETE FROM password_resets WHERE user_id = $1', [user.id]);
      return res.status(500).json({
        success: false,
        message: 'Failed to send reset code. Please try again later.'
      });
    }

    // Insert notification
    try {
      await query(
        `INSERT INTO notifications (user_id, type, title, message)
         VALUES ($1, $2, $3, $4)`,
        [user.id, 'password_reset_requested', 'Password Reset Requested', 'A password reset code has been sent to your email']
      );
      console.log('✅ Notification inserted');
    } catch (e) {
      console.warn('⚠️ Failed to insert notification:', e.message);
    }

    console.log('✅ Forgot Password Request Completed Successfully');
    return res.json({
      success: true,
      message: 'A 6-digit verification code has been sent to your email.',
      email: user.email // Send back email so frontend can show it
    });
  } catch (error) {
    console.error('❌ Forgot password error:', error);
    console.error('   Stack:', error.stack);
    return res.status(500).json({ success: false, message: 'Server error during password reset request' });
  }
};


export const verifyResetCode = async (req, res) => {
  try {
    const { email, code } = req.body;

    console.log('🔍 Verify Code Request Received');
    console.log('   Email:', email);
    console.log('   Code:', code);

    if (!email || !code) {
      return res.status(400).json({
        success: false,
        message: 'Email and code are required'
      });
    }

    // Validate code format (6 digits)
    if (!/^\d{6}$/.test(code)) {
      return res.status(400).json({
        success: false,
        message: 'Invalid code format'
      });
    }

    // Get user by email
    const userResult = await query('SELECT id FROM users WHERE email = $1', [email]);

    if (userResult.rows.length === 0) {
      return res.status(404).json({
        success: false,
        message: 'User not found'
      });
    }

    const userId = userResult.rows[0].id;

    // Get the reset code from database
    const codeResult = await query(
      `SELECT * FROM password_resets 
       WHERE user_id = $1 AND token = $2 AND expires_at > NOW()`,
      [userId, code]
    );

    if (codeResult.rows.length === 0) {
      console.log('❌ Invalid or expired code');
      return res.status(400).json({
        success: false,
        message: 'Invalid or expired verification code'
      });
    }

    console.log('✅ Code verified successfully');

    // Generate a verification token (short-lived, for proceeding to reset page)
    const verificationToken = crypto.randomBytes(32).toString('hex');
    const tokenExpiresAt = new Date(Date.now() + 5 * 60 * 1000); // 5 minutes to reset password

    // Update the record with verification token
    await query(
      `UPDATE password_resets 
       SET token = $1, expires_at = $2 
       WHERE user_id = $3`,
      [verificationToken, tokenExpiresAt, userId]
    );

    console.log('🎟️ Verification token generated:', verificationToken);

    return res.json({
      success: true,
      message: 'Code verified successfully',
      verificationToken: verificationToken,
      expiresIn: 300 // 5 minutes in seconds
    });

  } catch (error) {
    console.error('❌ Verify code error:', error);
    return res.status(500).json({
      success: false,
      message: 'Server error during code verification'
    });
  }
};


export const resetPassword = async (req, res) => {
  try {
    const { verificationToken, new_password } = req.body;

    console.log('🔄 Reset Password Request Received');
    console.log('   Verification Token:', verificationToken?.substring(0, 10) + '...');

    if (!verificationToken || !new_password) {
      return res.status(400).json({
        success: false,
        message: 'Verification token and new password are required'
      });
    }

    if (new_password.length < 6) {
      return res.status(400).json({
        success: false,
        message: 'Password must be at least 6 characters'
      });
    }

    // Verify the verification token
    const tokenRes = await query(
      'SELECT * FROM password_resets WHERE token = $1 AND expires_at > NOW()',
      [verificationToken]
    );

    if (tokenRes.rows.length === 0) {
      console.log('❌ Invalid or expired verification token');
      return res.status(400).json({
        success: false,
        message: 'Invalid or expired verification token. Please request a new code.'
      });
    }

    const reset = tokenRes.rows[0];
    const hashed = await bcrypt.hash(new_password, 10);

    // Get user email for notification
    const userRes = await query('SELECT email FROM users WHERE id = $1', [reset.user_id]);
    const userEmail = userRes.rows[0]?.email;

    // Update password
    await query(
      'UPDATE users SET password = $1, updated_at = NOW() WHERE id = $2',
      [hashed, reset.user_id]
    );

    console.log('✅ Password updated successfully for user:', reset.user_id);

    // Delete all reset tokens for user
    await query('DELETE FROM password_resets WHERE user_id = $1', [reset.user_id]);

    // Send password changed confirmation email
    if (userEmail) {
      await sendPasswordChangedNotification(userEmail);
    }

    // Insert notification
    try {
      await query(
        `INSERT INTO notifications (user_id, type, title, message)
         VALUES ($1, $2, $3, $4)`,
        [reset.user_id, 'password_changed', 'Password Changed Successfully', 'Your password has been reset successfully']
      );
    } catch (e) {
      console.warn('⚠️ Failed to insert notification:', e.message);
    }

    return res.json({
      success: true,
      message: 'Password has been reset successfully. You can now login with your new password.'
    });

  } catch (error) {
    console.error('❌ Reset password error:', error);
    return res.status(500).json({
      success: false,
      message: 'Server error during password reset'
    });
  }
};


export const googleAuth = async (req, res) => {
  try {
    const { token } = req.body;
    if (!token) return res.status(400).json({ success: false, message: 'Token is required' });

    // Verify the ID token
    const ticket = await client.verifyIdToken({
      idToken: token,
      audience: process.env.GOOGLE_CLIENT_ID,
    });
    const payload = ticket.getPayload();
    const { email, name, picture } = payload;
    if (!email) return res.status(400).json({ success: false, message: 'Email not found in Google token' });

    // Check if user exists
    let userResult = await query('SELECT * FROM users WHERE email = $1', [email]);
    let user;

    if (userResult.rows.length === 0) {
      const newUser = await query(
        `INSERT INTO users (name, email, password, profile_url, locale)
         VALUES ($1, $2, $3, $4, $5)
         RETURNING id, name, email, profile_url, phone, locale, created_at, updated_at`,
        [name || email.split('@')[0], email, '', picture || null, JSON.stringify({
          country: 'US', language: 'en', currency: 'USD', currencySymbol: '$', flag: '🇺🇸'
        })]
      );
      user = newUser.rows[0];
    } else {
      user = userResult.rows[0];
    }

    const { password: _, ...userWithoutPassword } = user;

    const token_jwt = jwt.sign({ identity: user.id }, process.env.JWT_SECRET_KEY, { expiresIn: '7d' });

    res.json({ success: true, message: 'Google login successful', data: { user: userWithoutPassword, token: token_jwt } });

  } catch (err) {
    console.error('Google auth error:', err.message);
    res.status(401).json({ success: false, message: 'Google auth failed', error: err.message });
  }
};

export const facebookAuth = async (req, res) => {
  try {
    const { accessToken } = req.body;
    if (!accessToken) return res.status(400).json({ success: false, message: 'accessToken is required' });

    const fbRes = await axios.get('https://graph.facebook.com/me', {
      params: { fields: 'id,name,email,picture', access_token: accessToken },
    });

    const { email, name, picture } = fbRes.data;
    if (!email) return res.status(400).json({ success: false, message: 'Facebook account has no email' });

    let userResult = await query('SELECT * FROM users WHERE email = $1', [email]);
    let user;

    if (userResult.rows.length === 0) {
      const newUser = await query(
        `INSERT INTO users (name, email, password, profile_url, locale)
         VALUES ($1, $2, $3, $4, $5)
         RETURNING id, name, email, profile_url, phone, locale, created_at, updated_at`,
        [name || email.split('@')[0], email, '', picture?.data?.url || null, JSON.stringify({
          country: 'US', language: 'en', currency: 'USD', currencySymbol: '$', flag: '🇺🇸'
        })]
      );
      user = newUser.rows[0];
    } else {
      user = userResult.rows[0];
    }

    const { password: _, ...userWithoutPassword } = user;

    const token_jwt = jwt.sign({ identity: user.id }, process.env.JWT_SECRET_KEY, { expiresIn: '7d' });

    res.json({ success: true, message: 'Facebook login successful', data: { user: userWithoutPassword, token: token_jwt } });

  } catch (err) {
    console.error('Facebook auth error:', err.response?.data || err.message);
    res.status(401).json({ success: false, message: 'Facebook auth failed', error: err.message });
  }
};