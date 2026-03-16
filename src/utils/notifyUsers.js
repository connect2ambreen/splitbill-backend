import { query } from "../config/db.js";
import admin from "../config/firebase.js";

export const sendPushNotification = async (fcm_token, title, message, data = {}) => {
  try {
    const response = await admin.messaging().send({
      token: fcm_token,
      data: {
        title,
        message,
        type: data.type ?? 'general',
        group_id: String(data.group_id ?? ''),
        related_expense_id: String(data.related_expense_id ?? ''),
        related_settlement_id: String(data.related_settlement_id ?? ''),
      },
      android: {
        priority: 'high',
        ttl: 3600000,
      },
      apns: {
        headers: { 'apns-priority': '10' },
        payload: {
          aps: {
            contentAvailable: true,
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

    const members = result.rows.filter(row => row.user_id !== actor_user_id);
    console.log('📢 [NOTIFY] Members to notify (excluding actor):', members.length);

    for (const member of members) {
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

// ── Notify user when they receive a group invitation ─────────────────────────
export const notifyInvitation = async ({ invitee_id, group_id, group_name, inviter_name }) => {
  try {
    const title = '✉️ Group Invitation';
    const message = `${inviter_name} invited you to join "${group_name}"`;

    await query(
      `INSERT INTO notifications (user_id, group_id, type, title, message)
       VALUES ($1, $2, $3, $4, $5)`,
      [invitee_id, group_id, 'invitation', title, message]
    );

    const tokenResult = await query('SELECT fcm_token FROM users WHERE id = $1', [invitee_id]);
    if (tokenResult.rows[0]?.fcm_token) {
      await sendPushNotification(tokenResult.rows[0].fcm_token, title, message, {
        type: 'invitation',
        group_id,
      });
    }

    console.log('✅ [NOTIFY] Invitation notification sent to user:', invitee_id);
  } catch (error) {
    console.error('❌ [NOTIFY] notifyInvitation error:', error);
  }
};

// ── Notify group members when someone accepts an invitation ──────────────────
export const notifyInvitationAccepted = async ({ new_member_id, group_id }) => {
  try {
    const userResult = await query('SELECT name FROM users WHERE id = $1', [new_member_id]);
    const newMemberName = userResult.rows[0]?.name || 'Someone';

    const groupResult = await query('SELECT name FROM groups WHERE id = $1', [group_id]);
    const groupName = groupResult.rows[0]?.name || 'the group';

    await notifyGroupMembers({
      group_id,
      actor_user_id: new_member_id,
      type: 'member_joined',
      title: '👋 New Member',
      message: `${newMemberName} joined "${groupName}"`,
    });

    console.log('✅ [NOTIFY] Accept notification sent for group:', group_id);
  } catch (error) {
    console.error('❌ [NOTIFY] notifyInvitationAccepted error:', error);
  }
};