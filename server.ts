/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import express from "express";
import { createServer as createViteServer } from "vite";
import Database from "better-sqlite3";
import path from "path";
import { fileURLToPath } from "url";
import TelegramBot from "node-telegram-bot-api";
import { GoogleGenAI, Type } from "@google/genai";
import { WebSocketServer, WebSocket } from "ws";
import http from "http";
import puppeteer from "puppeteer";
import cron from "node-cron";

import { GitHubService } from "./src/services/githubService.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const db = new Database("clawweb.db");
let bots: TelegramBot[] = []; // Array to hold multiple bot instances
const github = new GitHubService();
// Initialize DB
db.exec(`
  CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    role TEXT NOT NULL,
    content TEXT NOT NULL,
    timestamp DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS skills (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    description TEXT NOT NULL,
    code TEXT
  );

  CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT
  );
`);

// Initialize Telegram Bots
const rawBotTokens = process.env.TELEGRAM_BOT_TOKENS || process.env.TELEGRAM_BOT_TOKEN;
const botTokens = rawBotTokens ? rawBotTokens.split(',').map(t => t.replace(/[<>'"\s]/g, '')).filter(t => t.length > 0) : [];

let botUsernames: string[] = []; // Track all bot usernames
let lastTelegramError: string | null = null;
let lastIncomingChatId: string | null = null;
let lastMessageTime: string | null = null;
let lastSyncTime: string | null = null;
let lastSyncResult: string | null = null;

// Helper to send message via ANY available bot
async function sendMessageToId(chatId: string, text: string) {
  let success = false;
  let error = null;
  
  for (const b of bots) {
    try {
      await b.sendMessage(chatId, text);
      success = true;
      // We don't break here because the user might want to receive it from all bots
      // or we can break if we just want "at least one" success. 
      // Let's try to send via all, but ignore "chat not found" errors if others succeed.
    } catch (e: any) {
      error = e;
      console.error(`[Telegram] Bot failed to send to ${chatId}:`, e.message);
    }
  }
  
  if (!success && error) throw error;
  return success;
}

// WebSocket clients
const clients = new Set<WebSocket>();

// Browser instance
let browser: any = null;

async function getBrowser() {
  if (!browser) {
    browser = await puppeteer.launch({
      headless: true,
      args: [
        "--no-sandbox", 
        "--disable-setuid-sandbox",
        "--disable-blink-features=AutomationControlled",
        "--window-size=1920,1080"
      ]
    });
  }
  return browser;
}

function broadcast(data: any) {
  const message = JSON.stringify(data);
  clients.forEach(client => {
    if (client.readyState === WebSocket.OPEN) {
      client.send(message);
    }
  });
}

function getGeminiKey() {
  const k1 = (process.env.MY_GEMINI_KEY || "").trim();
  const k2 = (process.env.GEMINI_API_KEY || "").trim();
  const k3 = (process.env.API_KEY || "").trim();
  
  const isRealKey = (s: string) => s.startsWith('AIza') && s.length > 20;
  const isLabel = (s: string) => {
    const lower = s.toLowerCase();
    return lower.includes('ai studio') || 
           lower.includes('free tier') || 
           lower.includes('...') || 
           lower.includes('選擇') ||
           s.length < 20;
  };
  
  if (isRealKey(k1)) return k1;
  if (isRealKey(k2)) return k2;
  if (isRealKey(k3)) return k3;
  
  if (k1 && !isLabel(k1)) return k1;
  if (k2 && !isLabel(k2)) return k2;
  if (k3 && !isLabel(k3)) return k3;
  
  return "";
}

function getChatIds(): string[] {
  const ids = new Set<string>();
  
  // 1. Get from environment variables (Secrets) - Check both plural and singular
  const envIds1 = (process.env.TELEGRAM_CHAT_IDS || "").split(',');
  const envIds2 = (process.env.TELEGRAM_CHAT_ID || "").split(',');
  
  [...envIds1, ...envIds2].forEach(id => {
    const trimmed = id.trim();
    if (trimmed) ids.add(trimmed);
  });
  
  // 2. Get from database (UI settings)
  try {
    const row = db.prepare("SELECT value FROM settings WHERE key = 'chat_ids'").get() as any;
    if (row?.value) {
      row.value.split(',').forEach((id: string) => {
        const trimmed = id.trim();
        if (trimmed) ids.add(trimmed);
      });
    }
  } catch (e) {
    console.error("Error reading chat_ids from DB:", e);
  }
  
  const result = Array.from(ids);
  console.log(`[System] Final combined Chat IDs: ${result.join(',')}`);
  return result;
}

// Prevent system hang on unhandled rejections
process.on('unhandledRejection', (reason, promise) => {
  console.error('Unhandled Rejection at:', promise, 'reason:', reason);
});

async function initBots() {
  console.log(`[System] Initializing ${botTokens.length} bots...`);
  
  // Clear existing bots if any - Await stopPolling to prevent 409 Conflict
  for (const b of bots) {
    try {
      console.log(`[System] Stopping bot polling...`);
      // Add a 2-second timeout to stopPolling to prevent hanging
      const stopPromise = b.stopPolling();
      const timeoutPromise = new Promise((_, reject) => setTimeout(() => reject(new Error("StopPolling Timeout")), 2000));
      await Promise.race([stopPromise, timeoutPromise]).catch(e => console.warn("[System] stopPolling warning:", e.message));
    } catch (e: any) {
      console.error("[System] Error stopping bot polling:", e.message);
    }
  }
  
  bots = [];
  botUsernames = [];

  for (const [index, token] of botTokens.entries()) {
    try {
      const tokenPreview = token.substring(0, 4) + "..." + token.substring(token.length - 4);
      console.log(`[Bot ${index + 1}] Attempting initialization: ${tokenPreview}`);
      
      const newBot = new TelegramBot(token, { polling: true });
      
      // Verification with timeout
      const verifyPromise = newBot.getMe();
      const timeoutPromise = new Promise((_, reject) => 
        setTimeout(() => reject(new Error("Verification Timeout")), 10000)
      );

      Promise.race([verifyPromise, timeoutPromise])
        .then((me: any) => {
          const name = me.username || "Unknown";
          console.log(`[Bot ${index + 1}] Verified as @${name}`);
          if (!botUsernames.includes(name)) botUsernames.push(name);
        })
        .catch(err => {
          lastTelegramError = `Bot ${index + 1} Error: ${err.message}`;
          console.error(`[Bot ${index + 1}] Verification Failed:`, err.message);
          if (err.message.includes("401")) {
            console.warn(`[Bot ${index + 1}] Unauthorized (401). Stopping polling.`);
            newBot.stopPolling();
          }
        });

      newBot.on("polling_error", (err) => {
        // Suppress 409 errors in logs as we handle them via stopPolling
        if (err.message.includes("409 Conflict")) {
          return;
        }
        lastTelegramError = err.message;
        console.error(`[Bot ${index + 1}] Polling Error:`, err.message);
        if (err.message.includes("401")) {
          newBot.stopPolling();
        }
      });

      newBot.on("message", async (msg) => {
        lastIncomingChatId = msg.chat.id.toString();
        lastMessageTime = new Date().toLocaleTimeString();
        console.log(`[Telegram Event] Message received from ${msg.from?.username || 'unknown'} (ID: ${msg.chat.id})`);
        
        const incomingChatId = msg.chat.id.toString();
        const configuredChatIds = getChatIds();
        
        if (configuredChatIds.length > 0 && !configuredChatIds.includes(incomingChatId)) {
          console.log(`[Telegram] Unauthorized access attempt from ${incomingChatId}.`);
          return;
        }

        if (!msg.text && !msg.voice) return;

        try {
          const currentKey = getGeminiKey();
          if (!currentKey) throw new Error("Missing API Key configuration.");
          
          const ai = new GoogleGenAI({ apiKey: currentKey });
          const model = "gemini-3-flash-preview";

          const history = db.prepare("SELECT role, content FROM messages ORDER BY timestamp ASC LIMIT 10").all();
          const contents = history.map((h: any) => ({
            role: h.role === 'model' ? 'model' : 'user',
            parts: [{ text: h.content }]
          }));

          const userParts: any[] = [];
          let userLogText = "";

          if (msg.text) {
            userParts.push({ text: msg.text });
            userLogText = msg.text;
          } else if (msg.voice) {
            const fileLink = await newBot.getFileLink(msg.voice.file_id);
            const response = await fetch(fileLink);
            const buffer = await response.arrayBuffer();
            const base64Audio = Buffer.from(buffer).toString('base64');
            userParts.push({ inlineData: { mimeType: "audio/ogg", data: base64Audio } });
            userLogText = "[Voice Message]";
          }

          contents.push({ role: 'user', parts: userParts });

          const result = await ai.models.generateContent({
            model,
            contents,
            config: {
              systemInstruction: "You are ClawWeb, a personal AI assistant. You are responding via Telegram. Always respond in Traditional Chinese (繁體中文).",
              tools: [{
                functionDeclarations: [
                  {
                    name: "sendTelegramMessage",
                    description: "Send a message or reminder to a specific Telegram account or all configured accounts. Can be immediate or delayed.",
                    parameters: {
                      type: Type.OBJECT,
                      properties: {
                        message: { type: Type.STRING, description: "The content of the message to send." },
                        delayMs: { type: Type.NUMBER, description: "Optional delay in milliseconds." },
                        targetChatId: { type: Type.STRING, description: "Optional: Specific Chat ID." }
                      },
                      required: ["message"]
                    }
                  }
                ]
              }]
            }
          });

          let responseText = result.text || "";
          
          if (result.functionCalls) {
            for (const call of result.functionCalls) {
              if (call.name === 'sendTelegramMessage') {
                const { message: telMsg, delayMs, targetChatId } = call.args as any;
                const sendDelayed = async () => {
                  const ids = targetChatId ? [targetChatId] : getChatIds();
                  for (const id of ids) {
                    for (const b of bots) {
                      try { await b.sendMessage(id, telMsg); } catch (e) {}
                    }
                  }
                };
                if (delayMs && delayMs > 0) {
                  setTimeout(sendDelayed, delayMs);
                  responseText += `\n\n[Reminder set for ${delayMs/1000}s]`;
                } else {
                  await sendDelayed();
                  responseText += `\n\n[Message sent]`;
                }
              }
            }
          }

          if (responseText.trim()) {
            // Use the universal sender to try all bots for the reply
            await sendMessageToId(incomingChatId, responseText);
            
            db.prepare("INSERT INTO messages (role, content) VALUES (?, ?)").run('user', userLogText);
            db.prepare("INSERT INTO messages (role, content) VALUES (?, ?)").run('model', responseText);
            broadcast({ type: 'NEW_MESSAGE', message: { role: 'user', content: userLogText, timestamp: new Date().toISOString() } });
            broadcast({ type: 'NEW_MESSAGE', message: { role: 'model', content: responseText, timestamp: new Date().toISOString() } });
          }
        } catch (err: any) {
          console.error("Telegram bot processing error:", err);
          await newBot.sendMessage(incomingChatId, `Error: ${err.message}`);
        }
      });

      bots.push(newBot);
    } catch (err: any) {
      console.error("Failed to initialize bot:", err.message);
    }
  }
}

// Remove redundant call
// initBots();

async function startServer() {
  try {
    console.log("[System] Initializing ClawWeb Server...");
    
    const app = express();
    const PORT = 3000;

    app.use(express.json());

    // Health check
    app.get("/api/health", (req, res) => res.json({ status: "ok" }));

    // Debug Status
    app.get("/api/debug/status", (req, res) => {
      try {
        const currentKey = getGeminiKey();
        
        // Distinguish between env and db IDs
        const envIds1 = (process.env.TELEGRAM_CHAT_IDS || "").split(',').map(id => id.trim()).filter(id => id.length > 0);
        const envIds2 = (process.env.TELEGRAM_CHAT_ID || "").split(',').map(id => id.trim()).filter(id => id.length > 0);
        const envIds = Array.from(new Set([...envIds1, ...envIds2]));
        
        let dbIds: string[] = [];
        try {
          const row = db.prepare("SELECT value FROM settings WHERE key = 'chat_ids'").get() as any;
          if (row?.value) {
            dbIds = row.value.split(',').map((id: string) => id.trim()).filter((id: string) => id.length > 0);
          }
        } catch (e) {}

        const allIds = Array.from(new Set([...envIds, ...dbIds]));

        res.json({
          botTokenPresent: botTokens.length > 0,
          chatIdPresent: allIds.length > 0,
          configuredChatIds: allIds,
          envIds: envIds, // IDs from Secrets
          dbIds: dbIds,   // IDs from Database
          geminiKeyPresent: !!currentKey,
          geminiKeyPrefix: currentKey ? currentKey.substring(0, 4) + "..." : "None",
          botInitialized: bots.length > 0,
          botCount: bots.length,
          botUsernames: botUsernames,
          lastError: lastTelegramError,
          lastIncomingId: lastIncomingChatId,
          lastMsgTime: lastMessageTime,
          lastSyncTime: lastSyncTime,
          lastSyncResult: lastSyncResult,
          nodeEnv: process.env.NODE_ENV,
          githubTokenPresent: !!process.env.GITHUB_TOKEN,
          githubRepoPresent: !!process.env.GITHUB_REPO,
          telegramBotTokenPrefix: botTokens.length > 0 ? botTokens[0].substring(0, 4) + "..." : "None"
        });
      } catch (err: any) {
        console.error("Debug status error:", err);
        res.status(500).json({ error: err.message });
      }
    });

    // Initialize Bots AFTER defining basic health/debug routes
    // Removed blocking await to prevent server hang
    // initBots().catch(e => console.error("[System] Async initBots failed:", e));

    app.get("/api/debug/env", (req, res) => {
      console.log("[Debug] Env Keys:", Object.keys(process.env));
      res.json({
        TELEGRAM_BOT_TOKEN: process.env.TELEGRAM_BOT_TOKEN ? process.env.TELEGRAM_BOT_TOKEN.substring(0, 4) + "..." : "Not Set",
        TELEGRAM_CHAT_ID: process.env.TELEGRAM_CHAT_ID || "Not Set",
        MY_GEMINI_KEY: process.env.MY_GEMINI_KEY ? process.env.MY_GEMINI_KEY.substring(0, 4) + "..." : "Not Set",
        GEMINI_API_KEY: process.env.GEMINI_API_KEY ? process.env.GEMINI_API_KEY.substring(0, 4) + "..." : "Not Set",
        API_KEY: process.env.API_KEY ? process.env.API_KEY.substring(0, 4) + "..." : "Not Set",
        GITHUB_TOKEN: process.env.GITHUB_TOKEN ? process.env.GITHUB_TOKEN.substring(0, 4) + "..." : "Not Set",
        GITHUB_REPO: process.env.GITHUB_REPO || "Not Set"
      });
    });



  app.post("/api/settings", (req, res) => {
    const { key, value } = req.body;
    if (key === 'chat_ids') {
      // ONLY save the IDs that are NOT in environment variables to the DB
      const envIdsStr = process.env.TELEGRAM_CHAT_IDS || process.env.TELEGRAM_CHAT_ID || "";
      const envIds = envIdsStr.split(',').map(id => id.trim()).filter(id => id.length > 0);
      
      // Get current DB IDs
      let dbIds: string[] = [];
      try {
        const row = db.prepare("SELECT value FROM settings WHERE key = 'chat_ids'").get() as any;
        if (row?.value) {
          dbIds = row.value.split(',').map((id: string) => id.trim()).filter((id: string) => id.length > 0);
        }
      } catch (e) {}

      const newId = value.trim();
      if (newId && !envIds.includes(newId)) {
        const updatedDbIds = Array.from(new Set([...dbIds, newId]));
        db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)").run(key, updatedDbIds.join(','));
      }
    } else {
      db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)").run(key, value);
    }
    res.json({ status: "ok" });
  });

  app.delete("/api/settings/chat_ids/:id", (req, res) => {
    const { id } = req.params;
    console.log(`[System] Attempting to delete Chat ID from DB: ${id}`);
    try {
      const row = db.prepare("SELECT value FROM settings WHERE key = 'chat_ids'").get() as any;
      if (row?.value) {
        const currentIds = row.value.split(',').map((i: string) => i.trim());
        const updatedIds = currentIds.filter((i: string) => i !== id && i.length > 0);
        db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)").run('chat_ids', updatedIds.join(','));
        console.log(`[System] Successfully deleted ${id}. New DB list: ${updatedIds.join(',')}`);
        res.json({ status: "ok" });
      } else {
        res.status(404).json({ error: "No chat IDs found in database" });
      }
    } catch (err: any) {
      console.error("[System] Delete Chat ID failed:", err.message);
      res.status(500).json({ error: err.message });
    }
  });

  app.post("/api/browser", async (req, res) => {
    const { url, action } = req.body;
    try {
      const b = await getBrowser();
      const page = await b.newPage();

      await page.setUserAgent("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36");
      await page.setViewport({ width: 1280, height: 800 });

      await page.goto(url, { waitUntil: 'networkidle2', timeout: 30000 });

      if (action === 'content') {
        const rawContent = await page.evaluate(() => document.body.innerText);
        await page.close();

        try {
          // Summarize via AI for the web UI too
          const currentKey = getGeminiKey();
          const ai = new GoogleGenAI({ apiKey: currentKey });
          const summarizerResult = await ai.models.generateContent({
            model: "gemini-3-flash-preview",
            contents: [{ role: 'user', parts: [{ text: `Please summarize the following web content from ${url} into a clean, concise, and readable format in Traditional Chinese (繁體中文). Focus on the main information:\n\n${rawContent.substring(0, 5000)}` }] }],
            config: { systemInstruction: "You are a helpful assistant that summarizes web pages clearly in Traditional Chinese." }
          });

          res.json({ content: summarizerResult.text || "無法生成摘要" });
        } catch (sumErr: any) {
          console.error("Summarization failed:", sumErr);
          // Fallback to raw content snippet
          const snippet = rawContent.trim().substring(0, 800).replace(/\n\s*\n/g, '\n');
          res.json({ content: `[AI 摘要暫時不可用 - 顯示原始片段]\n\n${snippet}...` });
        }
      } else if (action === 'screenshot') {
        const screenshot = await page.screenshot({ encoding: 'base64' });
        await page.close();
        res.json({ screenshot: `data:image/png;base64,${screenshot}` });
      }
    } catch (err: any) {
      console.error("Browser error:", err);
      res.status(500).json({ error: err.message });
    }
  });

  app.post("/api/github/sync", async (req, res) => {
    console.log("[GitHub] Sync request received");
    try {
      const filesToSync = [
        "server.ts",
        "src/App.tsx",
        "src/services/geminiService.ts",
        "src/services/githubService.ts",
        "package.json",
        "metadata.json"
      ];
      const result = await github.syncFiles(filesToSync);
      lastSyncTime = new Date().toLocaleString();
      lastSyncResult = "Success";
      res.json({ status: "ok", result });
    } catch (err: any) {
      lastSyncTime = new Date().toLocaleString();
      lastSyncResult = `Error: ${err.message}`;
      res.status(500).json({ error: err.message });
    }
  });

  // API Routes
  app.get("/api/messages", (req, res) => {
    const messages = db.prepare("SELECT * FROM messages ORDER BY timestamp ASC").all();
    res.json(messages);
  });

  app.post("/api/messages", (req, res) => {
    const { role, content } = req.body;
    const timestamp = new Date().toISOString();
    const info = db.prepare("INSERT INTO messages (role, content) VALUES (?, ?)").run(role, content);

    const newMessage = { id: info.lastInsertRowid, role, content, timestamp };
    broadcast({ type: 'NEW_MESSAGE', message: newMessage });

    res.json(newMessage);
  });

  app.delete("/api/messages", (req, res) => {
    try {
      console.log("[System] Clearing all persistent memory...");
      db.prepare("DELETE FROM messages").run();
      broadcast({ type: 'CLEAR_HISTORY' });
      res.json({ status: "ok" });
    } catch (err: any) {
      console.error("[System] Failed to clear memory:", err);
      res.status(500).json({ error: err.message });
    }
  });

  app.get("/api/skills", (req, res) => {
    const skills = db.prepare("SELECT * FROM skills").all();
    res.json(skills);
  });

  app.post("/api/skills", (req, res) => {
    const { name, content } = req.body; // 'content' will store the prompt text
    if (!name || !content) {
      return res.status(400).json({ error: "Skill name and content are required." });
    }
    try {
      const info = db.prepare("INSERT INTO skills (name, description, code) VALUES (?, ?, ?)").run(name, content, null); // Using 'content' for description/code
      res.json({ id: info.lastInsertRowid, name, content });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.delete("/api/skills/:id", (req, res) => {
    const { id } = req.params;
    try {
      db.prepare("DELETE FROM skills WHERE id = ?").run(id);
      res.json({ status: "ok" });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.post("/api/telegram/send", async (req, res) => {
    const { message, delayMs, targetChatId } = req.body;
    const configuredChatIds = getChatIds();

    if (bots.length === 0 || configuredChatIds.length === 0) {
      return res.status(400).json({ error: "Telegram bot not configured (No Bots or Chat IDs)" });
    }

    const chatIdsToSend = targetChatId ? [targetChatId] : configuredChatIds;

    const sendMessage = async (id: string) => {
      let successCount = 0;
      let lastErr = null;
      
      for (const b of bots) {
        try {
          await b.sendMessage(id, message);
          console.log(`[Telegram] Message sent via bot to ${id}: ${message}`);
          successCount++;
        } catch (err: any) {
          lastErr = err;
          // Log but don't fail yet, maybe another bot works
          console.warn(`[Telegram] One bot failed to send to ${id}:`, err.message);
        }
      }
      
      // Only throw if ALL bots failed
      if (successCount === 0 && lastErr) {
        if (lastErr.message.includes("chat not found")) {
          const error = new Error(`所有 Bot 都無法傳送至 ID ${id}。請確保您已經對「所有」設定的 Bot 點擊了「開始 (Start)」並傳送過至少一條訊息。`);
          (error as any).code = 400;
          throw error;
        }
        throw lastErr;
      }
      return successCount;
    };

    if (delayMs && delayMs > 0) {
      console.log(`[Telegram] Scheduling message in ${delayMs}ms to ${chatIdsToSend.join(', ')}: ${message}`);
      for (const id of chatIdsToSend) {
        setTimeout(async () => {
          try {
            await sendMessage(id);
          } catch (e) {
            console.error(`[Telegram] Delayed send failed for ${id}`);
          }
        }, delayMs);
      }
      res.json({ status: "scheduled", delayMs, targetChatIds: chatIdsToSend });
    } else {
      try {
        const results = [];
        for (const id of chatIdsToSend) {
          const count = await sendMessage(id);
          results.push({ chatId: id, status: "ok", botsUsed: count });
        }
        res.json({ status: "ok", results });
      } catch (err: any) {
        console.error("Telegram send error:", err);
        res.status(500).json({ 
          error: err.message || "Failed to send to Telegram",
          details: "Ensure your Bot Token is correct and you have started a conversation with the bot."
        });
      }
    }
  });

  // Vite middleware for development
  if (process.env.NODE_ENV !== "production") {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    app.use(express.static(path.join(__dirname, "dist")));
    app.get("*", (req, res) => {
      res.sendFile(path.join(__dirname, "dist", "index.html"));
    });
  }

  // Global Error Handler
  app.use((err: any, req: express.Request, res: express.Response, next: express.NextFunction) => {
    console.error("[Global Error Handler]", err);
    res.status(500).json({ 
      error: "Internal Server Error", 
      message: err.message,
      path: req.path
    });
  });

  const server = http.createServer(app);
  const wss = new WebSocketServer({ server });

  wss.on("connection", (ws) => {
    clients.add(ws);
    console.log(`[WebSocket] Client connected. Total: ${clients.size}`);
    
    ws.on("close", () => {
      clients.delete(ws);
      console.log(`[WebSocket] Client disconnected. Total: ${clients.size}`);
    });
  });

  server.listen(PORT, "0.0.0.0", () => {
    console.log(`[System] Server running on http://0.0.0.0:${PORT}`);
    
    // Initialize Bots AFTER server is listening
    console.log("[System] Triggering background bot initialization...");
    initBots().catch(e => console.error("[System] Async initBots failed:", e));
  });
  } catch (fatalErr: any) {
    console.error("[FATAL ERROR] Server failed to start:", fatalErr);
  }
}

startServer();
