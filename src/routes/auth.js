import express, { Router } from 'express';
import { signup, login, forgotPassword, resetPassword, verifyResetCode, googleAuth, facebookAuth, registerBiometric, biometricLogin } from '../controllers/auth.js';

const router = express.Router();

router.post('/signup', signup);

router.post('/login', login);

router.post('/forgot-password', forgotPassword);
router.post('/verify-reset-code', verifyResetCode);
router.post('/reset-password', resetPassword);
router.post('/auth/google', googleAuth);
router.post('/auth/facebook', facebookAuth);
router.post('/auth/biometric/register', registerBiometric);
router.post('/auth/biometric/login', biometricLogin);


export default router;