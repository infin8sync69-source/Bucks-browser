const { GoogleGenerativeAI } = require("@google/generative-ai");
const genAI = new GoogleGenerativeAI("AIzaSyCGLxPfSIqjSu3NGa9jqcy9qjDne-SAcQk");

async function testModel(modelName) {
    try {
        const model = genAI.getGenerativeModel({ model: modelName });
        const result = await model.generateContent("Say 'hi'");
        console.log(`✅ ${modelName} WORKS:`, result.response.text().trim());
    } catch (e) {
        if (e.message.includes("429")) {
            console.log(`❌ ${modelName} Failed: QUOTA EXCEEDED (429)`);
        } else if (e.message.includes("404")) {
            console.log(`❌ ${modelName} Failed: NOT FOUND (404)`);
        } else {
            console.log(`❌ ${modelName} Failed:`, e.message.split('\n')[0]);
        }
    }
}

async function run() {
    const modelsToTest = [
        "gemini-2.5-flash",
        "gemini-flash-latest",
        "gemini-pro-latest",
        "gemma-3-4b-it",
        "gemini-1.5-flash-latest",
    ];
    for (const m of modelsToTest) {
        await testModel(m);
    }
}
run();
