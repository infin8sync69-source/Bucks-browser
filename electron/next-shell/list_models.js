const { GoogleGenerativeAI } = require("@google/generative-ai");
const genAI = new GoogleGenerativeAI("AIzaSyCGLxPfSIqjSu3NGa9jqcy9qjDne-SAcQk");

async function run() {
  try {
    const fetch = require('node-fetch');
    const res = await fetch('https://generativelanguage.googleapis.com/v1beta/models?key=AIzaSyCGLxPfSIqjSu3NGa9jqcy9qjDne-SAcQk');
    const data = await res.json();
    console.log(JSON.stringify(data.models.map(m => m.name), null, 2));
  } catch (e) {
    console.error("Failed:", e.message);
  }
}
run();
