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

let bot;

if (isProduction) {
  bot = new TelegramBot(token);
  const url = process.env.RENDER_EXTERNAL_URL;
  bot.setWebHook(`${url}/bot${token}`);
  app.post(`/bot${token}`, (req, res) => {
    bot.processUpdate(req.body);
    res.sendStatus(200);
  });
  app.listen(process.env.PORT || 3000, () => console.log("Server running (Webhook)"));
} else {
  bot = new TelegramBot(token, { polling: true });
  console.log("Bot running in polling mode");
}

// Memory Cache to store paths and avoid long callback strings (Fixes BUTTON_DATA_INVALID)
const sessionCache = new Map();

// ---------- Utilities ----------

function safeGetFolders(dirPath) {
  try {
    if (!fs.existsSync(dirPath)) return [];
    return fs.readdirSync(dirPath).filter((file) => fs.statSync(path.join(dirPath, file)).isDirectory());
  } catch (err) { return []; }
}

function safeGetFiles(dirPath) {
  try {
    if (!fs.existsSync(dirPath)) return [];
    return fs.readdirSync(dirPath).filter((file) => fs.statSync(path.join(dirPath, file)).isFile());
  } catch (err) { return []; }
}

// ---------- START ----------

bot.onText(/\/start/, async (msg) => {
  const chatId = msg.chat.id;
  try {
    const years = safeGetFolders(BASE_PATH);
    if (!years.length) return bot.sendMessage(chatId, "No academic years available.");

    const keyboard = years.map((year) => [
      { text: year.replace(/_/g, " "), callback_data: `yr|${year}` },
    ]);

    await bot.sendMessage(chatId, "📚 Select Academic Year:", {
      reply_markup: { inline_keyboard: keyboard },
    });
  } catch (err) {
    console.error(err);
    bot.sendMessage(chatId, "⚠ Something went wrong.");
  }
});

// ---------- CALLBACK ----------

bot.on("callback_query", async (query) => {
  const chatId = query.message.chat.id;
  const messageId = query.message.message_id;

  try {
    const parts = query.data.split("|");
    const type = parts[0];

    // YEAR selection -> Show Semesters/Categories
    if (type === "yr") {
      const year = parts[1];
      const yearPath = path.join(BASE_PATH, year);
      const categories = safeGetFolders(yearPath);

      const keyboard = categories.map((cat) => [
        { text: cat.replace(/_/g, " ").toUpperCase(), callback_data: `cat|${year}|${cat}` },
      ]);
      keyboard.push([{ text: "🏠 Menu", callback_data: "menu" }]);

      await bot.editMessageText(`📖 Year: ${year}\nSelect Semester/Category:`, {
        chat_id: chatId,
        message_id: messageId,
        reply_markup: { inline_keyboard: keyboard },
      });
    }

    // CATEGORY selection -> Show Courses
    else if (type === "cat") {
      const [_, year, cat] = parts;
      const catPath = path.join(BASE_PATH, year, cat);
      const courses = safeGetFolders(catPath);

      // We use a cache key if course names are too long
      const keyboard = courses.map((course, idx) => {
        const cacheKey = `${year}_${cat}_${idx}`;
        sessionCache.set(cacheKey, path.join(catPath, course));
        return [{ text: course.replace(/_/g, " "), callback_data: `crs|${cacheKey}` }];
      });

      keyboard.push([
        { text: "⬅ Back", callback_data: `yr|${year}` },
        { text: "🏠 Menu", callback_data: "menu" },
      ]);

      await bot.editMessageText(`📂 Select Course:`, {
        chat_id: chatId,
        message_id: messageId,
        reply_markup: { inline_keyboard: keyboard },
      });
    }

    // COURSE selection -> Send files or subfolders
    else if (type === "crs") {
      const cacheKey = parts[1];
      const coursePath = sessionCache.get(cacheKey);

      if (!coursePath) return bot.sendMessage(chatId, "Session expired. Use /start");

      const subfolders = safeGetFolders(coursePath);
      if (subfolders.length > 0) {
        const keyboard = subfolders.map((sub, idx) => {
          const subKey = `${cacheKey}_s${idx}`;
          sessionCache.set(subKey, path.join(coursePath, sub));
          return [{ text: sub, callback_data: `crs|${subKey}` }];
        });
        keyboard.push([{ text: "🏠 Menu", callback_data: "menu" }]);
        
        return await bot.sendMessage(chatId, "Choose sub-category:", {
            reply_markup: { inline_keyboard: keyboard }
        });
      }

      // If no subfolders, send files
      const category = coursePath.split(path.sep).reverse()[1]; // Get parent folder name (e.g. 'videos')
      await sendFilesFromFolder(chatId, coursePath, category);
      await bot.sendMessage(chatId, "✅ Files sent!");
    }

    else if (type === "menu") {
      const years = safeGetFolders(BASE_PATH);
      const keyboard = years.map((year) => [{ text: year, callback_data: `yr|${year}` }]);
      await bot.sendMessage(chatId, "🏠 Main Menu:", { reply_markup: { inline_keyboard: keyboard } });
    }

    await bot.answerCallbackQuery(query.id);
  } catch (err) {
    console.error("Callback error:", err);
    bot.sendMessage(chatId, "⚠ Error processing request.");
  }
});

async function sendFilesFromFolder(chatId, folderPath, category) {
  const files = safeGetFiles(folderPath);
  if (!files.length) return bot.sendMessage(chatId, "No files found here.");

  for (let file of files) {
    const fullPath = path.join(folderPath, file);
    try {
        if (category.toLowerCase().includes("video")) {
            const link = fs.readFileSync(fullPath, "utf8");
            await bot.sendMessage(chatId, `🎥 ${file}:\n${link}`);
          } else {
            await bot.sendDocument(chatId, fullPath);
          }
    } catch (e) {
        console.error(`Failed to send ${file}`, e);
    }
  }
}

// ---------- ERROR HANDLERS ----------
process.on("uncaughtException", (err) => console.error(err));
process.on("unhandledRejection", (err) => console.error(err));