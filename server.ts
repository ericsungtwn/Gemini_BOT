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
import { GitHubService } from "./src/services/githubService.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const db = new Database("clawweb.db");

// Initialize Telegram Bot
const botToken = process.env.TELEGRAM_BOT_TOKEN;

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
  
  // Priority 1: Custom manual key
  if (isRealKey(k1)) return k1;
  // Priority 2: Platform keys
  if (isRealKey(k2)) return k2;
  if (isRealKey(k3)) return k3;
  
  if (k1 && !isLabel(k1)) return k1;
  if (k2 && !isLabel(k2)) return k2;
  if (k3 && !isLabel(k3)) return k3;
  
  return "";
}

const geminiKey = getGeminiKey();

function getChatId() {
  const envId = process.env.TELEGRAM_CHAT_ID;
  if (envId) return envId;
  const row = db.prepare("SELECT value FROM settings WHERE key = 'chat_id'").get() as any;
  return row?.value;
}

let bot: TelegramBot | null = null;
let botUsername: string | null = null;
let lastTelegramError: string | null = null;
let lastIncomingChatId: string | null = null;
let lastMessageTime: string | null = null;

// WebSocket clients
const clients = new Set<WebSocket>();

// Browser instance
let browser: any = null;
const github = new GitHubService();

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

if (botToken) {
  try {
    console.log("Attempting to initialize Telegram Bot with token starting with:", botToken.substring(0, 4));
    // Enable polling for two-way communication
    bot = new TelegramBot(botToken, { polling: true });
    console.log("Telegram Bot instance created. Polling enabled.");

    bot.getMe().then(me => {
      botUsername = me.username || "Unknown";
      console.log(`Bot Identity Verified: @${me.username}`);
    }).catch(err => {
      lastTelegramError = "Init Error: " + err.message;
      console.error("Bot Identity Verification Failed:", err.message);
    });

    bot.on("polling_error", (err) => {
      lastTelegramError = err.message;
      if (err.message.includes("401")) {
        console.error("Telegram Auth Error: The provided BOT_TOKEN is invalid. Please verify it in the Secrets panel.");
      } else {
        console.error("Telegram Polling Error:", err.message);
      }
    });

    // Handle incoming messages
    bot.on("message", async (msg) => {
      lastIncomingChatId = msg.chat.id.toString();
      lastMessageTime = new Date().toLocaleTimeString();
      console.log(`[Telegram Event] Message received from ${msg.from?.username || 'unknown'} (ID: ${msg.chat.id})`);
      
      const incomingChatId = msg.chat.id.toString();
      const currentChatId = getChatId();
      
      // Log for user to see their ID
      console.log(`[Telegram] Incoming Chat ID: ${incomingChatId} | Configured Chat ID: ${currentChatId || 'NOT SET'}`);

      // Only respond to the configured user for security
      if (currentChatId && incomingChatId !== currentChatId) {
        console.log(`[Telegram] Unauthorized access attempt from ${incomingChatId}. Expected ${currentChatId}.`);
        return;
      }

      if (!msg.text && !msg.voice) {
        console.log("[Telegram] Message has no text or voice, skipping.");
        return;
      }

      try {
        const currentKey = getGeminiKey();
        if (!currentKey || currentKey.includes(' ')) {
          throw new Error("Invalid or missing API Key configuration.");
        }
        
        const ai = new GoogleGenAI({ apiKey: currentKey });
        const model = "gemini-3-flash-preview";

        // Get history from DB
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
          console.log("[Telegram] Processing voice message...");
          const fileLink = await bot!.getFileLink(msg.voice.file_id);
          const response = await fetch(fileLink);
          const buffer = await response.arrayBuffer();
          const base64Audio = Buffer.from(buffer).toString('base64');
          
          userParts.push({
            inlineData: {
              mimeType: "audio/ogg",
              data: base64Audio
            }
          });
          userLogText = "[Voice Message]";
        }

        contents.push({
          role: 'user',
          parts: userParts
        });

        const result = await ai.models.generateContent({
          model,
          contents,
          config: {
            systemInstruction: "You are ClawWeb, a personal AI assistant. You are responding via Telegram. You can browse the web using the 'browseWeb' tool. Keep responses concise and helpful. Always respond in Traditional Chinese (繁體中文). If the user asks for a reminder or to send a message later, use the 'sendTelegramMessage' tool with delayMs.",
            tools: [{
              functionDeclarations: [
                {
                  name: "sendTelegramMessage",
                  description: "Send a message or reminder to the user's Telegram account. Can be immediate or delayed.",
                  parameters: {
                    type: Type.OBJECT,
                    properties: {
                      message: {
                        type: Type.STRING,
                        description: "The content of the message or reminder to send."
                      },
                      delayMs: {
                        type: Type.NUMBER,
                        description: "Optional delay in milliseconds before sending the message (e.g., 60000 for 1 minute)."
                      }
                    },
                    required: ["message"]
                  }
                },
                {
                  name: "browseWeb",
                  description: "Browse a website to get its content or take a screenshot.",
                  parameters: {
                    type: Type.OBJECT,
                    properties: {
                      url: {
                        type: Type.STRING,
                        description: "The URL of the website to visit."
                      },
                      action: {
                        type: Type.STRING,
                        description: "The action to perform: 'content' (get text) or 'screenshot' (get base64 image).",
                        enum: ["content", "screenshot"]
                      }
                    },
                    required: ["url", "action"]
                  }
                },
                {
                  name: "syncToGitHub",
                  description: "Sync the current project source code to the configured GitHub repository.",
                  parameters: {
                    type: Type.OBJECT,
                    properties: {
                      confirm: {
                        type: Type.BOOLEAN,
                        description: "Must be true to proceed with the sync."
                      }
                    },
                    required: ["confirm"]
                  }
                }
              ]
            }]
          }
        });

        let responseText = result.text || "";
        
        // Handle function calls from Telegram
        if (result.functionCalls && result.functionCalls.length > 0) {
          for (const call of result.functionCalls) {
            if (call.name === 'sendTelegramMessage') {
              const { message: telMsg, delayMs } = call.args as any;
              
              const sendDelayed = async () => {
                try {
                  await bot!.sendMessage(incomingChatId, telMsg);
                  console.log(`[Telegram Bot] Delayed tool message sent: ${telMsg}`);
                } catch (e) {
                  console.error("Delayed tool message error:", e);
                }
              };

              if (delayMs && delayMs > 0) {
                setTimeout(sendDelayed, delayMs);
                responseText += `\n\n[Reminder set for ${delayMs/1000}s from now]`;
              } else {
                await bot!.sendMessage(incomingChatId, telMsg);
                responseText += `\n\n[Message sent]`;
              }
            } else if (call.name === 'browseWeb') {
              const { url, action } = call.args as any;
              try {
                const b = await getBrowser();
                const page = await b.newPage();
                
                // Set a realistic User-Agent
                await page.setUserAgent("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36");
                
                // Set viewport
                await page.setViewport({ width: 1280, height: 800 });

                await page.goto(url, { waitUntil: 'networkidle2', timeout: 30000 });
                
                if (action === 'content') {
                  const rawContent = await page.evaluate(() => document.body.innerText);
                  await page.close();
                  
                  try {
                    // Use Gemini to summarize the raw content
                    const summarizerResult = await ai.models.generateContent({
                      model: "gemini-3-flash-preview",
                      contents: [{ role: 'user', parts: [{ text: `Please summarize the following web content from ${url} into a clean, concise, and readable format in Traditional Chinese (繁體中文). Focus on the main information they were looking for:\n\n${rawContent.substring(0, 5000)}` }] }],
                      config: { systemInstruction: "You are a helpful assistant that summarizes web pages clearly in Traditional Chinese." }
                    });
                    responseText += `\n\n🌐 **從網頁獲取的摘要 (${url}):**\n${summarizerResult.text || "無法生成摘要"}`;
                  } catch (sumErr: any) {
                    console.error("Summarization failed:", sumErr);
                    // Fallback to raw content snippet if AI fails (e.g. 429 error)
                    const snippet = rawContent.trim().substring(0, 800).replace(/\n\s*\n/g, '\n');
                    responseText += `\n\n🌐 **網頁內容擷取 (${url}) [AI 摘要暫時不可用]:**\n${snippet}...`;
                  }
                } else if (action === 'screenshot') {
                  const screenshot = await page.screenshot({ encoding: 'base64' });
                  // For Telegram, we can't easily send base64 as text, but we could send as photo if we had the buffer
                  const buffer = Buffer.from(screenshot as string, 'base64');
                  await bot!.sendPhoto(incomingChatId, buffer, { caption: `Screenshot of ${url}` });
                  responseText += `\n\n[Screenshot sent to Telegram]`;
                }
                await page.close();
              } catch (e: any) {
                responseText += `\n\n[Browser Error: ${e.message}]`;
              }
            } else if (call.name === 'syncToGitHub') {
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
                responseText += `\n\n🚀 **GitHub 同步結果:**\n${result}`;
              } catch (e: any) {
                responseText += `\n\n[GitHub Error: ${e.message}]`;
              }
            }
          }
        }

        if (!responseText) responseText = "I'm sorry, I couldn't process that.";
        responseText += "\n\n[ClawWeb v1.0.7 - Active]";
        
        // Save to DB
        const userMsg = { role: 'user', content: userLogText, timestamp: new Date().toISOString() };
        const modelMsg = { role: 'model', content: responseText, timestamp: new Date().toISOString() };
        
        db.prepare("INSERT INTO messages (role, content) VALUES (?, ?)").run('user', userLogText);
        db.prepare("INSERT INTO messages (role, content) VALUES (?, ?)").run('model', responseText);

        // Broadcast to web clients
        broadcast({ type: 'NEW_MESSAGE', message: userMsg });
        broadcast({ type: 'NEW_MESSAGE', message: modelMsg });

        // Reply via Telegram
        await bot?.sendMessage(incomingChatId, responseText);
      } catch (err: any) {
        console.error("Telegram bot processing error:", err);
        const currentKey = getGeminiKey();
        const keyInfo = currentKey ? `(Key starts with: ${currentKey.substring(0, 6)}...)` : "(No valid key found)";
        await bot?.sendMessage(incomingChatId, `Neural core error: ${err.message}\n\nDebug Info: ${keyInfo}\n\nPlease ensure you have selected a valid API Key in the Secrets panel.`);
      }
    });
  } catch (err) {
    console.error("Failed to initialize Telegram Bot:", err);
  }
}

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

async function startServer() {
  const app = express();
  const PORT = 3000;

  app.use(express.json());

  app.get("/api/debug/status", (req, res) => {
    const currentKey = getGeminiKey();
    res.json({
      botTokenPresent: !!process.env.TELEGRAM_BOT_TOKEN,
      chatIdPresent: !!getChatId(),
      geminiKeyPresent: !!currentKey,
      geminiKeyPrefix: currentKey ? currentKey.substring(0, 4) + "..." : "None",
      botInitialized: !!bot,
      botUsername: botUsername,
      lastError: lastTelegramError,
      lastIncomingId: lastIncomingChatId,
      lastMsgTime: lastMessageTime,
      configuredChatId: getChatId(),
      nodeEnv: process.env.NODE_ENV
    });
  });

  app.post("/api/settings", (req, res) => {
    const { key, value } = req.body;
    db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)").run(key, value);
    res.json({ status: "ok" });
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
      res.json({ status: "ok", result });
    } catch (err: any) {
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

  app.post("/api/telegram/send", async (req, res) => {
    const { message, delayMs } = req.body;
    const currentChatId = getChatId();
    if (!bot || !currentChatId) {
      return res.status(400).json({ error: "Telegram bot not configured (Missing Chat ID)" });
    }
    
    const sendMessage = async () => {
      try {
        await bot!.sendMessage(currentChatId, message);
        console.log(`[Telegram] Delayed message sent: ${message}`);
      } catch (err) {
        console.error("Delayed Telegram send error:", err);
      }
    };

    if (delayMs && delayMs > 0) {
      console.log(`[Telegram] Scheduling message in ${delayMs}ms: ${message}`);
      setTimeout(sendMessage, delayMs);
      res.json({ status: "scheduled", delayMs });
    } else {
      try {
        await bot.sendMessage(currentChatId, message);
        res.json({ status: "ok" });
      } catch (err: any) {
        console.error("Telegram send error:", err);
        res.status(500).json({ error: err.message || "Failed to send to Telegram" });
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
    console.log(`Server running on http://localhost:${PORT}`);
  });
}

startServer();
