import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import authRoutes from './src/routes/auth.js';
import groupRoutes from './src/routes/group.js';
import expenseRoutes from './src/routes/expense.js';
import dashboardRoutes from './src/routes/dashboardRoutes.js';
import userRoutes from './src/routes/user.js';
import businessRoutes from './src/routes/businessRoutes.js';
import customerRoutes from './src/routes/customerRoutes.js';

dotenv.config();

const app = express();

app.use(cors());
app.use(express.json());

app.use('/api', dashboardRoutes);
app.use('/api', businessRoutes);
app.use('/api', authRoutes);
app.use('/api', groupRoutes);
app.use('/api', customerRoutes);   // ← moved UP before expenseRoutes
app.use('/api', expenseRoutes);
app.use('/api', userRoutes);

app.get('/', (req, res) => {
  res.json({ status: 'OK', message: 'SplitBill API is running' });
});

// ✅ Export for Vercel
export default app;

// ✅ Only listen locally
if (process.env.NODE_ENV !== 'production') {
  const PORT = process.env.PORT || 3000;
  app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
  });
}