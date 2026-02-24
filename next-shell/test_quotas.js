const { GoogleGenerativeAI } = require("@google/generative-ai");
const genAI = new GoogleGenerativeAI("AIzaSyCGLxPfSIqjSu3NGa9jqcy9qjDne-SAcQk");

async function testModel(modelName) {
  try {
    const model = genAI.getGenerativeModel({ model: modelName });
    const result = await model.generateContent("Hi");
    console.log(`✅ ${modelName} works:`, result.response.text().trim());
  } catch (e) {
    if (e.message.includes("429")) {
      console.log(`❌ ${modelName} failed: QUOTA EXCEEDED (429)`);
    } else if (e.message.includes("404")) {
      console.log(`❌ ${modelName} failed: NOT FOUND (404)`);
    } else {
      console.log(`❌ ${modelName} failed:`, e.message.split('\n')[0]);
    }
  }
}

async function run() {
  await testModel("gemini-1.5-pro");
  await testModel("gemini-1.5-flash");
  await testModel("gemini-2.0-flash");
  await testModel("gemini-2.0-flash-lite");
  await testModel("gemini-2.5-flash");
  await testModel("gemini-flash-latest");
}
run();
