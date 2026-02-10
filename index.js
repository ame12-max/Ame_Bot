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
  // Webhook mode for Render
  bot = new TelegramBot(token);
  const url = process.env.RENDER_EXTERNAL_URL;
  bot.setWebHook(`${url}/bot${token}`);
  app.post(`/bot${token}`, (req, res) => {
    bot.processUpdate(req.body);
    res.sendStatus(200);
  });
  app.listen(process.env.PORT || 3000, () =>
    console.log("Server running (Webhook)"),
  );
} else {
  // Polling for local dev
  bot = new TelegramBot(token, { polling: true });
  console.log("Bot running in polling mode");
}

// ---------- Utilities ----------

function safeGetFolders(dirPath) {
  try {
    return fs
      .readdirSync(dirPath)
      .filter((file) => fs.statSync(path.join(dirPath, file)).isDirectory());
  } catch (err) {
    return [];
  }
}

function safeGetFiles(dirPath) {
  try {
    return fs
      .readdirSync(dirPath)
      .filter((file) => fs.statSync(path.join(dirPath, file)).isFile());
  } catch (err) {
    return [];
  }
}

// ---------- START ----------

bot.onText(/\/start/, async (msg) => {
  try {
    const years = safeGetFolders(BASE_PATH);

    if (!years.length)
      return bot.sendMessage(msg.chat.id, "No academic years available.");

    const keyboard = courses.map((course, index) => [
      { text: course, callback_data: `subcourse|${index}` },
    ]);

    // Store mapping temporarily
    bot.courseCache = bot.courseCache || {};
    bot.courseCache[chatId] = {
      year,
      semester,
      category,
      courses,
    };

    await bot.sendMessage(msg.chat.id, "📚 Select Academic Year:", {
      reply_markup: { inline_keyboard: keyboard },
    });
  } catch (err) {
    console.error(err);
    bot.sendMessage(msg.chat.id, "⚠ Something went wrong.");
  }
});

// ---------- CALLBACK ----------

bot.on("callback_query", async (query) => {
  const chatId = query.message.chat.id;

  try {
    const parts = query.data.split("|");
    const type = parts[0];

    // ---------- YEAR ----------
    if (type === "year") {
      const year = parts[1];
      const yearPath = path.join(BASE_PATH, year);
      const categories = safeGetFolders(yearPath);

      if (!categories.length)
        return bot.sendMessage(chatId, "No materials found.");

      const keyboard = categories.map((cat) => [
        { text: cat.toUpperCase(), callback_data: `category|${year}|${cat}` },
      ]);

      keyboard.push([{ text: "🏠 Menu", callback_data: "menu" }]);

      await bot.sendMessage(chatId, `📖 Year: ${year}\nSelect Semister:`, {
        reply_markup: { inline_keyboard: keyboard },
      });
    }

    // ---------- CATEGORY ----------
    else if (type === "category") {
      const [_, year, category] = parts;
      const categoryPath = path.join(BASE_PATH, year, category);
      const courses = safeGetFolders(categoryPath);

      if (!courses.length)
        return bot.sendMessage(chatId, "No courses available.");

      const keyboard = courses.map((course) => [
        { text: course, callback_data: `course|${year}|${category}|${course}` },
      ]);

      keyboard.push([
        { text: "⬅ Back", callback_data: `year|${year}` },
        { text: "🏠 Menu", callback_data: "menu" },
      ]);

      await bot.sendMessage(chatId, `📂 Select Material Type:`, {
        reply_markup: { inline_keyboard: keyboard },
      });
    }

    // ---------- COURSE ----------
    else if (type === "course") {
      const [_, year, category, course] = parts;
      const coursePath = path.join(BASE_PATH, year, category, course);
      const subfolders = safeGetFolders(coursePath);

      // If there are subfolders (like mid/final in exams), show them first
      if (subfolders.length) {
        const keyboard = subfolders.map((sub) => [
          {
            text: sub,
            callback_data: `subcourse|${year}|${category}|${course}|${sub}`,
          },
        ]);
        keyboard.push([
          { text: "⬅ Back", callback_data: `category|${year}|${category}` },
          { text: "🏠 Menu", callback_data: "menu" },
        ]);
        return await bot.sendMessage(chatId, `📂 Select Course:`, {
          reply_markup: { inline_keyboard: keyboard },
        });
      }

      // Otherwise send files directly
      await sendFilesFromFolder(chatId, coursePath, category);

      const keyboard = [
        [
          { text: "⬅ Back", callback_data: `category|${year}|${category}` },
          { text: "🏠 Menu", callback_data: "menu" },
        ],
      ];
      await bot.sendMessage(chatId, "✅ Done! Choose an option:", {
        reply_markup: { inline_keyboard: keyboard },
      });
    }

    // ---------- SUBCOURSE ----------
    else if (type === "subcourse") {
      const index = parts[1];
      const cache = bot.courseCache[chatId];

      if (!cache)
        return bot.sendMessage(chatId, "Session expired. Please start again.");

      const { year, semester, category, courses } = cache;
      const course = courses[index];
      const subPath = path.join(BASE_PATH, year, category, course, sub);

      await sendFilesFromFolder(chatId, subPath, category);

      const keyboard = [
        [
          {
            text: "⬅ Back",
            callback_data: `course|${year}|${category}|${course}`,
          },
          { text: "🏠 Menu", callback_data: "menu" },
        ],
      ];
      await bot.sendMessage(chatId, "✅ Done! Choose an option:", {
        reply_markup: { inline_keyboard: keyboard },
      });
    }

    // ---------- MENU ----------
    else if (type === "menu") {
      const years = safeGetFolders(BASE_PATH);
      if (!years.length)
        return bot.sendMessage(chatId, "No academic years available.");
      const keyboard = years.map((year) => [
        { text: year.replace("_", " "), callback_data: `year|${year}` },
      ]);
      await bot.sendMessage(chatId, "🏠 Main Menu - Select Academic Year:", {
        reply_markup: { inline_keyboard: keyboard },
      });
    }

    // ---------- UNKNOWN ----------
    else {
      await bot.sendMessage(chatId, "⚠ Invalid selection.");
    }

    await bot.answerCallbackQuery(query.id);
  } catch (err) {
    console.error("Callback error:", err);
    await bot.answerCallbackQuery(query.id);
    bot.sendMessage(chatId, "⚠ An error occurred. Please try again.");
  }
});

// ---------- SEND FILES ----------
async function sendFilesFromFolder(chatId, folderPath, category) {
  const files = safeGetFiles(folderPath);

  if (!files.length) return bot.sendMessage(chatId, "No files found.");

  for (let file of files) {
    const fullPath = path.join(folderPath, file);

    if (!fs.existsSync(fullPath) || fs.statSync(fullPath).size === 0) {
      await bot.sendMessage(chatId, `⚠ File missing or empty: ${file}`);
      continue;
    }

    if (category === "videos") {
      const content = fs.readFileSync(fullPath, "utf8");
      await bot.sendMessage(chatId, content);
    } else {
      const stream = fs.createReadStream(fullPath);
      await bot.sendDocument(chatId, stream, {}, { filename: file });
    }
  }
}

// ---------- UNKNOWN COMMAND ----------
bot.on("message", (msg) => {
  if (msg.text && msg.text.startsWith("/") && msg.text !== "/start") {
    bot.sendMessage(msg.chat.id, "⚠ Unknown command. Please use /start");
  }
});

// ---------- GLOBAL ERROR HANDLING ----------
process.on("uncaughtException", (err) =>
  console.error("Uncaught Exception:", err),
);
process.on("unhandledRejection", (err) =>
  console.error("Unhandled Rejection:", err),
);
