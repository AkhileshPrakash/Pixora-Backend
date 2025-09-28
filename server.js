// Final Version: Uses Telegram Widget Authentication (No Polling or Webhook)

import 'dotenv/config'; 
import express from 'express';
import cors from 'cors';
import { createClient } from '@supabase/supabase-js';
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

// 2. Telegram Bot Token
const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
if (!BOT_TOKEN) {
    console.error("FATAL ERROR: TELEGRAM_BOT_TOKEN is not defined in .env or environment.");
}

// 3. Express App Setup
const app = express();
const PORT = process.env.PORT || 8082; 

// Enable CORS for frontend communication
app.use(cors()); 
app.use(express.json()); 

// --- Utility Functions ---

/**
 * Middleware to verify a Supabase session token (JWT)
 */
const authMiddleware = async (req, res, next) => {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
        return res.status(401).send({ error: 'Unauthorized: No token provided' });
    }

    const token = authHeader.split(' ')[1];
    
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
 */
const getTelegramChatId = async (userId) => {
    const { data, error } = await supabase
        .from('user_telegram_settings')
        .select('telegram_chat_id')
        .eq('user_id', userId)
        .single();
    
    if (error && error.code !== 'PGRST116') { 
        console.error('Database Error retrieving chat ID:', error);
    }
    
    return data ? data.telegram_chat_id : null;
};

/**
 * Validates Telegram Login Widget hash for security.
 */
const validateTelegramHash = (data) => {
    if (!BOT_TOKEN) return false;

    // Create a data check string from all received fields except 'hash'
    const checkString = Object.keys(data)
        .filter(key => key !== 'hash')
        .map(key => `${key}=${data[key]}`)
        .sort()
        .join('\n');

    // Create the secret key for HMAC SHA256
    const secretKey = crypto.createHash('sha256').update(BOT_TOKEN).digest();
    
    // Calculate the hash
    const calculatedHash = crypto.createHmac('sha256', secretKey)
        .update(checkString)
        .digest('hex');

    return calculatedHash === data.hash;
};


// --- Telegram Widget Auth Endpoint ---

/**
 * Endpoint 1: Receives authentication data from the Telegram Login Widget.
 */
app.get('/api/auth/telegram', async (req, res) => {
    const userData = req.query;

    if (!validateTelegramHash(userData)) {
        console.error('Telegram Auth Failed: Invalid hash signature.');
        return res.redirect(`${process.env.SUPABASE_URL}/auth/v1/callback?error=telegram_auth_failed`);
    }

    // Hash is valid. Extract required IDs.
    const telegramChatId = userData.id.toString(); 

    // 1. Check if an existing Supabase user is logged in
    const session = await supabase.auth.getSession();
    const currentSupabaseUserId = session.data.session?.user.id;
    
    if (!currentSupabaseUserId) {
         console.error('Telegram Auth Failed: No active Supabase session to link to.');
         return res.redirect(`${process.env.SUPABASE_URL}/auth/v1/callback?error=no_active_supabase_session`);
    }

    // 2. Save/Update the link in the database
    const { error } = await supabase
        .from('user_telegram_settings')
        .upsert({ 
            user_id: currentSupabaseUserId, 
            telegram_chat_id: telegramChatId,
            telegram_username: userData.username || null
        }, { onConflict: 'user_id' });

    if (error) {
        console.error('Database link error:', error);
        return res.redirect(`${process.env.SUPABASE_URL}/auth/v1/callback?error=database_link_failed`);
    }

    // 3. Success: Redirect back to the application URL (Netlify site)
    res.redirect('/');
});


// --- File Management Routes ---

/**
 * Endpoint 2: Handles file upload, sends to Telegram, and saves metadata.
 */
app.post('/api/upload', authMiddleware, upload.single('file'), async (req, res) => {
    const userId = req.userId;
    const file = req.file;

    if (!file) return res.status(400).send({ error: 'No file provided.' });
    if (!BOT_TOKEN) return res.status(500).send({ error: 'Bot token missing on server.' });

    const telegramChatId = await getTelegramChatId(userId);
    if (!telegramChatId) {
        return res.status(403).send({ error: 'Telegram account not linked.' });
    }

    try {
        const TELEGRAM_API = `https://api.telegram.org/bot${BOT_TOKEN}/sendDocument`;
        const formData = new FormData();
        
        formData.append('chat_id', telegramChatId);
        formData.append('document', file.buffer, { filename: file.originalname, contentType: file.mimetype }); 
        formData.append('caption', `Uploaded from Pixora: ${file.originalname}`);

        const telegramResponse = await axios.post(TELEGRAM_API, formData, {
            headers: formData.getHeaders(),
        });

        // Extract the file ID
        const result = telegramResponse.data.result.document || (
                        telegramResponse.data.result.photo 
                        ? telegramResponse.data.result.photo.pop() 
                        : null
                       );
        const telegramFileId = result?.file_id;

        if (!telegramFileId) {
            console.error('Telegram response missing file_id:', telegramResponse.data);
            return res.status(500).send({ error: 'Failed to retrieve permanent Telegram file ID.' });
        }
        
        // Save the metadata to Supabase
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
            return res.status(500).send({ error: 'File uploaded but failed to save metadata to the database.' });
        }

        res.status(201).send({ message: 'File uploaded and metadata saved successfully.' });

    } catch (error) {
        console.error('File upload fatal error:', error.message);
        if (error.response?.data) { console.error('Telegram API Error Response:', error.response.data); }
        res.status(500).send({ error: `Upload failed: ${error.message}` });
    }
});


/**
 * Endpoint 3 & 4: Retrieval and Link Status
 */
app.get('/api/gallery', authMiddleware, async (req, res) => {
    const { data: files, error } = await supabase
        .from('files')
        .select('*')
        .eq('user_id', req.userId)
        .order('uploaded_at', { ascending: false }); 

    if (error) return res.status(500).send({ error: 'Failed to retrieve files from database.' });
    res.status(200).send({ files: files });
});

app.get('/api/link/status', authMiddleware, async (req, res) => {
    const telegramChatId = await getTelegramChatId(req.userId);
    res.status(200).send({ linked: !!telegramChatId });
});


// --- Server Start ---
app.listen(PORT, () => {
    console.log(`🚀 Backend API running on port ${PORT}`);
    console.log(`Supabase URL: ${process.env.SUPABASE_URL ? 'Loaded' : 'MISSING'}`);
    console.log(`Telegram Bot Token: ${BOT_TOKEN ? 'Loaded' : 'MISSING'}`);
});
