const express = require('express');
const { PrismaClient } = require('@prisma/client');
const { authenticate } = require('../middleware/auth');

const router = express.Router();
const prisma = new PrismaClient();

router.get('/me', authenticate, async (req, res, next) => {
  try {
    const { user } = req;
    const sub = user.subscription;

    // Re-fetch subscription fresh from DB to avoid stale cache
    const freshSub = await prisma.subscription.findUnique({
      where: { userId: user.id }
    });

    const used  = freshSub?.trialSecondsUsed  || 0;
    const limit = freshSub?.trialLimitSeconds || 600;

    console.log(`[/me] user=${user.email} used=${used} limit=${limit} remaining=${limit - used}`);

    res.json({
      id: user.id,
      email: user.email,
      plan: freshSub?.plan || 'TRIAL',
      status: freshSub?.status || 'ACTIVE',
      trialSecondsUsed: used,
      trialSecondsLimit: limit,
      trialSecondsRemaining: Math.max(0, limit - used),
      trialMinutesRemaining: Math.max(0, (limit - used) / 60).toFixed(1),
      subscriptionExpiresAt: freshSub?.expiresAt || null,
    });
  } catch (error) {
    next(error);
  }
});

router.post('/upgrade', authenticate, async (req, res, next) => {
  try {
    res.json({ message: 'Payment integration coming soon' });
  } catch (error) {
    next(error);
  }
});

router.post('/webhook/payment', express.raw({ type: 'application/json' }), async (req, res, next) => {
  try {
    // TODO: verify webhook + update subscription to PRO
    res.json({ received: true });
  } catch (error) {
    next(error);
  }
});

module.exports = router;
