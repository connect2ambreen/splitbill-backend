import express from 'express';
import { authenticate } from '../middleware/auth.js';
import { getDashboardData } from '../controllers/dashboardController.js';

const router = express.Router();

// Single endpoint to return all dashboard data for a user
router.get('/dashboard/:user_id', authenticate, getDashboardData);

export default router;
