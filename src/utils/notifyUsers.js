import { query } from "../config/db.js";
import admin from "../config/firebase.js";

const sendPushNotification = async (fcm_token, title, message, data = {}) => {
  try {
    const response = await admin.messaging().send({
      token: fcm_token,

      // ✅ NO notification field — prevents FCM from auto-displaying
      // This is the fix for double notifications

      data: {
        title,           // ✅ moved here so all app states can read it
        message,         // ✅ moved here
        type: data.type ?? 'general',
        group_id: String(data.group_id ?? ''),
        related_expense_id: String(data.related_expense_id ?? ''),
        related_settlement_id: String(data.related_settlement_id ?? ''),
      },

      android: {
        priority: 'high',
        ttl: 3600000,
        // ✅ NO android.notification block — we handle display via notifee
      },

      apns: {
        headers: {
          'apns-priority': '10',
        },
        payload: {
          aps: {
            contentAvailable: true, // wakes iOS in background
            sound: 'default',
            badge: 1,
          },
        },
      },
    });

    console.log('Push sent:', response);
  } catch (error) {
    if (
      error.code === 'messaging/invalid-registration-token' ||
      error.code === 'messaging/registration-token-not-registered'
    ) {
      console.warn('Invalid FCM token, removing from DB:', fcm_token);
      await query(`UPDATE users SET fcm_token = NULL WHERE fcm_token = $1`, [fcm_token]);
    } else {
      console.error('Push notification error:', error);
    }
  }
};

export const notifyGroupMembers = async ({
  group_id,
  actor_user_id,
  type,
  title,
  message,
  related_expense_id,
  related_settlement_id,
}) => {
  try {
    console.log('📢 [NOTIFY] notifyGroupMembers called for group:', group_id);

    const result = await query(
      `SELECT gm.user_id, u.fcm_token 
       FROM group_members gm
       JOIN users u ON u.id = gm.user_id
       WHERE gm.group_id = $1 AND gm.is_active = true`,
      [group_id]
    );

    console.log('📢 [NOTIFY] Total members found:', result.rows.length);
    console.log('📢 [NOTIFY] Members:', result.rows.map(r => ({
      user_id: r.user_id,
      has_token: !!r.fcm_token
    })));

    const members = result.rows.filter(row => row.user_id !== actor_user_id);
    console.log('📢 [NOTIFY] Members to notify (excluding actor):', members.length);

    for (const member of members) {
      // Save notification in DB
      await query(
        `INSERT INTO notifications 
         (user_id, group_id, type, title, message, related_expense_id, related_settlement_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [
          member.user_id,
          group_id,
          type,
          title,
          message,
          related_expense_id || null,
          related_settlement_id || null,
        ]
      );

      if (member.fcm_token) {
        console.log('📱 [NOTIFY] Sending push to user:', member.user_id);
        await sendPushNotification(member.fcm_token, title, message, {
          type,
          group_id,
          related_expense_id,
          related_settlement_id,
        });
      } else {
        console.warn('⚠️ [NOTIFY] No FCM token for user:', member.user_id);
      }
    }
  } catch (error) {
    console.error('❌ [NOTIFY] notifyGroupMembers error:', error);
  }
};