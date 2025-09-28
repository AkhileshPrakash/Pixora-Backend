import 'dotenv/config'; 
import express from 'express';
import cors from 'cors';
import { createClient } from '@supabase/supabase-js';
import { Telegraf } from 'telegraf';
import crypto from 'crypto';
import multer from 'multer'; 
import axios from 'axios'; 
import FormData from 'form-data'; // Used for constructing multipart requests for Telegram API

// Use in-memory storage for Multer as the file is immediately sent to Telegram
const upload = multer({ storage: multer.memoryStorage() }); 

// --- Configuration and Initialization ---

// 1. Supabase Client (Service Role Key for privileged access)
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

// 2. Telegram Bot (using Telegraf)
const bot = new Telegraf(process.env.TELEGRAM_BOT_TOKEN);
// Start the bot's polling mechanism to listen for new messages (e.g., the linking code)
bot.launch(); 

// 3. Express App Setup
const app = express();
const PORT = process.env.PORT || 3000;

// Enable CORS for frontend communication (essential for local testing and deployment)
app.use(cors()); 
app.use(express.json()); 

// --- Utility Functions ---

/**
 * Middleware to verify a Supabase session token (JWT)
 * and attach the authenticated user's ID to the request object.
 */
const authMiddleware = async (req, res, next) => {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
        return res.status(401).send({ error: 'Unauthorized: No token provided' });
    }

    const token = authHeader.split(' ')[1];
    
    // Verify the JWT token using the Supabase service role client
    // This securely tells us who the user is.
    const { data: { user }, error } = await supabase.auth.getUser(token);

    if (error || !user) {
        console.error("Authentication Error:", error?.message || 'Invalid Token');
        return res.status(401).send({ error: 'Unauthorized: Invalid token' });
    }

    req.userId = user.id;
    next();
};

/**
 * Retrieves the user's linked Telegram Chat ID from Supabase.
 * @param {string} userId - The Supabase user ID.
 * @returns {string|null} The telegram_chat_id or null if not linked.
 */
const getTelegramChatId = async (userId) => {
    const { data, error } = await supabase
        .from('user_telegram_settings')
        .select('telegram_chat_id')
        .eq('user_id', userId)
        .single();
    
    // PGRST116 is the error code for 'No rows found', which is expected if not linked yet.
    if (error && error.code !== 'PGRST116') { 
        console.error('Database Error retrieving chat ID:', error);
    }
    
    return data ? data.telegram_chat_id : null;
};

// --- Telegram Linking Logic ---

// Store temporary linking codes in memory (a simple Map works for a single instance)
const linkingCodes = new Map(); 

/**
 * Endpoint 1: Initiates the linking process by generating a unique code.
 * (Requires authentication)
 */
app.post('/api/link/initiate', authMiddleware, async (req, res) => {
    const userId = req.userId;

    // Check if user is already linked
    const existingLink = await getTelegramChatId(userId);
    
    if (existingLink) {
        return res.status(200).send({ 
            message: 'Telegram is already linked.', 
            linked: true 
        });
    }
    
    // Generate a secure, short, random linking code (e.g., A3B9C4)
    const code = crypto.randomBytes(3).toString('hex').toUpperCase(); 
    
    // Store the code mapped to the Supabase user ID
    linkingCodes.set(code, { userId, timestamp: Date.now() });

    // Clean up code after 10 minutes to prevent code reuse
    setTimeout(() => {
        linkingCodes.delete(code);
    }, 10 * 60 * 1000); 

    // Get bot username for clearer instructions
    const botUsername = bot.botInfo?.username ? `@${bot.botInfo.username}` : 'Your Telegram Bot';

    res.status(200).send({
        message: `Please send the following code to your Telegram Bot: **${code}**`,
        code: code,
        instructions: `Find your bot (${botUsername}), start a chat, and send the code "${code}" within 10 minutes.`,
        linked: false
    });
});


/**
 * Bot Listener: Handles incoming messages from Telegram users.
 * This is the crucial step that captures the user's private chat ID.
 */
bot.on('text', async (ctx) => {
    const receivedCode = ctx.message.text.trim().toUpperCase();
    const telegramChatId = ctx.chat.id.toString(); // Telegram Chat IDs are numbers, convert to string for DB

    if (linkingCodes.has(receivedCode)) {
        const { userId } = linkingCodes.get(receivedCode);

        // 1. Save the new telegram_chat_id to the database (UPSERT handles both INSERT and UPDATE)
        const { error } = await supabase
            .from('user_telegram_settings')
            .upsert({ user_id: userId, telegram_chat_id: telegramChatId }, { onConflict: 'user_id' });

        if (error) {
            console.error('Database link error:', error);
            ctx.reply('❌ Error linking your account. Please try again later.');
            return;
        }

        // 2. Respond to the user on Telegram
        ctx.reply(`✅ Success! Your web gallery account is now linked to this chat. You can now upload and view files via the web app.`);

        // 3. Remove the temporary code
        linkingCodes.delete(receivedCode);

    } else {
        // Unrecognized command or expired code
        ctx.reply(`Hello! This bot is for private file storage. To link your account, you must initiate the process on the web gallery app and send the unique code.`);
    }
});


// --- File Management Routes ---

/**
 * Endpoint 2: Handles file upload, sends to Telegram, and saves metadata.
 */
app.post('/api/upload', authMiddleware, upload.single('file'), async (req, res) => {
    const userId = req.userId;
    const file = req.file;

    if (!file) {
        return res.status(400).send({ error: 'No file provided.' });
    }

    // 1. Check if the user has linked their Telegram account
    const telegramChatId = await getTelegramChatId(userId);
    if (!telegramChatId) {
        return res.status(403).send({ error: 'Telegram account not linked. Please link your account first.' });
    }

    try {
        // 2. Construct the Telegram API URL for sending documents
        const TELEGRAM_API = `https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/sendDocument`;

        // 3. Prepare the multipart form data for the request
        const formData = new FormData();
        formData.append('chat_id', telegramChatId);
        
        // Append the file buffer as a document, specifying its original name and type
        formData.append('document', file.buffer, {
            filename: file.originalname,
            contentType: file.mimetype,
        }); 
        formData.append('caption', `Uploaded from Web Gallery: ${file.originalname}`);

        // 4. Send the file to Telegram using Axios
        const telegramResponse = await axios.post(TELEGRAM_API, formData, {
            headers: formData.getHeaders(),
        });

        // 5. Extract the file ID from Telegram's response
        // Telegram returns file information under 'document' for files, 
        // and under 'photo' (array of sizes) for images. We need the persistent file_id.
        const result = telegramResponse.data.result.document || (
                        telegramResponse.data.result.photo 
                        ? telegramResponse.data.result.photo.pop() // Get the largest photo size
                        : null
                       );
                       
        const telegramFileId = result?.file_id;

        if (!telegramFileId) {
            console.error('Telegram response missing file_id:', telegramResponse.data);
            return res.status(500).send({ error: 'Failed to retrieve permanent Telegram file ID.' });
        }
        
        // 6. Save the metadata to Supabase
        const { error: dbError } = await supabase
            .from('files')
            .insert({
                user_id: userId,
                telegram_file_id: telegramFileId,
                original_filename: file.originalname,
                mime_type: file.mimetype,
            });

        if (dbError) {
            console.error('Supabase metadata save error:', dbError);
            // Even if metadata fails, the file is saved in Telegram, but inaccessible via the app.
            return res.status(500).send({ error: 'File uploaded but failed to save metadata to the database.' });
        }

        res.status(201).send({
            message: 'File uploaded and metadata saved successfully.',
            filename: file.originalname,
            telegramId: telegramFileId
        });

    } catch (error) {
        console.error('File upload fatal error:', error.message);
        // Log detailed error from Telegram if available
        if (error.response?.data) {
             console.error('Telegram API Error Response:', error.response.data);
        }
        res.status(500).send({ error: `Upload failed: ${error.message}` });
    }
});


/**
 * Endpoint 3: Retrieves the list of file metadata for the gallery view.
 * (Requires authentication)
 */
app.get('/api/gallery', authMiddleware, async (req, res) => {
    // 1. Fetch all file metadata owned by the authenticated user
    const { data: files, error } = await supabase
        .from('files')
        .select('*')
        .eq('user_id', req.userId)
        .order('uploaded_at', { ascending: false }); // Sort newest first

    if (error) {
        console.error('Error fetching gallery metadata:', error);
        return res.status(500).send({ error: 'Failed to retrieve files from database.' });
    }
    
    // 2. Check if user is linked (required for generating retrieval URLs later)
    const telegramChatId = await getTelegramChatId(req.userId);
    
    // NOTE: This response only includes metadata. The actual file retrieval 
    // endpoint (/api/download) must be implemented next, but this is enough 
    // for the frontend to render the list.

    res.status(200).send({ 
        files: files, 
        isLinked: !!telegramChatId 
    });
});

app.get('/api/link/status', authMiddleware, async (req, res) => {
    const telegramChatId = await getTelegramChatId(req.userId);
    res.status(200).send({ linked: !!telegramChatId, telegramChatId });
});


// --- Server Start ---
app.listen(PORT, () => {
    console.log(`🚀 Backend API running on port ${PORT}`);
    console.log(`Supabase URL: ${process.env.SUPABASE_URL ? 'Loaded' : 'MISSING'}`);
    console.log(`Telegram Bot Token: ${process.env.TELEGRAM_BOT_TOKEN ? 'Loaded' : 'MISSING'}`);
});
