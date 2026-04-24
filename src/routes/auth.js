const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { PrismaClient } = require('@prisma/client');
const { AppError } = require('../middleware/errorHandler');
const { authenticate } = require('../middleware/auth');

const router = express.Router();
const prisma = new PrismaClient();

const SALT_ROUNDS = 12;
const ACCESS_TOKEN_EXPIRE = '1h';
const REFRESH_TOKEN_EXPIRE = '30d';
const REFRESH_TOKEN_EXPIRE_MS = 30 * 24 * 60 * 60 * 1000;

function generateTokens(userId) {
  const accessToken = jwt.sign(
    { userId },
    process.env.JWT_SECRET,
    { expiresIn: ACCESS_TOKEN_EXPIRE }
  );
  const refreshToken = jwt.sign(
    { userId, type: 'refresh' },
    process.env.JWT_REFRESH_SECRET,
    { expiresIn: REFRESH_TOKEN_EXPIRE }
  );
  return { accessToken, refreshToken };
}

// Validate email format
function isValidEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

// ─── Register ────────────────────────────────────────────────────────────────
router.post('/register', async (req, res, next) => {
  try {
    const { email, password } = req.body;

    if (!email || !password) {
      throw new AppError('Email and password are required', 400);
    }
    if (!isValidEmail(email)) {
      throw new AppError('Invalid email format', 400);
    }
    if (password.length < 8) {
      throw new AppError('Password must be at least 8 characters', 400);
    }

    const existing = await prisma.user.findUnique({ where: { email: email.toLowerCase() } });
    if (existing) {
      throw new AppError('Email already registered', 409);
    }

    const passwordHash = await bcrypt.hash(password, SALT_ROUNDS);

    const user = await prisma.user.create({
      data: {
        email: email.toLowerCase(),
        passwordHash,
        subscription: {
          create: {
            plan: 'TRIAL',
            status: 'ACTIVE',
            trialUsedToday: 0,
            trialResetDate: new Date(),
          }
        }
      },
      include: { subscription: true }
    });

    const { accessToken, refreshToken } = generateTokens(user.id);

    await prisma.session.create({
      data: {
        userId: user.id,
        refreshToken,
        expiresAt: new Date(Date.now() + REFRESH_TOKEN_EXPIRE_MS),
      }
    });

    res.status(201).json({
      accessToken,
      refreshToken,
      user: {
        id: user.id,
        email: user.email,
        plan: user.subscription.plan,
        trialUsedToday: user.subscription.trialUsedToday,
      }
    });
  } catch (error) {
    next(error);
  }
});

// ─── Login ───────────────────────────────────────────────────────────────────
router.post('/login', async (req, res, next) => {
  try {
    const { email, password } = req.body;

    if (!email || !password) {
      throw new AppError('Email and password are required', 400);
    }

    const user = await prisma.user.findUnique({
      where: { email: email.toLowerCase() },
      include: { subscription: true }
    });

    // Constant-time comparison to prevent timing attacks
    const passwordValid = user
      ? await bcrypt.compare(password, user.passwordHash)
      : await bcrypt.compare(password, '$2a$12$dummyhashfortimingnormalization');

    if (!user || !passwordValid) {
      throw new AppError('Invalid email or password', 401);
    }

    const { accessToken, refreshToken } = generateTokens(user.id);

    await prisma.session.create({
      data: {
        userId: user.id,
        refreshToken,
        expiresAt: new Date(Date.now() + REFRESH_TOKEN_EXPIRE_MS),
      }
    });

    res.json({
      accessToken,
      refreshToken,
      user: {
        id: user.id,
        email: user.email,
        plan: user.subscription?.plan || 'TRIAL',
        trialUsedToday: user.subscription?.trialUsedToday || 0,
      }
    });
  } catch (error) {
    next(error);
  }
});

// ─── Refresh Token ───────────────────────────────────────────────────────────
router.post('/refresh', async (req, res, next) => {
  try {
    const { refreshToken } = req.body;
    if (!refreshToken) {
      throw new AppError('Refresh token required', 400);
    }

    let decoded;
    try {
      decoded = jwt.verify(refreshToken, process.env.JWT_REFRESH_SECRET);
    } catch {
      throw new AppError('Invalid or expired refresh token', 401);
    }

    const session = await prisma.session.findUnique({
      where: { refreshToken },
      include: { user: { include: { subscription: true } } }
    });

    if (!session || session.expiresAt < new Date()) {
      if (session) await prisma.session.delete({ where: { id: session.id } });
      throw new AppError('Session expired, please login again', 401);
    }

    const { accessToken, refreshToken: newRefreshToken } = generateTokens(session.userId);

    // Rotate refresh token
    await prisma.session.update({
      where: { id: session.id },
      data: {
        refreshToken: newRefreshToken,
        expiresAt: new Date(Date.now() + REFRESH_TOKEN_EXPIRE_MS),
      }
    });

    res.json({
      accessToken,
      refreshToken: newRefreshToken,
      user: {
        id: session.user.id,
        email: session.user.email,
        plan: session.user.subscription?.plan || 'TRIAL',
        trialUsedToday: session.user.subscription?.trialUsedToday || 0,
      }
    });
  } catch (error) {
    next(error);
  }
});

// ─── Logout ──────────────────────────────────────────────────────────────────
router.post('/logout', authenticate, async (req, res, next) => {
  try {
    const { refreshToken } = req.body;
    if (refreshToken) {
      await prisma.session.deleteMany({ where: { refreshToken } });
    }
    res.json({ success: true });
  } catch (error) {
    next(error);
  }
});

module.exports = router;
