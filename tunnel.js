// This script starts an ngrok tunnel to allow the public Telegram API
// to send webhooks to your local Node.js server running on port 8082.

import ngrok from 'ngrok';
import 'dotenv/config';

// NOTE: This port must match the port your backend server is running on (PORT=8082 in your .env file)
const BACKEND_PORT = 8082; 
// This path must match the endpoint defined in server.js
const WEBHOOK_PATH = '/telegram/webhook';
// Your Telegram Bot Token is loaded from the environment variables
const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN; 
// Your NGROK token is loaded from the environment variables (CRUCIAL FIX)
const NGROK_TOKEN = process.env.NGROK_AUTH_TOKEN;

if (!BOT_TOKEN) {
    console.error("FATAL ERROR: TELEGRAM_BOT_TOKEN is not defined in .env or not accessible.");
    process.exit(1);
}
if (!NGROK_TOKEN) {
    console.error("FATAL ERROR: NGROK_AUTH_TOKEN is not defined in .env. Please add it.");
    process.exit(1);
}


async function startTunnel() {
    try {
        const url = await ngrok.connect({
            addr: BACKEND_PORT,
            proto: 'http', 
            region: 'in',
            authtoken: NGROK_TOKEN, // Explicitly provide the token
        });

        const webhookUrl = `${url}${WEBHOOK_PATH}`;
        
        console.log("----------------------------------------------------------------------------------");
        console.log(`🚀 ngrok tunnel established! Backend Port ${BACKEND_PORT} is publicly accessible.`);
        console.log(`Public URL: ${url}`);
        
        // --- STEP 1: Set the Webhook on Telegram's side ---
        const telegramSetWebhookUrl = `https://api.telegram.org/bot${BOT_TOKEN}/setWebhook?url=${webhookUrl}`;
        
        console.log("\n----------------------------------------------------------------------------------");
        console.log("STEP 1: Copy the link below and open it in your browser to set the Telegram Webhook:");
        console.log(`  👉 ${telegramSetWebhookUrl}`);
        console.log("----------------------------------------------------------------------------------");
        
        console.log("\nSTEP 2: In the browser, you must see: {\"ok\":true,\"result\":true,\"description\":\"Webhook was set\"}");
        console.log("----------------------------------------------------------------------------------");

    } catch (error) {
        console.error(`ngrok connection failed. Check if port ${BACKEND_PORT} is busy or if your token is invalid.`);
        console.error("Error details:", error.message);
        process.exit(1);
    }
}

startTunnel();
