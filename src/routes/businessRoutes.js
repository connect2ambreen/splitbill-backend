import express from 'express';
import {
  createBusiness,
  getUserBusiness,
  updateBusiness,
  deleteBusiness,
} from '../controllers/businessController.js';
import { authenticate } from '../middleware/auth.js'; // ← replace 'protect' with your actual middleware name

const router = express.Router();

router.post('/business', authenticate, createBusiness);
router.get('/business', authenticate, getUserBusiness);
router.put('/business/:business_id', authenticate, updateBusiness);
router.delete('/business/:business_id', authenticate, deleteBusiness);

export default router;