require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { OpenAI } = require('openai');
const axios = require('axios');
const { createClient } = require('@supabase/supabase-js');

const app = express();
app.use(cors());
app.use(express.json({ limit: '20mb' }));

// ============================================================
// All API keys live ONLY here in Server 2 via .env
// ============================================================
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
const GOOGLE_SEARCH_API_KEY = process.env.GOOGLE_SEARCH_API_KEY;
const GOOGLE_SEARCH_ENGINE_ID = process.env.GOOGLE_SEARCH_ENGINE_ID;

// Helper for structured logging with timestamp
const log = (level, action, message, extra = '') => {
  const ts = new Date().toISOString();
  const prefix = `[${ts}] [${level}] [${action}]`;
  if (level === 'ERROR') {
    console.error(`${prefix} ${message}`, extra || '');
  } else if (level === 'WARNING') {
    console.warn(`${prefix} ${message}`, extra || '');
  } else {
    console.log(`${prefix} ${message}`, extra || '');
  }
};

if (!OPENAI_API_KEY) {
  log('WARNING', 'SYSTEM', 'OPENAI_API_KEY not set. AI features will fail.');
}
if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
  log('ERROR', 'SYSTEM', 'SUPABASE_URL and SUPABASE_SERVICE_KEY must be set in .env');
  process.exit(1);
}

const openai = new OpenAI({ apiKey: OPENAI_API_KEY });
const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

// ---- Health check ----
app.get('/health', (req, res) => {
  log('INFO', '/health', 'Health check ping');
  res.json({ status: 'ok', server: 'processor' });
});

// ---- Main processor endpoint (only accessible from Server 1, not public) ----
app.post('/process', async (req, res) => {
  const { userId, requestData } = req.body;
  const action = requestData?.action || 'unknown';

  log('INFO', '/process', `Incoming request: action='${action}' userId=${userId}`);

  try {
    if (!requestData || !requestData.action) {
      log('WARNING', '/process', 'Bad request: missing action');
      return res.status(400).json({ error: 'Invalid request: missing action' });
    }

    let result = {};

    switch (requestData.action) {

      // ---- AI Chat ----
      case 'chat': {
        log('INFO', 'chat', `Model: ${requestData.model || 'gpt-4o'}, Messages: ${requestData.messages?.length}`);
        try {
          const completion = await openai.chat.completions.create({
            model: requestData.model || 'gpt-4o',
            messages: requestData.messages,
          });
          result = { reply: completion.choices[0].message.content };
          log('INFO', 'chat', `Response generated (${result.reply.length} chars)`);
        } catch (aiErr) {
          log('ERROR', 'chat', `OpenAI Error: ${aiErr.message}`, aiErr.stack);
          throw aiErr;
        }
        break;
      }

      // ---- Image analysis (Snipping AI) ----
      case 'analyze_image': {
        log('INFO', 'analyze_image', `Prompt: "${requestData.prompt}"`);
        try {
          const imageUrl = requestData.image
            ? `data:image/png;base64,${requestData.image}`
            : requestData.imageDataUrl;

          if (!imageUrl) throw new Error('No image data provided');

          const completion = await openai.chat.completions.create({
            model: 'gpt-4o',
            messages: [
              {
                role: 'user',
                content: [
                  { type: 'text', text: requestData.prompt || 'What is in this image?' },
                  { type: 'image_url', image_url: { url: imageUrl } },
                ],
              },
            ],
            max_tokens: 1024,
          });
          result = { result: completion.choices[0].message.content };
          log('INFO', 'analyze_image', `Analysis done (${result.result.length} chars)`);
        } catch (aiErr) {
          log('ERROR', 'analyze_image', `OpenAI Error: ${aiErr.message}`, aiErr.stack);
          throw aiErr;
        }
        break;
      }

      // ---- Google Search + AI Summary ----
      case 'search': {
        log('INFO', 'search', `Query: "${requestData.query}"`);
        let links = [];

        try {
          if (GOOGLE_SEARCH_API_KEY && GOOGLE_SEARCH_ENGINE_ID) {
            const googleRes = await axios.get('https://www.googleapis.com/customsearch/v1', {
              params: { key: GOOGLE_SEARCH_API_KEY, cx: GOOGLE_SEARCH_ENGINE_ID, q: requestData.query, num: 5 },
            });
            links = (googleRes.data.items || []).map(item => ({ title: item.title, url: item.link, snippet: item.snippet }));
            log('INFO', 'search', `Google returned ${links.length} results`);
          } else {
            log('WARNING', 'search', 'No Google API keys configured, using fallback links');
            links = [
              { title: `Wikipedia: ${requestData.query}`, url: `https://en.wikipedia.org/wiki/${encodeURIComponent(requestData.query)}`, snippet: '' },
              { title: `Google: ${requestData.query}`, url: `https://www.google.com/search?q=${encodeURIComponent(requestData.query)}`, snippet: '' },
            ];
          }

          const snippetText = links.map(l => `Title: ${l.title}\nSnippet: ${l.snippet}`).join('\n\n');
          const summaryCompletion = await openai.chat.completions.create({
            model: 'gpt-3.5-turbo',
            messages: [{ role: 'user', content: `Summarize the following search results for the query "${requestData.query}":\n\n${snippetText}` }],
          });
          result = { summary: summaryCompletion.choices[0].message.content, links };
          log('INFO', 'search', 'Summary generated');
        } catch (searchErr) {
          log('ERROR', 'search', `Error: ${searchErr.message}`, searchErr.stack);
          throw searchErr;
        }
        break;
      }

      // ---- Save Note to Supabase ----
      case 'save_note': {
        log('INFO', 'save_note', `Saving note id=${requestData.id} for user ${userId}`);
        try {
          const { data, error } = await supabase
            .from('notes')
            .upsert({ id: requestData.id, user_id: userId, title: requestData.title, content: requestData.content, updated_at: new Date().toISOString() })
            .select()
            .single();
          if (error) { log('ERROR', 'save_note', `Supabase error: ${error.message}`); throw error; }
          result = { note: data };
          log('INFO', 'save_note', 'Note saved successfully');
        } catch (dbErr) {
          log('ERROR', 'save_note', `DB Error: ${dbErr.message}`, dbErr.stack);
          throw dbErr;
        }
        break;
      }

      // ---- Fetch Notes from Supabase ----
      case 'fetch_notes': {
        log('INFO', 'fetch_notes', `Fetching notes for user ${userId}`);
        try {
          const { data, error } = await supabase
            .from('notes')
            .select('*')
            .eq('user_id', userId)
            .order('updated_at', { ascending: false });
          if (error) { log('ERROR', 'fetch_notes', `Supabase error: ${error.message}`); throw error; }
          result = { notes: data };
          log('INFO', 'fetch_notes', `Returned ${data.length} notes`);
        } catch (dbErr) {
          log('ERROR', 'fetch_notes', `DB Error: ${dbErr.message}`, dbErr.stack);
          throw dbErr;
        }
        break;
      }

      // ---- Upload profile picture to Supabase Storage ----
      case 'upload_profile_pic': {
        log('INFO', 'upload_profile_pic', `Uploading avatar for user ${userId}`);
        try {
          const buffer = Buffer.from(requestData.fileBase64, 'base64');
          const fileName = `avatars/${userId}/profile.${requestData.ext || 'png'}`;
          const { error } = await supabase.storage
            .from('user-assets')
            .upload(fileName, buffer, { contentType: requestData.mimeType || 'image/png', upsert: true });
          if (error) { log('ERROR', 'upload_profile_pic', `Supabase Storage error: ${error.message}`); throw error; }
          const { data: urlData } = supabase.storage.from('user-assets').getPublicUrl(fileName);
          result = { publicUrl: urlData.publicUrl };
          log('INFO', 'upload_profile_pic', `Avatar uploaded: ${urlData.publicUrl}`);
        } catch (dbErr) {
          log('ERROR', 'upload_profile_pic', `Error: ${dbErr.message}`, dbErr.stack);
          throw dbErr;
        }
        break;
      }

      // ---- Save user profile to Supabase ----
      case 'save_profile': {
        log('INFO', 'save_profile', `Saving profile for user ${userId}`);
        try {
          const { profile } = requestData;
          if (!profile) throw new Error('profile field is required in requestData');
          const { error: profileError } = await supabase
            .from('profiles')
            .upsert({ user_id: userId, ...profile, updated_at: new Date().toISOString() });
          if (profileError) { log('ERROR', 'save_profile', `Supabase error: ${profileError.message}`); throw profileError; }
          result = { success: true };
          log('INFO', 'save_profile', 'Profile saved successfully');
        } catch (dbErr) {
          log('ERROR', 'save_profile', `Error: ${dbErr.message}`, dbErr.stack);
          throw dbErr;
        }
        break;
      }

      // ---- Fetch Global Chat ----
      case 'fetch_chat': {
        log('INFO', 'fetch_chat', `Fetching last 50 chat messages`);
        try {
          // Step 1: Fetch chats
          const { data: chats, error } = await supabase
            .from('global_chats')
            .select('id, message, created_at, user_id')
            .order('created_at', { ascending: false })
            .limit(50);
          if (error) { log('ERROR', 'fetch_chat', `Supabase error: ${error.message}`); throw error; }

          // Step 2: Fetch profiles for the unique user_ids in this batch
          const uniqueUserIds = [...new Set(chats.map(c => c.user_id))];
          let profileMap = {};
          if (uniqueUserIds.length > 0) {
            const { data: profiles } = await supabase
              .from('profiles')
              .select('user_id, "accountName", "profilePicUrl"')
              .in('user_id', uniqueUserIds);
            if (profiles) {
              profiles.forEach(p => { profileMap[p.user_id] = p; });
            }
          }

          // Step 3: Merge
          const enriched = chats.reverse().map(c => ({
            ...c,
            profiles: profileMap[c.user_id] || null
          }));

          result = { chats: enriched };
          log('INFO', 'fetch_chat', `Returned ${enriched.length} messages`);
        } catch (dbErr) {
          log('ERROR', 'fetch_chat', `Error: ${dbErr.message}`, dbErr.stack);
          throw dbErr;
        }
        break;
      }

      // ---- Send Chat Message ----
      case 'send_chat': {
        log('INFO', 'send_chat', `User ${userId} sending message`);
        try {
          const { message } = requestData;
          if (!message) throw new Error('message field is required');
          const { error } = await supabase
            .from('global_chats')
            .insert({ user_id: userId, message });
          if (error) { log('ERROR', 'send_chat', `Supabase error: ${error.message}`); throw error; }
          result = { success: true };
          log('INFO', 'send_chat', 'Message saved successfully');
        } catch (dbErr) {
          log('ERROR', 'send_chat', `Error: ${dbErr.message}`, dbErr.stack);
          throw dbErr;
        }
        break;
      }

      // ---- Fetch User Profile ----
      case 'fetch_profile': {
        log('INFO', 'fetch_profile', `Fetching profile for user ${userId}`);
        try {
          const { data, error } = await supabase
            .from('profiles')
            .select('*')
            .eq('user_id', userId)
            .single();
          if (error && error.code !== 'PGRST116') throw error;
          result = { profile: data || {} };
          log('INFO', 'fetch_profile', `Profile fetched successfully`);
        } catch (dbErr) {
          log('ERROR', 'fetch_profile', `Error: ${dbErr.message}`, dbErr.stack);
          throw dbErr;
        }
        break;
      }

      default:
        log('WARNING', '/process', `Unknown action: '${requestData.action}'`);
        result = { error: `Unknown action: ${requestData.action}` };
    }

    log('INFO', '/process', `Action '${action}' completed successfully`);
    res.json(result);

  } catch (error) {
    log('ERROR', `/process:${action}`, `Unhandled error: ${error.message}`, error.stack);
    res.status(500).json({ error: 'Processor Error', details: error.message });
  }
});

const PORT = process.env.PORT || 3002;
app.listen(PORT, () => {
  log('INFO', 'SYSTEM', `Processor running on port ${PORT}`);
});
