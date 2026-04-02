import { query } from "../config/db.js";
import { generateUniqueInviteCode } from "../utils/inviteCode.js";
import { notifyGroupMembers, notifyInvitation, notifyInvitationAccepted } from "../utils/notifyUsers.js";
import { sendEmail } from '../utils/emailService.js';
import redis from '../config/redis.js';

import crypto from 'crypto';

// ─── Cache helpers ────────────────────────────────────────────────────────────
const CACHE_TTL = {
  groups: 120,      // 2 minutes — group list changes less often
  members: 60,      // 1 minute — member changes moderately
  details: 300,     // 5 minutes — group details change rarely
};

// add this function
const bustGroupCaches = async (userId, groupId) => {
  try {
    const ops = [];
    if (userId) ops.push(redis().del(`groups:${userId}`));
    if (groupId) {
      ops.push(redis().del(`group_members:${groupId}`));
      ops.push(redis().del(`group_detail:${groupId}`));
    }
    if (ops.length > 0) await Promise.allSettled(ops);
  } catch (err) {
    console.warn('bustGroupCaches error:', err.message || err);
  }
};

// ─── Create Group ─────────────────────────────────────────────────────────────
export const createGroup = async (req, res) => {
  try {
    const userId = req.user?.userId;
    if (!userId) {
      return res.status(401).json({ success: false, message: 'Unauthorized: user not found' });
    }

    const { name, description, group_type } = req.body;

    if (!name) {
      return res.status(400).json({ success: false, message: 'Group name is required' });
    }

    const code = await generateUniqueInviteCode();

    const groupResult = await query(
      `INSERT INTO groups (name, description, group_type, created_by, invite_code) 
       VALUES ($1, $2, $3, $4, $5) RETURNING *`,
      [name, description, group_type || 'general', userId, code]
    );
    const group = groupResult.rows[0];

    await query(
      `INSERT INTO group_members (group_id, user_id, role) 
       VALUES ($1, $2, 'admin')`,
      [group.id, userId]
    );

    await bustGroupCaches(userId, group.id);

    res.status(201).json({
      success: true,
      message: 'Group created successfully. You are now the admin.',
      data: { group, role: 'admin' },
    });

  } catch (error) {
    console.error('Create group error:', error);
    res.status(500).json({ success: false, message: 'Server error during group creation' });
  }
};


export const inviteToGroup = async (req, res) => {
  try {
    const { group_id } = req.params;
    const { email, name, user_id } = req.body;
    const inviterUserId = req.user.userId;

    const groupId = parseInt(group_id);
    if (!email && !user_id) {
      return res.status(400).json({ success: false, message: 'Email or user_id is required.' });
    }

    const groupResult = await query('SELECT * FROM groups WHERE id = $1', [groupId]);
    if (groupResult.rows.length === 0) {
      return res.status(404).json({ success: false, message: 'Group not found.' });
    }

    const group = groupResult.rows[0];

    let invitee = null;
    if (user_id) {
      const userResult = await query('SELECT * FROM users WHERE id = $1', [user_id]);
      invitee = userResult.rows[0];
    } else if (email) {
      const userResult = await query('SELECT * FROM users WHERE email = $1', [email]);
      invitee = userResult.rows[0];
    }

    if (invitee) {
      const memberResult = await query(
        'SELECT * FROM group_members WHERE group_id = $1 AND user_id = $2 AND is_active = true',
        [groupId, invitee.id]
      );
      if (memberResult.rows.length > 0) {
        return res.status(400).json({ success: false, message: 'User is already a member of this group.' });
      }
    }

    const invitationToken = crypto.randomBytes(32).toString('hex');
    const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);

    const inviteeEmail = email || (invitee && invitee.email);
    const inviteeName = name || (invitee && invitee.name) || null;

    const invitationResult = await query(
      'SELECT * FROM group_invitations WHERE group_id = $1 AND invitee_email = $2',
      [groupId, inviteeEmail]
    );

    if (invitationResult.rows.length > 0) {
      await query(
        `UPDATE group_invitations 
         SET invitation_token = $1, expires_at = $2, status = 'pending', sent_at = NOW(), user_id = $3
         WHERE group_id = $4 AND invitee_email = $5`,
        [invitationToken, expiresAt, invitee ? invitee.id : null, groupId, inviteeEmail]
      );
    } else {
      await query(
        `INSERT INTO group_invitations (group_id, inviter_user_id, invitee_email, invitee_name, user_id, invitation_token, expires_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [groupId, inviterUserId, inviteeEmail, inviteeName, invitee ? invitee.id : null, invitationToken, expiresAt]
      );
    }

    if (invitee) {
      const inviterResult = await query('SELECT name FROM users WHERE id = $1', [inviterUserId]);
      const inviterName = inviterResult.rows[0]?.name || 'Someone';
      await notifyInvitation({
        invitee_id: invitee.id,
        group_id: groupId,
        group_name: group.name,
        inviter_name: inviterName,
      });
    }

    const invitationLink = `${process.env.FRONTEND_URL || 'http://localhost:3001'}/invite/${invitationToken}`;

    res.json({
      success: true,
      message: `Invitation created successfully for "${group.name}".`,
      data: {
        user_exists: !!invitee,
        invitation_link: invitationLink,
        expires_at: expiresAt,
      }
    });
  } catch (error) {
    console.error('Invite to group error:', error);
    res.status(500).json({ success: false, message: 'Server error during invitation.' });
  }
};


export const acceptInvitation = async (req, res) => {
  try {
    const { token } = req.params;
    const userId = req.user && req.user.userId;
    if (!userId) return res.status(401).json({ success: false, message: 'Authentication required' });

    const invResult = await query('SELECT * FROM group_invitations WHERE invitation_token = $1', [token]);
    if (invResult.rows.length === 0) {
      return res.status(404).json({ success: false, message: 'Invitation not found' });
    }

    const invitation = invResult.rows[0];
    if (invitation.status !== 'pending') {
      return res.status(400).json({ success: false, message: `Invitation is ${invitation.status}` });
    }

    if (new Date(invitation.expires_at) < new Date()) {
      return res.status(400).json({ success: false, message: 'Invitation has expired' });
    }

    if (invitation.user_id && invitation.user_id !== userId) {
      return res.status(403).json({ success: false, message: 'This invitation was not issued for your account' });
    }

    if (!invitation.user_id) {
      const ures = await query('SELECT email FROM users WHERE id = $1', [userId]);
      const currentEmail = ures.rows[0] && ures.rows[0].email;
      if (invitation.invitee_email && currentEmail && invitation.invitee_email.toLowerCase() !== currentEmail.toLowerCase()) {
        return res.status(403).json({ success: false, message: 'This invitation email does not match your account email' });
      }
    }

    const memberCheck = await query(
      'SELECT 1 FROM group_members WHERE group_id = $1 AND user_id = $2 AND is_active = true',
      [invitation.group_id, userId]
    );
    if (memberCheck.rows.length === 0) {
      await query(
        'INSERT INTO group_members (group_id, user_id, role, joined_at) VALUES ($1, $2, $3, NOW())',
        [invitation.group_id, userId, 'member']
      );
    }

    await query(
      'UPDATE group_invitations SET status = $1, accepted_at = NOW(), user_id = $2 WHERE id = $3',
      ['accepted', userId, invitation.id]
    );

    await bustGroupCaches(userId, invitation.group_id);

    await notifyInvitationAccepted({
      new_member_id: userId,
      group_id: invitation.group_id,
    });

    res.json({ success: true, message: 'Invitation accepted and you have been added to the group' });
  } catch (error) {
    console.error('Accept invitation error:', error);
    res.status(500).json({ success: false, message: 'Server error during invitation acceptance.' });
  }
};


export const searchUsers = async (req, res) => {
  try {
    const queryEmail = req.query.query;
    const groupId = parseInt(req.query.group_id);

    if (!queryEmail) {
      return res.status(400).json({ success: false, message: 'query parameter is required' });
    }

    const userResult = await query('SELECT id, name, email FROM users WHERE LOWER(email) = LOWER($1) LIMIT 1', [queryEmail]);
    const foundUser = userResult.rows[0];

    if (!foundUser) {
      return res.json({ user_found: false });
    }

    let alreadyInGroup = false;
    let pendingInvitation = false;

    if (groupId) {
      const memberResult = await query(
        'SELECT 1 FROM group_members WHERE group_id = $1 AND user_id = $2 AND is_active = true',
        [groupId, foundUser.id]
      );
      alreadyInGroup = memberResult.rows.length > 0;

      const invitationResult = await query(
        "SELECT 1 FROM group_invitations WHERE group_id = $1 AND invitee_email = $2 AND status = 'pending'",
        [groupId, foundUser.email]
      );
      pendingInvitation = invitationResult.rows.length > 0;
    }

    return res.json({
      user_found: true,
      data: {
        user_id: foundUser.id,
        name: foundUser.name,
        email: foundUser.email,
        already_in_group: alreadyInGroup,
        pending_invitation: pendingInvitation
      }
    });
  } catch (error) {
    console.error('Search users error:', error);
    res.status(500).json({ success: false, message: 'Server error during user search.' });
  }
};


export const verifyInvitation = async (req, res) => {
  try {
    const { token } = req.params;
    const invResult = await query('SELECT * FROM group_invitations WHERE invitation_token = $1', [token]);
    if (invResult.rows.length === 0) {
      return res.status(404).json({ success: false, message: 'Invitation not found' });
    }

    const invitation = invResult.rows[0];
    if (invitation.status !== 'pending') {
      return res.status(400).json({ success: false, message: `Invitation is ${invitation.status}` });
    }

    if (new Date(invitation.expires_at) < new Date()) {
      return res.status(400).json({ success: false, message: 'Invitation has expired' });
    }

    const groupResult = await query('SELECT id, name, description FROM groups WHERE id = $1', [invitation.group_id]);
    const inviterResult = await query('SELECT id, name, email FROM users WHERE id = $1', [invitation.inviter_user_id]);

    res.json({
      success: true,
      data: {
        invitation: {
          id: invitation.id,
          invitee_email: invitation.invitee_email,
          invitee_name: invitation.invitee_name,
          status: invitation.status,
          expires_at: invitation.expires_at
        },
        group: groupResult.rows[0],
        inviter: inviterResult.rows[0]
      }
    });
  } catch (error) {
    console.error('Verify invitation error:', error);
    res.status(500).json({ success: false, message: 'Server error during invitation verification.' });
  }
};


export const getPendingInvitations = async (req, res) => {
  try {
    const userId = req.user && req.user.userId;
    if (!userId) return res.status(401).json({ success: false, message: 'Authentication required' });

    const result = await query(`
      SELECT 
        gi.id,
        gi.invitation_token,
        gi.status,
        gi.expires_at,
        gi.created_at,
        g.id as group_id,
        g.name as group_name,
        g.description as group_description,
        u.id as inviter_id,
        u.name as inviter_name,
        u.email as inviter_email
      FROM group_invitations gi
      JOIN groups g ON gi.group_id = g.id
      JOIN users u ON gi.inviter_user_id = u.id
      WHERE (gi.user_id = $1 OR gi.invitee_email = (SELECT email FROM users WHERE id = $1))
        AND gi.status = 'pending'
        AND gi.expires_at > NOW()
      ORDER BY gi.created_at DESC
    `, [userId]);

    const invitations = result.rows.map(row => ({
      id: row.id,
      invitation_token: row.invitation_token,
      status: row.status,
      expires_at: row.expires_at,
      created_at: row.created_at,
      group: {
        id: row.group_id,
        name: row.group_name,
        description: row.group_description
      },
      inviter: {
        id: row.inviter_id,
        name: row.inviter_name,
        email: row.inviter_email
      }
    }));

    res.json({ success: true, data: invitations });
  } catch (error) {
    console.error('Get pending invitations error:', error);
    res.status(500).json({ success: false, message: 'Server error fetching invitations.' });
  }
};


// ─── Get User Groups (cached) ─────────────────────────────────────────────────
export const getUserGroups = async (req, res) => {
  try {
    const { user_id } = req.params;
    const cacheKey = `groups:${user_id}`;

    try {
      const cached = await redis().get(cacheKey);
      if (cached) {
        return res.json({ success: true, data: cached, fromCache: true });
      }
    } catch (e) {
      console.error('Redis get error (getUserGroups):', e);
    }

    const groupsQuery = `
      SELECT 
        g.id,
        g.name,
        g.description,
        g.group_type,
        g.default_currency,
        g.avatar_url,
        g.created_at,
        u.name as created_by_name,
        COUNT(DISTINCT gm.user_id) as member_count,
        (
          SELECT JSON_AGG(JSON_BUILD_OBJECT('id', mu.id, 'name', mu.name) ORDER BY gm2.joined_at ASC)
          FROM group_members gm2
          JOIN users mu ON gm2.user_id = mu.id
          WHERE gm2.group_id = g.id AND gm2.is_active = true
        ) as members,
        COALESCE((
          SELECT SUM(CASE WHEN es.paid_share > es.owed_share THEN es.paid_share - es.owed_share ELSE 0 END)
          FROM expense_shares es
          JOIN expenses e ON es.expense_id = e.id
          WHERE e.group_id = g.id AND es.user_id = $1 AND e.is_deleted = false
        ), 0) as owes_you,
        COALESCE((
          SELECT SUM(CASE WHEN es.owed_share > es.paid_share THEN es.owed_share - es.paid_share ELSE 0 END)
          FROM expense_shares es
          JOIN expenses e ON es.expense_id = e.id
          WHERE e.group_id = g.id AND es.user_id = $1 AND e.is_deleted = false
        ), 0) as you_owe
      FROM groups g
      JOIN group_members gm_current ON g.id = gm_current.group_id 
        AND gm_current.user_id = $1 
        AND gm_current.is_active = true
      LEFT JOIN group_members gm ON g.id = gm.group_id AND gm.is_active = true
      LEFT JOIN users u ON g.created_by = u.id
      WHERE g.is_active = true
      GROUP BY g.id, g.name, g.description, g.group_type, g.default_currency, g.avatar_url, g.created_at, u.name
      ORDER BY g.created_at DESC
    `;

    const result = await query(groupsQuery, [user_id]);

    const groups = result.rows.map(group => ({
      ...group,
      member_count: parseInt(group.member_count),
      members: (group.members || []).filter(m => m && m.id !== null),
      owes_you: parseFloat(group.owes_you || 0),
      you_owe: parseFloat(group.you_owe || 0),
    }));

    try {
      await redis().set(cacheKey, groups, { ex: CACHE_TTL.groups });
    } catch (e) {
      console.error('Redis set error (getUserGroups):', e);
    }

    res.json({ success: true, data: groups });

  } catch (error) {
    console.error('Get user groups error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch user groups',
      error: error.message,
    });
  }
};


// ─── Get Group Members (cached) ───────────────────────────────────────────────
export const getGroupMembers = async (req, res) => {
  console.log('🔥 getGroupMembers HIT', req.params, req.user);
  try {
    const { group_id } = req.params;
    const cacheKey = `group_members:${group_id}`;

    try {
      const cached = await redis().get(cacheKey);
      if (cached) {
        return res.json({ success: true, data: cached, fromCache: true });
      }
    } catch (e) {
      console.error('Redis get error (getGroupMembers):', e);
    }

    const membersQuery = `
      SELECT 
        u.id,
        u.name,
        u.email,
        u.profile_url,
        gm.role,
        gm.joined_at
      FROM group_members gm
      JOIN users u ON gm.user_id = u.id
      WHERE gm.group_id = $1 
        AND gm.is_active = true
      ORDER BY 
        CASE WHEN gm.role = 'admin' THEN 1 ELSE 2 END,
        gm.joined_at ASC
    `;

    const result = await query(membersQuery, [group_id]);

    try {
      await redis().set(cacheKey, result.rows, { ex: CACHE_TTL.members });
    } catch (e) {
      console.error('Redis set error (getGroupMembers):', e);
    }

    res.json({ success: true, data: result.rows });

  } catch (error) {
    console.error('Get group members error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch group members',
      error: error.message
    });
  }
};


export const getAllUsers = async (req, res) => {
  try {
    const result = await query(`
      SELECT id, name, email, phone
      FROM users
      ORDER BY name ASC
    `);

    res.json({ success: true, data: result.rows });

  } catch (error) {
    console.error('Get all users error:', error);
    res.status(500).json({ success: false, message: 'Failed to fetch users' });
  }
};


export const addUsersToGroup = async (req, res) => {
  try {
    const { group_id } = req.params;
    const { user_ids } = req.body;

    if (!user_ids || user_ids.length === 0) {
      return res.status(400).json({ success: false, message: 'No users selected' });
    }

    const groupId = parseInt(group_id);

    const existingMembers = await query(
      'SELECT user_id FROM group_members WHERE group_id = $1 AND user_id = ANY($2)',
      [groupId, user_ids]
    );

    const existingIds = existingMembers.rows.map(row => row.user_id);
    const newUserIds = user_ids.filter(id => !existingIds.includes(id));

    if (newUserIds.length === 0) {
      return res.status(400).json({ success: false, message: 'All selected users are already members' });
    }

    for (const userId of newUserIds) {
      await query(
        'INSERT INTO group_members (group_id, user_id, role) VALUES ($1, $2, $3)',
        [groupId, userId, 'member']
      );
    }

    await bustGroupCaches(null, groupId);

    res.json({
      success: true,
      message: `Successfully added ${newUserIds.length} members to the group`,
      data: { added_count: newUserIds.length, existing_count: existingIds.length }
    });

  } catch (error) {
    console.error('Add users to group error:', error);
    res.status(500).json({ success: false, message: 'Server error while adding members' });
  }
};

export const getGroupBalance = async (req, res) => {
  try {
    const { group_id } = req.params;
    const userId = req.user.userId;

    const balanceResult = await query(`
      SELECT
        SUM(CASE WHEN es.owed_share > es.paid_share THEN es.owed_share - es.paid_share ELSE 0 END) AS you_owe,
        SUM(CASE WHEN es.paid_share > es.owed_share THEN es.paid_share - es.owed_share ELSE 0 END) AS owes_you
      FROM expense_shares es
      JOIN expenses e ON es.expense_id = e.id
      WHERE e.group_id = $1 AND es.user_id = $2 AND e.is_deleted = false
    `, [group_id, userId]);

    const data = balanceResult.rows[0] || { you_owe: 0, owes_you: 0 };

    res.json({
      success: true,
      data: {
        you_owe: parseFloat(data.you_owe || 0).toFixed(2),
        owes_you: parseFloat(data.owes_you || 0).toFixed(2)
      }
    });

  } catch (error) {
    console.error('Get group balance error:', error);
    res.status(500).json({ success: false, message: 'Failed to fetch group balance', error: error.message });
  }
};

export const getGroupSummary = async (req, res) => {
  try {
    const { group_id } = req.params;
    const userId = req.user.userId;

    const totalRes = await query(
      `SELECT COALESCE(SUM(total_amount),0) AS total_spent FROM expenses WHERE group_id = $1 AND is_deleted = false`,
      [group_id]
    );

    const balanceRes = await query(`
      SELECT
        SUM(CASE WHEN es.owed_share > es.paid_share THEN es.owed_share - es.paid_share ELSE 0 END) AS you_owe,
        SUM(CASE WHEN es.paid_share > es.owed_share THEN es.paid_share - es.owed_share ELSE 0 END) AS owes_you
      FROM expense_shares es
      JOIN expenses e ON es.expense_id = e.id
      WHERE e.group_id = $1 AND es.user_id = $2 AND e.is_deleted = false
    `, [group_id, userId]);

    const recentRes = await query(
      `SELECT e.id, e.description, e.total_amount AS amount, e.currency, e.paid_by, u.name AS paid_by_name, e.created_at AS date
       FROM expenses e
       LEFT JOIN users u ON e.paid_by = u.id
       WHERE e.group_id = $1 AND e.is_deleted = false
       ORDER BY e.created_at DESC
       LIMIT 6`,
      [group_id]
    );

    const total_spent = parseFloat(totalRes.rows[0].total_spent || 0).toFixed(2);
    const balances = balanceRes.rows[0] || { you_owe: 0, owes_you: 0 };

    res.json({
      success: true,
      data: {
        total_spent,
        you_owe: parseFloat(balances.you_owe || 0).toFixed(2),
        owes_you: parseFloat(balances.owes_you || 0).toFixed(2),
        recent_expenses: recentRes.rows
      }
    });
  } catch (error) {
    console.error('Get group summary error:', error);
    res.status(500).json({ success: false, message: 'Failed to fetch group summary', error: error.message });
  }
};


export const leaveGroup = async (req, res) => {
  try {
    console.log('=== LEAVE GROUP REQUEST ===');
    const { group_id } = req.params;
    const userId = req.user.userId;

    const groupId = parseInt(group_id);

    const memberCheck = await query(
      'SELECT role FROM group_members WHERE group_id = $1 AND user_id = $2 AND is_active = true',
      [groupId, userId]
    );

    if (memberCheck.rows.length === 0) {
      return res.status(404).json({ success: false, message: 'You are not a member of this group' });
    }

    const userRole = memberCheck.rows[0].role;

    if (userRole === 'admin') {
      const memberCount = await query(
        'SELECT COUNT(*) as count FROM group_members WHERE group_id = $1 AND is_active = true',
        [groupId]
      );

      if (parseInt(memberCount.rows[0].count) > 1) {
        return res.status(400).json({
          success: false,
          message: 'As the admin, you must delete the group or transfer ownership before leaving'
        });
      }
    }

    const balanceResult = await query(`
      SELECT 
        COALESCE(SUM(CASE WHEN es.user_id = $2 THEN es.owed_share ELSE 0 END), 0) as total_owed_to_user,
        COALESCE(SUM(CASE WHEN es.user_id = $2 THEN es.paid_share ELSE 0 END), 0) as total_paid_by_user
      FROM expense_shares es
      JOIN expenses e ON es.expense_id = e.id
      WHERE e.group_id = $1 AND e.is_deleted = false
    `, [groupId, userId]);

    const totalOwedByUser = parseFloat(balanceResult.rows[0].total_owed_to_user || 0);
    const totalPaidByUser = parseFloat(balanceResult.rows[0].total_paid_by_user || 0);
    const netBalance = totalPaidByUser - totalOwedByUser;

    const userDetails = await query('SELECT email, name FROM users WHERE id = $1', [userId]);
    const userEmail = userDetails.rows[0].email;
    const userName = userDetails.rows[0].name;

    const groupDetails = await query('SELECT name FROM groups WHERE id = $1', [groupId]);
    const groupName = groupDetails.rows[0].name;

    await query(
      'UPDATE group_members SET is_active = false WHERE group_id = $1 AND user_id = $2',
      [groupId, userId]
    );

    await bustGroupCaches(userId, groupId);

    let balanceMessage = '';
    if (netBalance > 0) {
      balanceMessage = `You are owed $${netBalance.toFixed(2)} from other members in the group.`;
    } else if (netBalance < 0) {
      balanceMessage = `You owe $${Math.abs(netBalance).toFixed(2)} to other members in the group.`;
    } else {
      balanceMessage = 'All your expenses are settled.';
    }

    const detailedBalances = await query(`
      SELECT 
        u.name,
        u.email,
        SUM(es.owed_share - es.paid_share) as balance
      FROM expense_shares es
      JOIN expenses e ON es.expense_id = e.id
      JOIN users u ON es.user_id = u.id
      WHERE e.group_id = $1 
        AND e.is_deleted = false
        AND es.user_id != $2
      GROUP BY u.id, u.name, u.email
      HAVING SUM(es.owed_share - es.paid_share) != 0
    `, [groupId, userId]);

    let detailedBreakdown = '';
    if (detailedBalances.rows.length > 0) {
      detailedBreakdown = '\n\nDetailed Breakdown:\n';
      detailedBalances.rows.forEach(row => {
        const balance = parseFloat(row.balance);
        if (balance > 0) {
          detailedBreakdown += `• You owe ${row.name} $${balance.toFixed(2)}\n`;
        } else {
          detailedBreakdown += `• ${row.name} owes you $${Math.abs(balance).toFixed(2)}\n`;
        }
      });
    }

    const emailContent = {
      to: userEmail,
      subject: `You've left "${groupName}" - Expense Summary`,
      html: `
        <h2>You've left the group "${groupName}"</h2>
        <p>Hi ${userName},</p>
        <p>You have successfully left the group <strong>${groupName}</strong>.</p>
        <h3>Your Final Balance:</h3>
        <p><strong>${balanceMessage}</strong></p>
        ${detailedBreakdown ? `<pre style="background: #f5f5f5; padding: 15px; border-radius: 5px;">${detailedBreakdown}</pre>` : ''}
        ${netBalance !== 0 ? `
          <p style="background-color: #fff3cd; padding: 15px; border-radius: 5px; border-left: 4px solid #ffc107;">
            <strong>⚠️ Important:</strong> Please settle your outstanding balances with other group members directly.
          </p>
        ` : ''}
        <p>Thank you for using our expense tracking app!</p>
      `
    };

    try {
      await sendEmail(emailContent);
    } catch (emailError) {
      console.error('Email sending failed:', emailError);
    }

    try {
      await notifyGroupMembers({
        group_id: groupId,
        actor_user_id: userId,
        type: 'member_left',
        title: 'Member Left Group',
        message: `${userName} has left the group`
      });
    } catch (notifyError) {
      console.error('Notification failed:', notifyError);
    }

    res.json({
      success: true,
      message: 'You have successfully left the group',
      balance: {
        netBalance: netBalance.toFixed(2),
        owedToYou: netBalance > 0 ? netBalance.toFixed(2) : '0.00',
        youOwe: netBalance < 0 ? Math.abs(netBalance).toFixed(2) : '0.00',
        hasOutstanding: netBalance !== 0
      }
    });

  } catch (error) {
    console.error('LEAVE GROUP ERROR:', error);
    res.status(500).json({ success: false, message: 'Server error while leaving group' });
  }
};


export const deleteGroup = async (req, res) => {
  try {
    const { group_id } = req.params;
    const userId = req.user.userId;
    const groupId = parseInt(group_id);

    const memberCheck = await query(
      'SELECT role FROM group_members WHERE group_id = $1 AND user_id = $2 AND is_active = true',
      [groupId, userId]
    );

    if (memberCheck.rows.length === 0) {
      return res.status(404).json({ success: false, message: 'Group not found or you are not a member' });
    }

    if (memberCheck.rows[0].role !== 'admin') {
      return res.status(403).json({ success: false, message: 'Only the admin can delete this group' });
    }

    const groupDetails = await query('SELECT name FROM groups WHERE id = $1', [groupId]);
    if (groupDetails.rows.length === 0) {
      return res.status(404).json({ success: false, message: 'Group not found' });
    }

    const groupName = groupDetails.rows[0].name;

    const members = await query(`
      SELECT DISTINCT u.id, u.email, u.name
      FROM group_members gm
      JOIN users u ON gm.user_id = u.id
      WHERE gm.group_id = $1 AND gm.is_active = true
    `, [groupId]);

    let emailsSent = 0;
    let emailsFailed = 0;

    for (const member of members.rows) {
      try {
        const balanceResult = await query(`
          SELECT 
            COALESCE(SUM(es.owed_share), 0) as total_owed_by_user,
            COALESCE(SUM(es.paid_share), 0) as total_paid_by_user
          FROM expense_shares es
          JOIN expenses e ON es.expense_id = e.id
          WHERE e.group_id = $1 AND e.is_deleted = false AND es.user_id = $2
        `, [groupId, member.id]);

        const totalOwedByUser = parseFloat(balanceResult.rows[0].total_owed_by_user || 0);
        const totalPaidByUser = parseFloat(balanceResult.rows[0].total_paid_by_user || 0);
        const netBalance = totalPaidByUser - totalOwedByUser;

        let balanceMessage = '';
        if (netBalance > 0) {
          balanceMessage = `You are owed $${netBalance.toFixed(2)} from other members.`;
        } else if (netBalance < 0) {
          balanceMessage = `You owe $${Math.abs(netBalance).toFixed(2)} to other members.`;
        } else {
          balanceMessage = 'All your expenses are settled.';
        }

        const emailContent = {
          to: member.email,
          subject: `Group "${groupName}" has been deleted - Final Expense Summary`,
          html: `
            <h2>Group "${groupName}" has been deleted</h2>
            <p>Hi ${member.name},</p>
            <p>The group <strong>${groupName}</strong> has been deleted by the admin.</p>
            <h3>Your Final Balance:</h3>
            <p><strong>${balanceMessage}</strong></p>
            ${netBalance !== 0 ? `
              <p style="background-color: #fff3cd; padding: 15px; border-radius: 5px; border-left: 4px solid #ffc107;">
                <strong>⚠️ Important:</strong> Please settle your outstanding balances with other group members directly.
              </p>
            ` : ''}
            <p>Thank you for using our expense tracking app!</p>
          `
        };

        const emailResult = await sendEmail(emailContent);
        if (emailResult.success) emailsSent++; else emailsFailed++;
      } catch (emailError) {
        console.error(`Failed to send email to ${member.name}:`, emailError);
        emailsFailed++;
      }
    }

    await query('UPDATE groups SET is_active = false WHERE id = $1', [groupId]);
    await query('UPDATE group_members SET is_active = false WHERE group_id = $1', [groupId]);

    await bustGroupCaches(userId, groupId);

    res.json({
      success: true,
      message: emailsSent > 0
        ? `Group deleted successfully. ${emailsSent} member(s) have been notified via email.`
        : 'Group deleted successfully.'
    });

  } catch (error) {
    console.error('DELETE GROUP ERROR:', error);
    res.status(500).json({
      success: false,
      message: 'Server error while deleting group',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
};


// ─── Get Group Details (cached) ───────────────────────────────────────────────
export const getGroupDetails = async (req, res) => {
  try {
    const { group_id } = req.params;
    const userId = req.user.userId;
    const groupId = parseInt(group_id);
    const cacheKey = `group_detail:${groupId}`;

    try {
      const cached = await redis().get(cacheKey);
      if (cached) {
        return res.json({ success: true, data: cached, fromCache: true });
      }
    } catch (e) {
      console.error('Redis get error (getGroupDetails):', e);
    }

    const groupQuery = `
      SELECT 
        g.id, g.name, g.description, g.group_type, g.default_currency,
        g.avatar_url, g.invite_code, g.created_at,
        u.name as created_by_name, u.id as created_by_id
      FROM groups g
      LEFT JOIN users u ON g.created_by = u.id
      WHERE g.id = $1 AND g.is_active = true
    `;

    const groupResult = await query(groupQuery, [groupId]);

    if (groupResult.rows.length === 0) {
      return res.status(404).json({ success: false, message: 'Group not found' });
    }

    const memberCountResult = await query(
      'SELECT COUNT(*) as member_count FROM group_members WHERE group_id = $1 AND is_active = true',
      [groupId]
    );

    const userRoleResult = await query(
      'SELECT role FROM group_members WHERE group_id = $1 AND user_id = $2 AND is_active = true',
      [groupId, userId]
    );

    const groupData = {
      ...groupResult.rows[0],
      member_count: parseInt(memberCountResult.rows[0].member_count),
      user_role: userRoleResult.rows.length > 0 ? userRoleResult.rows[0].role : null
    };

    try {
      await redis().set(cacheKey, groupData, { ex: CACHE_TTL.details });
    } catch (e) {
      console.error('Redis set error (getGroupDetails):', e);
    }

    res.json({ success: true, data: groupData });

  } catch (error) {
    console.error('Get group details error:', error);
    res.status(500).json({ success: false, message: 'Failed to fetch group details', error: error.message });
  }
};


export const updateGroup = async (req, res) => {
  try {
    const { group_id } = req.params;
    const userId = req.user.userId;
    const { name, description } = req.body;
    const groupId = parseInt(group_id);

    if (!name || !name.trim()) {
      return res.status(400).json({ success: false, message: 'Group name is required' });
    }

    const memberCheck = await query(
      'SELECT role FROM group_members WHERE group_id = $1 AND user_id = $2 AND is_active = true',
      [groupId, userId]
    );

    if (memberCheck.rows.length === 0) {
      return res.status(404).json({ success: false, message: 'Group not found or you are not a member' });
    }

    if (memberCheck.rows[0].role !== 'admin') {
      return res.status(403).json({ success: false, message: 'Only the admin can edit group details' });
    }

    const updateResult = await query(
      'UPDATE groups SET name = $1, description = $2, updated_at = NOW() WHERE id = $3 RETURNING *',
      [name.trim(), description ? description.trim() : null, groupId]
    );

    if (updateResult.rows.length === 0) {
      return res.status(404).json({ success: false, message: 'Group not found' });
    }

    await bustGroupCaches(userId, groupId);

    res.json({ success: true, message: 'Group updated successfully', data: updateResult.rows[0] });

  } catch (error) {
    console.error('Update group error:', error);
    res.status(500).json({ success: false, message: 'Server error while updating group' });
  }
};


export const declineInvitation = async (req, res) => {
  try {
    const { token } = req.params;
    const userId = req.user && req.user.userId;

    if (!userId) {
      return res.status(401).json({ success: false, message: 'Authentication required' });
    }

    const invResult = await query(
      'SELECT * FROM group_invitations WHERE invitation_token = $1',
      [token]
    );

    if (invResult.rows.length === 0) {
      return res.status(404).json({ success: false, message: 'Invitation not found' });
    }

    const invitation = invResult.rows[0];

    if (invitation.status !== 'pending') {
      return res.status(400).json({ success: false, message: `Invitation is already ${invitation.status}` });
    }

    if (invitation.user_id && invitation.user_id !== userId) {
      return res.status(403).json({ success: false, message: 'This invitation was not issued for your account' });
    }

    if (!invitation.user_id) {
      const userResult = await query('SELECT email FROM users WHERE id = $1', [userId]);
      const currentEmail = userResult.rows[0]?.email;

      if (invitation.invitee_email && currentEmail &&
        invitation.invitee_email.toLowerCase() !== currentEmail.toLowerCase()) {
        return res.status(403).json({ success: false, message: 'This invitation email does not match your account email' });
      }
    }

    await query(
      `UPDATE group_invitations SET status = 'declined', declined_at = NOW(), user_id = $1 WHERE id = $2`,
      [userId, invitation.id]
    );

    res.json({ success: true, message: 'Invitation declined successfully' });

  } catch (error) {
    console.error('Decline invitation error:', error);
    res.status(500).json({ success: false, message: 'Server error during invitation decline.' });
  }
};


export const removeMember = async (req, res) => {
  try {
    const { group_id, user_id } = req.params;
    const requesterId = req.user.userId;
    const groupId = parseInt(group_id);
    const targetUserId = parseInt(user_id);

    const requesterCheck = await query(
      'SELECT role FROM group_members WHERE group_id = $1 AND user_id = $2 AND is_active = true',
      [groupId, requesterId]
    );

    if (requesterCheck.rows.length === 0) {
      return res.status(404).json({ success: false, message: 'Group not found or you are not a member' });
    }
    if (requesterCheck.rows[0].role !== 'admin') {
      return res.status(403).json({ success: false, message: 'Only the admin can remove members' });
    }

    if (targetUserId === requesterId) {
      return res.status(400).json({ success: false, message: 'Use Leave Group to remove yourself' });
    }

    const targetCheck = await query(
      'SELECT role FROM group_members WHERE group_id = $1 AND user_id = $2 AND is_active = true',
      [groupId, targetUserId]
    );

    if (targetCheck.rows.length === 0) {
      return res.status(404).json({ success: false, message: 'Member not found in this group' });
    }

    if (targetCheck.rows[0].role === 'admin') {
      return res.status(400).json({ success: false, message: 'Cannot remove another admin. Transfer ownership first.' });
    }

    const targetUser = await query('SELECT name, email FROM users WHERE id = $1', [targetUserId]);
    const targetName = targetUser.rows[0]?.name || 'Member';

    const balanceResult = await query(`
      SELECT
        COALESCE(SUM(es.paid_share), 0) as total_paid,
        COALESCE(SUM(es.owed_share), 0) as total_owed
      FROM expense_shares es
      JOIN expenses e ON es.expense_id = e.id
      WHERE e.group_id = $1 AND e.is_deleted = false AND es.user_id = $2
    `, [groupId, targetUserId]);

    const paid = parseFloat(balanceResult.rows[0].total_paid || 0);
    const owed = parseFloat(balanceResult.rows[0].total_owed || 0);
    const netBalance = paid - owed;

    await query(
      'UPDATE group_members SET is_active = false WHERE group_id = $1 AND user_id = $2',
      [groupId, targetUserId]
    );

    await bustGroupCaches(targetUserId, groupId);

    const groupDetails = await query('SELECT name FROM groups WHERE id = $1', [groupId]);
    const groupName = groupDetails.rows[0]?.name || 'the group';

    try {
      await query(
        `INSERT INTO notifications (user_id, group_id, type, title, message) VALUES ($1, $2, $3, $4, $5)`,
        [targetUserId, groupId, 'member_left', 'Removed from Group', `You have been removed from "${groupName}" by the admin.`]
      );
    } catch (notifyErr) {
      console.error('Notification error (non-fatal):', notifyErr);
    }

    try {
      await notifyGroupMembers({
        group_id: groupId,
        actor_user_id: targetUserId,
        type: 'member_left',
        title: 'Member Removed',
        message: `${targetName} has been removed from the group`,
      });
    } catch (notifyErr) {
      console.error('Group notification error (non-fatal):', notifyErr);
    }

    res.json({
      success: true,
      message: `${targetName} has been removed from the group`,
      balance: { netBalance: netBalance.toFixed(2), hasOutstanding: netBalance !== 0 },
    });

  } catch (error) {
    console.error('Remove member error:', error);
    res.status(500).json({ success: false, message: 'Server error while removing member' });
  }
};


export const getUserActivity = async (req, res) => {
  try {
    const { user_id } = req.params;
    const userId = parseInt(user_id);

    if (!userId) {
      return res.status(400).json({ success: false, message: 'User ID is required' });
    }

    const activityResult = await query(`
      SELECT 
        e.id, e.description, e.total_amount AS amount, e.currency,
        e.created_at AS date, e.group_id, g.name AS group_name,
        u.name AS paid_by_name, u.id AS paid_by_id,
        es.paid_share, es.owed_share,
        CASE WHEN e.paid_by = $1 THEN 'you_paid' ELSE 'you_owe' END AS type
      FROM expenses e
      JOIN expense_shares es ON es.expense_id = e.id AND es.user_id = $1
      LEFT JOIN groups g ON e.group_id = g.id
      LEFT JOIN users u ON e.paid_by = u.id
      WHERE e.is_deleted = false
      ORDER BY e.created_at DESC
    `, [userId]);

    const activities = activityResult.rows.map(row => ({
      id: row.id,
      description: row.description,
      amount: parseFloat(row.amount || 0).toFixed(2),
      currency: row.currency || 'USD',
      date: row.date,
      group_id: row.group_id,
      group_name: row.group_name || 'Personal',
      paid_by_name: row.paid_by_name,
      paid_by_id: row.paid_by_id,
      paid_share: parseFloat(row.paid_share || 0).toFixed(2),
      owed_share: parseFloat(row.owed_share || 0).toFixed(2),
      type: row.type,
    }));

    res.json({ success: true, data: activities, total: activities.length });

  } catch (error) {
    console.error('Get user activity error:', error);
    res.status(500).json({ success: false, message: 'Failed to fetch user activity', error: error.message });
  }
};

export const getFriends = async (req, res) => {
  try {
    const userId = req.user?.userId;
    if (!userId) return res.status(401).json({ success: false, message: 'Unauthorized' });

    const result = await query(`
      SELECT DISTINCT
        u.id, u.name, u.email,
        COUNT(DISTINCT g.id) as shared_groups
      FROM users u
      JOIN group_members gm1 ON gm1.user_id = u.id AND gm1.is_active = true
      JOIN group_members gm2 ON gm2.group_id = gm1.group_id AND gm2.user_id = $1 AND gm2.is_active = true
      JOIN groups g ON g.id = gm1.group_id AND g.is_active = true
      WHERE u.id != $1
      GROUP BY u.id, u.name, u.email
      ORDER BY u.name ASC
    `, [userId]);

    res.json({ success: true, data: result.rows });
  } catch (error) {
    console.error('Get friends error:', error);
    res.status(500).json({ success: false, message: 'Failed to fetch friends' });
  }
};