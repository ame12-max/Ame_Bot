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

// ---------- Global Storage ----------
const userStates = new Map(); // Store user message history and states

// ---------- Utilities ----------

function safeGetFolders(dirPath) {
  try {
    return fs.readdirSync(dirPath).filter(file =>
      fs.statSync(path.join(dirPath, file)).isDirectory()
    );
  } catch (err) {
    return [];
  }
}

function safeGetFiles(dirPath) {
  try {
    return fs.readdirSync(dirPath).filter(file =>
      fs.statSync(path.join(dirPath, file)).isFile()
    );
  } catch (err) {
    return [];
  }
}

// ---------- Message Management ----------

async function deleteUserMessages(chatId) {
  if (userStates.has(chatId)) {
    const { messageHistory = [] } = userStates.get(chatId);
    
    for (const msgId of messageHistory) {
      try {
        await bot.deleteMessage(chatId, msgId);
      } catch (err) {
        // Message might be already deleted or too old
        console.log(`Could not delete message ${msgId}:`, err.message);
      }
    }
    
    // Clear history after deletion
    if (userStates.has(chatId)) {
      userStates.set(chatId, { ...userStates.get(chatId), messageHistory: [] });
    }
  }
}

function addToMessageHistory(chatId, messageId) {
  if (!userStates.has(chatId)) {
    userStates.set(chatId, { messageHistory: [] });
  }
  
  const userState = userStates.get(chatId);
  userState.messageHistory.push(messageId);
  
  // Keep only last 20 messages to avoid memory issues
  if (userState.messageHistory.length > 20) {
    userState.messageHistory = userState.messageHistory.slice(-20);
  }
}

// ---------- Animated Typing ----------

async function sendTypingAnimation(chatId, text, options = {}) {
  const { typingDelay = 50, messageDelay = 100 } = options;
  
  // Send typing action
  await bot.sendChatAction(chatId, 'typing');
  
  // Create initial message with loading indicator
  const message = await bot.sendMessage(chatId, "▌", {
    parse_mode: "HTML",
    ...options
  });
  
  addToMessageHistory(chatId, message.message_id);
  
  let displayedText = "";
  const lines = text.split('\n');
  
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    let lineText = "";
    
    for (let j = 0; j < line.length; j++) {
      lineText += line[j];
      displayedText = lines.slice(0, i).join('\n') + (i > 0 ? '\n' : '') + lineText + "▌";
      
      await bot.editMessageText(displayedText, {
        chat_id: chatId,
        message_id: message.message_id,
        parse_mode: "HTML",
        ...options
      });
      
      await new Promise(resolve => setTimeout(resolve, typingDelay));
    }
    
    // Remove cursor at end of line and add newline
    displayedText = lines.slice(0, i + 1).join('\n') + (i < lines.length - 1 ? '\n▌' : '');
    
    await bot.editMessageText(displayedText, {
      chat_id: chatId,
      message_id: message.message_id,
      parse_mode: "HTML",
      ...options
    });
    
    await new Promise(resolve => setTimeout(resolve, messageDelay));
  }
  
  // Remove blinking cursor at the end
  await bot.editMessageText(text, {
    chat_id: chatId,
    message_id: message.message_id,
    parse_mode: "HTML",
    ...options
  });
  
  return message;
}

// ---------- Numbered Menu Creation ----------

function createNumberedKeyboard(items, callbackPrefix, includeBack = false, backData = "", includeHome = false) {
  const keyboard = [];
  
  // Add numbered items
  items.forEach((item, index) => {
    const number = index + 1;
    const text = `${number}. ${item.replace("_", " ")}`;
    const callbackData = `${callbackPrefix}|${item}`;
    keyboard.push([{ text, callback_data: callbackData }]);
  });
  
  // Add navigation buttons if needed
  const navRow = [];
  if (includeBack) {
    navRow.push({ text: "◀️ Back", callback_data: backData });
  }
  if (includeHome) {
    navRow.push({ text: "🏠 Menu", callback_data: "menu" });
  }
  if (navRow.length > 0) {
    keyboard.push(navRow);
  }
  
  return keyboard;
}

// ---------- START ----------

bot.onText(/\/start/, async (msg) => {
  const chatId = msg.chat.id;
  
  try {
    // Clean previous messages
    await deleteUserMessages(chatId);
    
    const years = safeGetFolders(BASE_PATH);
    
    if (!years.length) {
      await sendTypingAnimation(chatId, "📭 No academic years available.");
      return;
    }
    
    // Create numbered keyboard for years
    const keyboard = createNumberedKeyboard(years, "year");
    
    await sendTypingAnimation(chatId, "📚 *Select Academic Year:*", {
      reply_markup: { inline_keyboard: keyboard },
      parse_mode: "Markdown",
      typingDelay: 30,
      messageDelay: 150
    });
    
  } catch (err) {
    console.error("Start error:", err);
    await sendTypingAnimation(chatId, "⚠️ Something went wrong. Please try again.");
  }
});

// ---------- CALLBACK ----------

bot.on("callback_query", async (query) => {
  const chatId = query.message.chat.id;
  const messageId = query.message.message_id;

  try {
    const parts = query.data.split("|");
    const type = parts[0];

    // Clean previous messages (except current one)
    const currentState = userStates.get(chatId) || { messageHistory: [] };
    const filteredHistory = currentState.messageHistory.filter(id => id !== messageId);
    userStates.set(chatId, { ...currentState, messageHistory: filteredHistory });
    
    // Show typing action
    await bot.sendChatAction(chatId, 'typing');
    await new Promise(resolve => setTimeout(resolve, 500));

    // ---------- YEAR ----------
    if (type === "year") {
      const year = parts[1];
      const yearPath = path.join(BASE_PATH, year);
      const categories = safeGetFolders(yearPath);

      if (!categories.length) {
        await sendTypingAnimation(chatId, `📭 No materials found for *${year}*.`, {
          parse_mode: "Markdown"
        });
        return;
      }

      const keyboard = createNumberedKeyboard(categories, `category|${year}`, false, "", true);

      await sendTypingAnimation(chatId, `📖 *Year:* ${year.replace("_", " ")}\n\n*Select Semester:*`, {
        reply_markup: { inline_keyboard: keyboard },
        parse_mode: "Markdown",
        typingDelay: 30
      });
    }

    // ---------- CATEGORY ----------
    else if (type.startsWith("category")) {
      const year = parts[1];
      const category = parts[2];
      const categoryPath = path.join(BASE_PATH, year, category);
      const courses = safeGetFolders(categoryPath);

      if (!courses.length) {
        await sendTypingAnimation(chatId, `📭 No courses available in *${category}*.`, {
          parse_mode: "Markdown"
        });
        return;
      }

      const keyboard = createNumberedKeyboard(courses, `course|${year}|${category}`, true, `year|${year}`, true);

      await sendTypingAnimation(chatId, `📂 *${category.toUpperCase()}*\n\n*Select Course:*`, {
        reply_markup: { inline_keyboard: keyboard },
        parse_mode: "Markdown",
        typingDelay: 30
      });
    }

    // ---------- COURSE ----------
    else if (type === "course") {
      const year = parts[1];
      const category = parts[2];
      const course = parts[3];
      const coursePath = path.join(BASE_PATH, year, category, course);
      const subfolders = safeGetFolders(coursePath);

      if (subfolders.length) {
        const keyboard = createNumberedKeyboard(subfolders, `subcourse|${year}|${category}|${course}`, true, `category|${year}|${category}`, true);
        
        await sendTypingAnimation(chatId, `📂 *${course}*\n\n*Select Material Type:*`, {
          reply_markup: { inline_keyboard: keyboard },
          parse_mode: "Markdown",
          typingDelay: 30
        });
      } else {
        // Send files directly
        await sendFilesFromFolder(chatId, coursePath, category);
        
        const keyboard = [
          [
            { text: "◀️ Back", callback_data: `category|${year}|${category}` },
            { text: "🏠 Menu", callback_data: "menu" }
          ]
        ];
        
        await sendTypingAnimation(chatId, "✅ *Done!* All materials have been sent.\n\nChoose an option:", {
          reply_markup: { inline_keyboard: keyboard },
          parse_mode: "Markdown"
        });
      }
    }

    // ---------- SUBCOURSE ----------
    else if (type === "subcourse") {
      const year = parts[1];
      const category = parts[2];
      const course = parts[3];
      const sub = parts[4];
      const subPath = path.join(BASE_PATH, year, category, course, sub);

      await sendFilesFromFolder(chatId, subPath, category);

      const keyboard = [
        [
          { text: "◀️ Back", callback_data: `course|${year}|${category}|${course}` },
          { text: "🏠 Menu", callback_data: "menu" }
        ]
      ];
      
      await sendTypingAnimation(chatId, "✅ *Done!* All materials have been sent.\n\nChoose an option:", {
        reply_markup: { inline_keyboard: keyboard },
        parse_mode: "Markdown"
      });
    }

    // ---------- MENU ----------
    else if (type === "menu") {
      const years = safeGetFolders(BASE_PATH);
      
      if (!years.length) {
        await sendTypingAnimation(chatId, "📭 No academic years available.");
        return;
      }
      
      const keyboard = createNumberedKeyboard(years, "year");
      
      await sendTypingAnimation(chatId, "🏠 *Main Menu*\n\n*Select Academic Year:*", {
        reply_markup: { inline_keyboard: keyboard },
        parse_mode: "Markdown",
        typingDelay: 30,
        messageDelay: 150
      });
    }

    await bot.answerCallbackQuery(query.id);
  } catch (err) {
    console.error("Callback error:", err);
    await bot.answerCallbackQuery(query.id);
    await sendTypingAnimation(chatId, "⚠️ An error occurred. Please try again.");
  }
});

// ---------- SEND FILES ----------
async function sendFilesFromFolder(chatId, folderPath, category) {
  const files = safeGetFiles(folderPath);

  if (!files.length) {
    await sendTypingAnimation(chatId, "📭 No files found in this folder.");
    return;
  }

  // Send initial message
  const infoMsg = await sendTypingAnimation(chatId, `📤 Sending ${files.length} file(s)...\nPlease wait.`);

  for (let i = 0; i < files.length; i++) {
    const file = files[i];
    const fullPath = path.join(folderPath, file);

    try {
      if (!fs.existsSync(fullPath) || fs.statSync(fullPath).size === 0) {
        await bot.sendMessage(chatId, `⚠️ File missing or empty: ${file}`);
        continue;
      }

      if (category === "videos") {
        const content = fs.readFileSync(fullPath, "utf8");
        await bot.sendMessage(chatId, content);
      } else {
        const stream = fs.createReadStream(fullPath);
        await bot.sendDocument(chatId, stream, {}, { filename: file });
      }

      // Update progress
      const progress = Math.round(((i + 1) / files.length) * 100);
      await bot.editMessageText(`📤 Sending files...\nProgress: ${progress}% (${i + 1}/${files.length})`, {
        chat_id: chatId,
        message_id: infoMsg.message_id
      });

      // Small delay between files to avoid rate limiting
      await new Promise(resolve => setTimeout(resolve, 500));

    } catch (err) {
      console.error(`Error sending file ${file}:`, err);
      await bot.sendMessage(chatId, `❌ Failed to send: ${file}`);
    }
  }

  // Delete progress message
  try {
    await bot.deleteMessage(chatId, infoMsg.message_id);
  } catch (err) {
    console.log("Could not delete progress message:", err.message);
  }
}

// ---------- UNKNOWN COMMAND ----------
bot.on("message", async (msg) => {
  if (msg.text && msg.text.startsWith("/") && msg.text !== "/start") {
    await sendTypingAnimation(msg.chat.id, "⚠️ Unknown command. Please use /start to begin.");
  }
});

// ---------- Clear user state on /start ----------
bot.onText(/\/start/, async (msg) => {
  const chatId = msg.chat.id;
  // Clear previous state
  userStates.delete(chatId);
});

// ---------- GLOBAL ERROR HANDLING ----------
process.on("uncaughtException", (err) => console.error("Uncaught Exception:", err));
process.on("unhandledRejection", (err) => console.error("Unhandled Rejection:", err));