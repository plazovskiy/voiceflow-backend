const express = require('express');
const { PrismaClient } = require('@prisma/client');
const { authenticate } = require('../middleware/auth');

const router = express.Router();
const prisma = new PrismaClient();

const TRIAL_DAILY_LIMIT = 10;

// ─── GET /api/user/me ─────────────────────────────────────────────────────────
router.get('/me', authenticate, async (req, res, next) => {
  try {
    const { user } = req;
    const sub = user.subscription;

    // Reset daily counter if new day
    if (sub) {
      const now = new Date();
      const resetDate = new Date(sub.trialResetDate);
      const isNewDay =
        now.getUTCFullYear() !== resetDate.getUTCFullYear() ||
        now.getUTCMonth() !== resetDate.getUTCMonth() ||
        now.getUTCDate() !== resetDate.getUTCDate();

      if (isNewDay) {
        await prisma.subscription.update({
          where: { userId: user.id },
          data: { trialUsedToday: 0, trialResetDate: now }
        });
        sub.trialUsedToday = 0;
      }
    }

    res.json({
      id: user.id,
      email: user.email,
      plan: sub?.plan || 'TRIAL',
      status: sub?.status || 'ACTIVE',
      trialUsedToday: sub?.trialUsedToday || 0,
      trialDailyLimit: TRIAL_DAILY_LIMIT,
      trialRemaining: Math.max(0, TRIAL_DAILY_LIMIT - (sub?.trialUsedToday || 0)),
      subscriptionExpiresAt: sub?.expiresAt || null,
    });
  } catch (error) {
    next(error);
  }
});

// ─── POST /api/user/upgrade (placeholder for payment integration) ─────────────
router.post('/upgrade', authenticate, async (req, res, next) => {
  try {
    // TODO: Integrate payment provider (Stripe, YooKassa, etc.)
    // This endpoint will be called by your payment webhook after successful payment
    res.json({ message: 'Payment integration coming soon' });
  } catch (error) {
    next(error);
  }
});

// ─── POST /api/user/webhook/payment (payment provider callback) ───────────────
router.post('/webhook/payment', express.raw({ type: 'application/json' }), async (req, res, next) => {
  try {
    // TODO: Verify webhook signature from payment provider
    // TODO: Update subscription to PRO on successful payment
    // Example structure:
    // const { userId, plan, expiresAt } = parsePaymentWebhook(req.body);
    // await prisma.subscription.update({
    //   where: { userId },
    //   data: { plan: 'PRO', status: 'ACTIVE', expiresAt }
    // });
    res.json({ received: true });
  } catch (error) {
    next(error);
  }
});

module.exports = router;
