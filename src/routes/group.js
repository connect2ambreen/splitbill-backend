import express from 'express';
import {
  createGroup, inviteToGroup, getUserGroups, getGroupMembers,
  getAllUsers, addUsersToGroup, getGroupBalance, getGroupDetails, getGroupSummary,
  leaveGroup, deleteGroup, searchUsers, verifyInvitation, acceptInvitation,
  getPendingInvitations, updateGroup, declineInvitation,
  removeMember, getUserActivity
} from '../controllers/group.js';
import { authenticate, isAdmin } from '../middleware/auth.js';

const router = express.Router();

router.post('/create-group', authenticate, createGroup);
router.post('/invite/:group_id', authenticate, isAdmin, inviteToGroup);

// Search users by email and check membership/pending invitation
router.get('/users/search', authenticate, searchUsers);

// Invitation verification and acceptance
router.get('/invitations/verify/:token', verifyInvitation);
router.post('/invitations/accept/:token', authenticate, acceptInvitation);
router.post('/invitations/decline/:token', authenticate, declineInvitation);
router.get('/invitations/pending', authenticate, getPendingInvitations);

router.get('/groups/user/:user_id', authenticate, getUserGroups);
router.get('/groups/:group_id/members', authenticate, getGroupMembers);

// Summary (total spent + user balances + recent activity)
router.get('/groups/:group_id/summary', authenticate, getGroupSummary);

router.get('/users/all', authenticate, getAllUsers);
router.post('/groups/:group_id/add-users', authenticate, isAdmin, addUsersToGroup);
router.get('/groups/:group_id/balance', authenticate, getGroupBalance);

// Get group details
router.get('/groups/:group_id', authenticate, getGroupDetails);

// Leave / delete / update group
router.post('/groups/:group_id/leave', authenticate, leaveGroup);
router.delete('/groups/:group_id', authenticate, isAdmin, deleteGroup);
router.put('/groups/:group_id', authenticate, isAdmin, updateGroup);

// ✅ Remove a member (admin only)
router.delete('/groups/:group_id/members/:user_id', authenticate, isAdmin, removeMember);

router.get('/activity/:user_id', authenticate, getUserActivity);



export default router;