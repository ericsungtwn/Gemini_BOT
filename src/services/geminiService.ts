/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { GoogleGenAI, Type } from "@google/genai";
import { Message } from "../types";

const SYSTEM_INSTRUCTION = `You are ClawWeb, a personal AI assistant inspired by OpenClaw. 
Your goal is to be helpful, efficient, and professional. 
You have persistent memory (the conversation history you see).
You should maintain a "Technical Dashboard" personality: precise, scannable, and informative.
ALWAYS respond in Traditional Chinese (繁體中文).

CAPABILITIES:
1. Persistent SQLite memory.
2. Telegram Integration: You can send messages, reminders, and voice processing to the user's Telegram.
3. Web Browsing: You can browse websites, extract content, and take screenshots using the 'browseWeb' tool.
4. GitHub Sync: You can sync the current project's source code to a GitHub repository using the 'syncToGitHub' tool.

If the user asks to send a message or reminder to Telegram, use the 'sendTelegramMessage' tool.
If the user asks to check a website or see what's on a page, use the 'browseWeb' tool.
If the user asks to save or backup the source code to GitHub, use the 'syncToGitHub' tool.
Always confirm to the user after you have successfully called the tool.`;

export class GeminiService {
  private ai: any;

  constructor() {
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
    
    let apiKey = "";
    if (isRealKey(k1)) apiKey = k1;
    else if (isRealKey(k2)) apiKey = k2;
    else if (isRealKey(k3)) apiKey = k3;
    else if (k1 && !isLabel(k1)) apiKey = k1;
    else if (k2 && !isLabel(k2)) apiKey = k2;
    
    if (!apiKey) {
      console.error("GEMINI_API_KEY is missing or invalid label detected.");
    }
    this.ai = new GoogleGenAI({ apiKey: apiKey || "MISSING_KEY" });
  }

  async chat(userMessage: string, history: Message[]): Promise<{ text: string, functionCalls?: any[] }> {
    const model = "gemini-3-flash-preview";
    
    const contents = history.map(msg => ({
      role: msg.role === 'model' ? 'model' : 'user',
      parts: [{ text: msg.content }]
    }));

    contents.push({
      role: 'user',
      parts: [{ text: userMessage }]
    });

    const response = await this.ai.models.generateContent({
      model,
      contents,
      config: {
        systemInstruction: SYSTEM_INSTRUCTION,
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
      },
    });

    return {
      text: response.text || "",
      functionCalls: response.functionCalls
    };
  }
}

export const gemini = new GeminiService();
