const { GoogleGenerativeAI } = require("@google/generative-ai");
const genAI = new GoogleGenerativeAI("AIzaSyCGLxPfSIqjSu3NGa9jqcy9qjDne-SAcQk");

async function run() {
  try {
    const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });
    const result = await model.generateContent("Hi");
    console.log("Flash works:", result.response.text());
  } catch (e) {
    console.error("Flash failed:", e.message);
  }
}
run();
