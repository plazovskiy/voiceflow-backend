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

const MAX_AUDIO_SIZE_MB = 25;

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_AUDIO_SIZE_MB * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const allowed = ['audio/webm', 'audio/ogg', 'audio/mp4', 'audio/wav', 'audio/mpeg', 'audio/webm;codecs=opus'];
    const ok = allowed.some(t => file.mimetype.startsWith(t.split(';')[0]));
    ok ? cb(null, true) : cb(new AppError('Invalid audio format', 400));
  }
});

const transcribeLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 60, // up to 60 chunks/min (fine-grained chunks)
  message: { error: 'Too many requests, slow down' }
});

// ── Estimate audio duration from file size ────────────────────────────────────
// webm/opus ~20kb/sec is a rough estimate; good enough for billing
function estimateDurationSeconds(fileSizeBytes) {
  const bytesPerSecond = 20000; // ~20kb/s for webm/opus at default quality
  return Math.ceil(fileSizeBytes / bytesPerSecond);
}

// ── Check limits ──────────────────────────────────────────────────────────────
async function checkLimits(userId, subscription, estimatedSeconds) {
  if (subscription.plan === 'PRO' && subscription.status === 'ACTIVE') {
    if (subscription.expiresAt && subscription.expiresAt < new Date()) {
      await prisma.subscription.update({ where: { userId }, data: { status: 'EXPIRED' } });
      throw new AppError('Your subscription has expired. Please renew.', 402);
    }
    return { allowed: true, secondsRemaining: null };
  }

  const used = subscription.trialSecondsUsed || 0;
  const limit = subscription.trialLimitSeconds || 600;
  const remaining = limit - used;

  if (remaining <= 0) {
    throw new AppError(
      `Trial limit reached (${Math.floor(limit / 60)} min). Upgrade to Pro for unlimited use.`,
      429
    );
  }

  return { allowed: true, secondsRemaining: remaining };
}

// ── POST /api/transcribe ───────────────────────────────────────────────────────
router.post('/', authenticate, transcribeLimiter, upload.single('audio'), async (req, res, next) => {
  try {
    if (!req.file) throw new AppError('Audio file required', 400);

    const { user } = req;
    if (!user.subscription) throw new AppError('Account setup incomplete', 400);

    const estimatedSeconds = estimateDurationSeconds(req.file.size);

    // Check limits before calling OpenAI
    const { secondsRemaining } = await checkLimits(user.id, user.subscription, estimatedSeconds);

    const language = req.body.language && req.body.language !== 'auto'
      ? req.body.language : null;

    // ── Call Whisper ────────────────────────────────────────────────────────
    const formData = new FormData();
    formData.append('file', req.file.buffer, {
      filename: 'audio.webm',
      contentType: req.file.mimetype,
    });
    formData.append('model', 'whisper-1');
    formData.append('response_format', 'verbose_json'); // gives us actual duration!
    if (language) formData.append('language', language);

    const whisperRes = await fetch('https://api.openai.com/v1/audio/transcriptions', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${process.env.OPENAI_API_KEY}`, ...formData.getHeaders() },
      body: formData,
    });

    if (!whisperRes.ok) {
      const err = await whisperRes.json().catch(() => ({}));
      console.error('[Whisper error]', err);
      throw new AppError('Speech recognition failed, please try again', 502);
    }

    const whisperData = await whisperRes.json();
    const rawText = whisperData.text?.trim() || '';
    const actualSeconds = Math.ceil(whisperData.duration || estimatedSeconds);

    // Log every Whisper response for debugging
    const segments = whisperData.segments || [];
    const avgNoSpeechProb = segments.length > 0
      ? segments.reduce((sum, s) => sum + (s.no_speech_prob || 0), 0) / segments.length
      : 0;
    console.log(`[Whisper] text="${rawText}" duration=${actualSeconds}s no_speech_prob=${avgNoSpeechProb.toFixed(3)} segments=${segments.length}`);

    // ── Hallucination filter ────────────────────────────────────────────────
    // Whisper generates fake subtitles/credits on silence or low audio
    const HALLUCINATION_PATTERNS = [
      /субтитр/i,
      /subtitl/i,
      /перевод/i,
      /translated by/i,
      /с вами был/i,
      /amara\.org/i,
      /добавил\s+\w+/i,
      /редактор\s+субтитр/i,
      /transcript/i,
      /caption/i,
      /www\./i,
      /http/i,
      /подписывайтесь/i,
      /subscribe/i,
      /youtube/i,
      /©/i,
      /copyright/i,
      /all rights reserved/i,
    ];

    // ── Block full hallucinations ────────────────────────────────────────────
    const isHallucination =
      avgNoSpeechProb > 0.5 ||
      HALLUCINATION_PATTERNS.some(p => p.test(rawText));

    if (isHallucination) {
      console.log(`[Whisper] blocked hallucination: "${rawText}"`);
      return res.json({ text: '', plan: user.subscription.plan, filtered: true });
    }

    // ── Strip hallucination suffixes from real speech ─────────────────────────
    // Sometimes Whisper appends junk to real speech
    const STRIP_PATTERNS = [
      /[.!?,]?\s*с вами был[^.!?]*/gi,
      /[.!?,]?\s*субтитр[^.!?]*/gi,
      /[.!?,]?\s*subtitl[^.!?]*/gi,
      /[.!?,]?\s*перевод[^.!?]*/gi,
      /[.!?,]?\s*translated by[^.!?]*/gi,
      /[.!?,]?\s*добавил\s+\w+[^.!?]*/gi,
      /[.!?,]?\s*подписывайтесь[^.!?]*/gi,
      /[.!?,]?\s*amara\.org[^.!?]*/gi,
      /\s*©.*$/gi,
      /\s*http\S+/gi,
      /\s*www\.\S+/gi,
    ];

    let text = rawText;
    for (const pattern of STRIP_PATTERNS) {
      text = text.replace(pattern, '').trim();
    }

    console.log(`[Whisper] final text: "${text}" (was: "${rawText}")`);
    if (!text) throw new AppError('No speech detected', 400);

    // ── Deduct from trial ───────────────────────────────────────────────────
    if (user.subscription.plan !== 'PRO') {
      await prisma.subscription.update({
        where: { userId: user.id },
        data: { trialSecondsUsed: { increment: actualSeconds } }
      });
    }

    // Log async
    prisma.usageLog.create({
      data: { userId: user.id, language: language || 'auto', duration: actualSeconds, success: true }
    }).catch(console.error);

    const usedAfter = (user.subscription.trialSecondsUsed || 0) + actualSeconds;
    const limit = user.subscription.trialLimitSeconds || 600;

    res.json({
      text,
      plan: user.subscription.plan,
      ...(user.subscription.plan === 'TRIAL' && {
        trialSecondsUsed: usedAfter,
        trialSecondsLimit: limit,
        trialSecondsRemaining: Math.max(0, limit - usedAfter),
        trialMinutesRemaining: Math.max(0, (limit - usedAfter) / 60).toFixed(1),
      }),
    });

  } catch (error) {
    next(error);
  }
});

module.exports = router;
