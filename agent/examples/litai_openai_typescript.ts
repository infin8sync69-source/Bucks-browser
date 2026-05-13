import OpenAI from "openai";
import "dotenv/config";

const apiKey = process.env.LITAI_API_KEY;

if (!apiKey || apiKey.startsWith("your_")) {
  console.error("Missing LITAI_API_KEY. Copy .env.example to .env and add your key.");
  process.exit(1);
}

const client = new OpenAI({
  apiKey,
  baseURL: process.env.LITAI_BASE_URL ?? "https://lightning.ai/api/v1",
});

const response = await client.chat.completions.create({
  model: process.env.LITAI_MODEL ?? "lightning-ai/deepseek-v4-pro",
  messages: [
    {
      role: "user",
      content: "Hello, world!",
    },
  ],
});

console.log(response.choices[0]?.message?.content);
