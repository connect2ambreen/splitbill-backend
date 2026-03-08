import express from 'express';
import { authenticate } from '../middleware/auth.js';
import {
  addExpense, getExpensesByUser, getExpensesByGroup,
  deleteExpense, updateExpense, getGroupBalance,
  requestSettlement, respondToSettlement,
  getExpenseDetails, getPendingSettlements,
  getSettlementDetail, getNotifications, markNotificationsRead
} from '../controllers/expense.js';

const router = express.Router();

// ── Expense routes ────────────────────────────────────────
router.post('/expense/add/:group_id', authenticate, addExpense);
router.get('/expense/user/:user_id', authenticate, getExpensesByUser);
router.get('/expenses/group/:group_id', authenticate, getExpensesByGroup);
router.put('/expense/:expense_id', authenticate, updateExpense);
router.get('/balances/group/:group_id', authenticate, getGroupBalance);

// ── Notification routes (BEFORE catch-all) ────────────────
router.get('/notifications', authenticate, getNotifications);
router.put('/notifications/read', authenticate, markNotificationsRead);

// ── Settlement routes (specific BEFORE parameterized) ─────
router.get('/settle-expense/pending', authenticate, getPendingSettlements);
router.get('/settle-expense/detail/:settlement_id', authenticate, getSettlementDetail);
router.post('/settle-expense/respond/:settlement_id', authenticate, respondToSettlement);
router.post('/settle-expense/:group_id', authenticate, requestSettlement);

// ── Catch-all param routes LAST ───────────────────────────
router.delete('/:expense_id', authenticate, deleteExpense);
router.get('/:expense_id', authenticate, getExpenseDetails);

export default router;