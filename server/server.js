// server.js
const express = require('express');
const cors = require('cors');
const bodyParser = require('body-parser');
const fs = require('fs').promises;
const path = require('path');
const axios = require('axios');

const app = express();
const PORT = 3000;

// Middleware
app.use(cors());
app.use(bodyParser.json());
app.use(express.static('public'));

// In-memory data storage (for demonstration purposes)
let posts = [];
let webhookSubscribers = [];
let externalWebhookUrl = '';

// File paths for persistence
const DATA_DIR = path.join(__dirname, 'data');
const POSTS_FILE = path.join(DATA_DIR, 'posts.json');
const WEBHOOK_CONFIG_FILE = path.join(DATA_DIR, 'webhook-config.json');

// Ensure data directory exists
async function ensureDataDir() {
    try {
        await fs.mkdir(DATA_DIR, { recursive: true });
    } catch (error) {
        console.error('Error creating data directory:', error);
    }
}

// Load data from files on startup
async function loadData() {
    try {
        await ensureDataDir();
        
        try {
            const postsData = await fs.readFile(POSTS_FILE, 'utf8');
            posts = JSON.parse(postsData);
        } catch (error) {
            // If file doesn't exist yet, use empty array
            posts = [];
        }
        
        try {
            const webhookConfig = await fs.readFile(WEBHOOK_CONFIG_FILE, 'utf8');
            const config = JSON.parse(webhookConfig);
            externalWebhookUrl = config.url || '';
        } catch (error) {
            // If file doesn't exist yet, use empty string
            externalWebhookUrl = '';
        }
        
        console.log('Data loaded successfully');
    } catch (error) {
        console.error('Error loading data:', error);
    }
}

// Save data to files
async function saveData() {
    try {
        await ensureDataDir();
        await fs.writeFile(POSTS_FILE, JSON.stringify(posts, null, 2));
        await fs.writeFile(WEBHOOK_CONFIG_FILE, JSON.stringify({ url: externalWebhookUrl }, null, 2));
    } catch (error) {
        console.error('Error saving data:', error);
    }
}

// Routes

// Get all blog posts
app.get('/posts', (req, res) => {
    res.json(posts);
});

// Create a new blog post
app.post('/posts', async (req, res) => {
    try {
        const { title, content, date } = req.body;
        
        if (!title || !content) {
            return res.status(400).json({ error: 'Title and content are required' });
        }
        
        const newPost = {
            id: Date.now(),
            title,
            content,
            date: date || new Date().toISOString()
        };
        
        posts.push(newPost);
        await saveData();
        
        // Notify all connected SSE clients
        notifySubscribers('new-post', { postId: newPost.id });
        
        // Send webhook to external URL
        if (externalWebhookUrl) {
            sendExternalWebhook({
                event: 'new-post',
                data: {
                    id: newPost.id,
                    title: newPost.title,
                    date: newPost.date
                }
            });
        }
        
        res.status(201).json(newPost);
    } catch (error) {
        console.error('Error creating post:', error);
        res.status(500).json({ error: 'Failed to create post' });
    }
});

// Save webhook configuration
app.post('/webhook-config', async (req, res) => {
    try {
        const { url } = req.body;
        
        if (!url) {
            return res.status(400).json({ error: 'Webhook URL is required' });
        }
        
        externalWebhookUrl = url;
        await saveData();
        
        res.json({ success: true, message: 'Webhook configuration saved' });
    } catch (error) {
        console.error('Error saving webhook config:', error);
        res.status(500).json({ error: 'Failed to save webhook configuration' });
    }
});

// Test webhook
app.post('/test-webhook', async (req, res) => {
    try {
        if (!externalWebhookUrl) {
            return res.status(400).json({ 
                success: false, 
                message: 'No webhook URL configured' 
            });
        }
        
        const testData = {
            event: 'test',
            data: {
                message: 'This is a test webhook',
                timestamp: new Date().toISOString()
            }
        };
        
        const webhookResponse = await sendExternalWebhook(testData);
        
        if (webhookResponse.success) {
            res.json({ 
                success: true, 
                message: 'Webhook test successful' 
            });
        } else {
            res.json({ 
                success: false, 
                message: `Webhook test failed: ${webhookResponse.error}` 
            });
        }
    } catch (error) {
        console.error('Error testing webhook:', error);
        res.status(500).json({ 
            success: false, 
            message: `Error: ${error.message}` 
        });
    }
});

// Server-Sent Events (SSE) endpoint for real-time updates
app.get('/webhook-events', (req, res) => {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    
    // Send initial connection message
    res.write(`data: ${JSON.stringify({ event: 'connected' })}\n\n`);
    
    // Add this client to subscribers
    const clientId = Date.now();
    const newClient = {
        id: clientId,
        res
    };
    
    webhookSubscribers.push(newClient);
    
    // Remove client when connection closes
    req.on('close', () => {
        webhookSubscribers = webhookSubscribers.filter(client => client.id !== clientId);
    });
});

// Function to notify all SSE subscribers
function notifySubscribers(event, data) {
    webhookSubscribers.forEach(client => {
        client.res.write(`data: ${JSON.stringify({ event, ...data })}\n\n`);
    });
}

// Function to send webhook to external URL
async function sendExternalWebhook(data) {
    try {
        if (!externalWebhookUrl) {
            return { success: false, error: 'No webhook URL configured' };
        }
        
        const response = await axios.post(externalWebhookUrl, data, {
            headers: {
                'Content-Type': 'application/json',
                'X-Webhook-Source': 'blog-application'
            },
            timeout: 5000 // 5 second timeout
        });
        
        console.log('Webhook sent successfully:', response.status);
        return { success: true };
    } catch (error) {
        console.error('Error sending webhook:', error.message);
        return { success: false, error: error.message };
    }
}

// Serve static files
app.get('/client', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'client.html'));
});

app.get('/admin', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'admin.html'));
});

// Initialize the server
async function initServer() {
    await loadData();
    
    app.listen(PORT, () => {
        console.log(`Server running on http://localhost:${PORT}`);
        console.log(`- Client view: http://localhost:${PORT}/client`);
        console.log(`- Admin panel: http://localhost:${PORT}/admin`);
    });
}

initServer();