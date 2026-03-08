// routes/user.js
import express from 'express';
import { updateUserProfile, updateLocale, saveFcmToken } from '../controllers/user.js';
import { authenticate } from '../middleware/auth.js';

const router = express.Router();

console.log('✅ user routes loaded'); // add this

router.put('/users/:id', authenticate, updateUserProfile);
router.patch('/user/locale', authenticate, updateLocale);
//router.post('/user/fcm-token', authenticate, saveFcmToken);
router.post('/user/fcm-token', (req, res, next) => {
  console.log('🚨 FCM ROUTE HIT - method:', req.method, 'url:', req.url);
  console.log('🚨 Headers:', req.headers.authorization);
  next();
}, authenticate, saveFcmToken);

export default router;