import 'dotenv/config';
import { Telegraf } from 'telegraf';
import fs from 'node:fs';
import path from 'node:path';
import { GoogleGenerativeAI } from '@google/generative-ai';

const BOT_TOKEN = process.env.BOT_TOKEN;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const MODEL = process.env.MODEL || 'models/gemini-2.0-flash';

if (!BOT_TOKEN) throw new Error('Missing BOT_TOKEN in .env');
if (!GEMINI_API_KEY) throw new Error('Missing GEMINI_API_KEY in .env');

const bot = new Telegraf(BOT_TOKEN);
const genAI = new GoogleGenerativeAI(GEMINI_API_KEY);
const model = genAI.getGenerativeModel({ model: MODEL });

// --- tiny in-memory user settings (use DB if you like)
const userTargetLang = new Map();   // chatId -> 'en'

// --- logging (JSONL)
const LOG_DIR = path.resolve('logs');
const LOG_FILE = path.join(LOG_DIR, 'messages.jsonl');
if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR, { recursive: true });
function logLine(obj) {
  fs.appendFile(LOG_FILE, JSON.stringify(obj) + '\n', () => {});
}

// --- translator using Gemini
async function translate(text, target = 'en') {
  const prompt = [
    "You are a professional translator.",
    `Task: Detect the input language and translate it into \"${target}\".`,
    "Rules: Keep punctuation, emojis, and line breaks. Respond ONLY with the translated text.",
    "",
    "Text to translate:",
    text
  ].join("\n");

  // 👇 call Gemini with a single-string prompt
  const result = await model.generateContent(prompt);

  const response = result.response;
  const out = response.text();   // <- correct for this SDK
  if (!out) throw new Error('Empty response from model');
  return out.trim();
}


// --- helpers
function parseLangArg(text) {
  // accepts: "/lang en" or "/to en" or "to en: text"
  const m = text.trim().match(/^\/(?:lang|to)\s+([a-z]{2,3})(?:\s|$)/i);
  return m ? m[1].toLowerCase() : null;
}

// --- commands
bot.start((ctx) => {
  userTargetLang.set(ctx.chat.id, 'en');
  ctx.reply(
    `Welcome!  I translate your messages.\n\n` +
    `• Default target language: *English (en)*\n` +
    `• Change target: /lang <code>  e.g., /lang tr\n` +
    `• Quick one-off: /to <code>  e.g., /to ru\n` +
    `• Show id: /id`,
    { parse_mode: 'Markdown' }
  );
});

bot.command('id', (ctx) => ctx.reply(`chat.id = ${ctx.chat.id}`));

bot.command(['lang', 'to'], async (ctx) => {
  const code = parseLangArg(ctx.message.text);
  if (!code) return ctx.reply('Usage: /lang <code>  e.g., /lang en');
  userTargetLang.set(ctx.chat.id, code);
  await ctx.reply(` Target language set to: ${code}`);
});

// --- main handler (translate any non-command text)
bot.on('text', async (ctx) => {
  const txt = ctx.message.text || '';
  if (txt.startsWith('/')) return; // ignore other commands

  const chatId = ctx.chat.id;
  const username = ctx.from?.username || '';
  const name = `${ctx.from?.first_name ?? ''} ${ctx.from?.last_name ?? ''}`.trim();

  // one-off override: "to xx: text" or "/to xx text"
  let target = userTargetLang.get(chatId) || 'en';
  const cmdTarget = parseLangArg(txt);
  const cleanText = cmdTarget
    ? txt.replace(/^\/(?:lang|to)\s+[a-z]{2,3}\s*/i, '') // "/to ru hello"
    : txt.replace(/^to\s+[a-z]{2,3}\s*:\s*/i, '');       // "to ru: hello"
  if (cmdTarget) target = cmdTarget;

  const inputText = cleanText.trim() || txt;

  // small rate limit guard (1 msg/sec per chat)
  if (!bot.context._last) bot.context._last = new Map();
  const last = bot.context._last.get(chatId) || 0;
  const now = Date.now();
  if (now - last < 900) return; // drop spammy duplicates
  bot.context._last.set(chatId, now);

  try {
    logLine({ t: new Date().toISOString(), dir: 'in', chatId, username, name, text: inputText });

    const translated = await translate(inputText, target);

    await ctx.reply(translated, { disable_web_page_preview: true });
    logLine({ t: new Date().toISOString(), dir: 'out', chatId, reply: translated });
  } catch (err) {
    console.error(err);
    await ctx.reply(' Translation failed. Please try again.');
    logLine({ t: new Date().toISOString(), dir: 'error', chatId, error: String(err) });
  }
});

//  start (long polling; for webhook you’d use bot.launch({ webhook: ... }))
bot.launch().then(() => {
  console.log('Translator bot is running.');
}).catch(console.error);

// Graceful stop
process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
