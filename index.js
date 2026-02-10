require("dotenv").config();
const TelegramBot = require("node-telegram-bot-api");
const fs = require("fs");
const path = require("path");
const express = require("express");

const token = process.env.BOT_TOKEN;
const BASE_PATH = path.join(__dirname, "materials");
const isProduction = process.env.NODE_ENV === "production";

const app = express();
app.use(express.json());

const bot = isProduction
  ? new TelegramBot(token)
  : new TelegramBot(token, { polling: true });

if (isProduction) {
  const url = process.env.RENDER_EXTERNAL_URL;
  bot.setWebHook(`${url}/bot${token}`);
  app.post(`/bot${token}`, (req, res) => {
    bot.processUpdate(req.body);
    res.sendStatus(200);
  });
  app.listen(process.env.PORT || 3000);
}

console.log("✅ Bot running");

// ---------------- SESSION ----------------
bot.session = {};

// ---------------- UTILS ----------------
const getDirs = (p) =>
  fs.existsSync(p)
    ? fs.readdirSync(p).filter((f) =>
        fs.statSync(path.join(p, f)).isDirectory()
      )
    : [];

const getFiles = (p) =>
  fs.existsSync(p)
    ? fs.readdirSync(p).filter((f) =>
        fs.statSync(path.join(p, f)).isFile()
      )
    : [];

// ---------------- START ----------------
bot.onText(/\/start/, async (msg) => {
  const chatId = msg.chat.id;
  const years = getDirs(BASE_PATH);

  if (!years.length)
    return bot.sendMessage(chatId, "⚠ No materials found.");

  bot.session[chatId] = { years };

  const keyboard = years.map((y, i) => [
    { text: y.replace("_", " "), callback_data: `y|${i}` },
  ]);

  await bot.sendMessage(chatId, "📚 Select Academic Year", {
    reply_markup: { inline_keyboard: keyboard },
  });
});

// ---------------- CALLBACK ----------------
bot.on("callback_query", async (q) => {
  const chatId = q.message.chat.id;
  const [type, index] = q.data.split("|");
  const s = bot.session[chatId];

  try {
    // -------- YEAR --------
    if (type === "y") {
      s.year = s.years[index];
      const semesters = getDirs(path.join(BASE_PATH, s.year));
      s.semesters = semesters;

      const kb = semesters.map((x, i) => [
        { text: x.replace("_", " "), callback_data: `s|${i}` },
      ]);

      return bot.sendMessage(chatId, "📆 Select Semester", {
        reply_markup: { inline_keyboard: kb },
      });
    }

    // -------- SEMESTER --------
    if (type === "s") {
      s.semester = s.semesters[index];
      const cats = getDirs(path.join(BASE_PATH, s.year, s.semester));
      s.categories = cats;

      const kb = cats.map((x, i) => [
        { text: x.toUpperCase(), callback_data: `c|${i}` },
      ]);

      return bot.sendMessage(chatId, "📂 Select Category", {
        reply_markup: { inline_keyboard: kb },
      });
    }

    // -------- CATEGORY --------
    if (type === "c") {
      s.category = s.categories[index];
      const courses = getDirs(
        path.join(BASE_PATH, s.year, s.semester, s.category),
      );
      s.courses = courses;

      const kb = courses.map((x, i) => [
        { text: x.replace("_", " "), callback_data: `f|${i}` },
      ]);

      return bot.sendMessage(chatId, "📘 Select Course", {
        reply_markup: { inline_keyboard: kb },
      });
    }

    // -------- FILES --------
    if (type === "f") {
      const course = s.courses[index];
      const fullPath = path.join(
        BASE_PATH,
        s.year,
        s.semester,
        s.category,
        course,
      );

      const files = getFiles(fullPath);
      if (!files.length)
        return bot.sendMessage(chatId, "⚠ No files found.");

      for (const file of files) {
        const fp = path.join(fullPath, file);
        if (s.category === "videos") {
          await bot.sendMessage(chatId, fs.readFileSync(fp, "utf8"));
        } else {
          await bot.sendDocument(chatId, fp);
        }
      }

      return bot.sendMessage(chatId, "✅ Finished");
    }

    await bot.answerCallbackQuery(q.id);
  } catch (e) {
    console.error(e);
    bot.sendMessage(chatId, "❌ Error occurred");
  }
});