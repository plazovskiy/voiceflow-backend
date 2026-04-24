const express = require('express');
const multer = require('multer');
const FormData = require('form-data');
const fetch = require('node-fetch');
const rateLimit = require('express-rate-limit');
const { PrismaClient } = require('@prisma/client');
const { authenticate } = require('../middleware/auth');
const { AppError } = require('../middleware/errorHandler');

const router = express.Router();
const prisma = new PrismaClient();

const TRIAL_DAILY_LIMIT = 10;
const MAX_AUDIO_SIZE_MB = 25; // Whisper API limit

// In-memory upload (no disk writes)
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_AUDIO_SIZE_MB * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const allowed = ['audio/webm', 'audio/ogg', 'audio/mp4', 'audio/wav', 'audio/mpeg'];
    if (allowed.includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new AppError('Invalid audio format', 400));
    }
  }
});

// Strict rate limit for transcription endpoint
const transcribeLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 20,
  message: { error: 'Too many requests, slow down' }
});

// ─── Check and update trial limits ───────────────────────────────────────────
async function checkAndUpdateLimits(userId, subscription) {
  // PRO users have no limits
  if (subscription.plan === 'PRO' && subscription.status === 'ACTIVE') {
    // Check if subscription expired
    if (subscription.expiresAt && subscription.expiresAt < new Date()) {
      await prisma.subscription.update({
        where: { userId },
        data: { status: 'EXPIRED' }
      });
      throw new AppError('Your subscription has expired. Please renew.', 402);
    }
    return { allowed: true, remaining: null };
  }

  // Reset daily counter if it's a new day
  const now = new Date();
  const resetDate = new Date(subscription.trialResetDate);
  const isNewDay =
    now.getUTCFullYear() !== resetDate.getUTCFullYear() ||
    now.getUTCMonth() !== resetDate.getUTCMonth() ||
    now.getUTCDate() !== resetDate.getUTCDate();

  if (isNewDay) {
    await prisma.subscription.update({
      where: { userId },
      data: { trialUsedToday: 0, trialResetDate: now }
    });
    subscription.trialUsedToday = 0;
  }

  if (subscription.trialUsedToday >= TRIAL_DAILY_LIMIT) {
    throw new AppError(
      `Daily trial limit reached (${TRIAL_DAILY_LIMIT}/day). Upgrade to Pro for unlimited use.`,
      429
    );
  }

  // Increment counter
  await prisma.subscription.update({
    where: { userId },
    data: { trialUsedToday: { increment: 1 } }
  });

  return {
    allowed: true,
    remaining: TRIAL_DAILY_LIMIT - subscription.trialUsedToday - 1
  };
}

// ─── POST /api/transcribe ─────────────────────────────────────────────────────
router.post('/', authenticate, transcribeLimiter, upload.single('audio'), async (req, res, next) => {
  try {
    if (!req.file) {
      throw new AppError('Audio file required', 400);
    }

    const { user } = req;
    if (!user.subscription) {
      throw new AppError('Account setup incomplete', 400);
    }

    // Check limits BEFORE calling OpenAI (saves costs on blocked requests)
    const { remaining } = await checkAndUpdateLimits(user.id, user.subscription);

    // Determine language
    const language = req.body.language && req.body.language !== 'auto'
      ? req.body.language
      : null; // null = auto-detect in Whisper

    // ── Call OpenAI Whisper API ──────────────────────────────────────────────
    const formData = new FormData();
    formData.append('file', req.file.buffer, {
      filename: 'audio.webm',
      contentType: req.file.mimetype,
    });
    formData.append('model', 'whisper-1');
    formData.append('response_format', 'json');
    if (language) {
      formData.append('language', language);
    }

    const whisperResponse = await fetch('https://api.openai.com/v1/audio/transcriptions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${process.env.OPENAI_API_KEY}`,
        ...formData.getHeaders(),
      },
      body: formData,
    });

    if (!whisperResponse.ok) {
      const errBody = await whisperResponse.json().catch(() => ({}));
      console.error('[Whisper error]', errBody);
      throw new AppError('Speech recognition failed, please try again', 502);
    }

    const whisperData = await whisperResponse.json();
    const text = whisperData.text?.trim();

    if (!text) {
      throw new AppError('No speech detected', 400);
    }

    // Log usage (async, don't block response)
    prisma.usageLog.create({
      data: {
        userId: user.id,
        language: language || 'auto',
        success: true,
      }
    }).catch(console.error);

    res.json({
      text,
      language: language || 'auto',
      plan: user.subscription.plan,
      ...(remaining !== null && { trialRemaining: remaining }),
    });

  } catch (error) {
    next(error);
  }
});

module.exports = router;
