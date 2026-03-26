import express from 'express';
import {
  getCustomers,
  createCustomer,
  updateCustomer,
  deleteCustomer,
  getTransactions,
  addTransaction,
  deleteTransaction,
  updateTransaction,
  getUploadUrl,
} from '../controllers/customerController.js';
import { authenticate } from '../middleware/auth.js';

const router = express.Router();

// ── Upload URL (S3) ───────────────────────────────────────────────────────────
router.get('/upload-url', authenticate, getUploadUrl);
// ── Customers ─────────────────────────────────────────────────────────────────
router.get('/customers', authenticate, getCustomers);
router.post('/customers', authenticate, createCustomer);
router.put('/customers/:customer_id', authenticate, updateCustomer);
router.delete('/customers/:customer_id', authenticate, deleteCustomer);

// ── Ledger Transactions ───────────────────────────────────────────────────────
router.get('/customers/:customer_id/transactions', authenticate, getTransactions);
router.post('/customers/:customer_id/transactions', authenticate, addTransaction);
router.put('/customers/:customer_id/transactions/:transaction_id', authenticate, updateTransaction);
router.delete('/customers/:customer_id/transactions/:transaction_id', authenticate, deleteTransaction);

export default router;