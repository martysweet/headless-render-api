const express = require('express');
const { chromium } = require('playwright');
const compression = require('compression');
const pino = require('pino');
const { GlideClient, ConnectionTimeoutError } = require('@valkey/valkey-glide');
const { v4: uuidv4 } = require('uuid');


// Initialize logger
const logger = pino({
    level: process.env.LOG_LEVEL || 'info',
});

const app = express();
const PORT = process.env.PORT || 3000;
const STATE_STORAGE_ENABLED = process.env.STATE_STORAGE_ENABLED === 'true'; // Enable Valkey storage
const STATE_STORAGE_VALKEY_HOST = process.env.STATE_STORAGE_VALKEY_HOST || 'valkey';
const STATE_STORAGE_VALKEY_PORT = process.env.STATE_STORAGE_VALKEY_PORT || 6379;
const STATE_STORAGE_TTL = process.env.STATE_STORAGE_TTL || 1800; // 30 minutes default

// Middleware to parse JSON bodies
app.use(express.json());
app.use(compression());

// logger middleware
app.use((req,res,next) =>{
    req.time = new Date().toISOString();
    logger.info({
        method: req.method,
        path: req.path,
        timestamp: req.time
    }, 'HTTP Request');
    next();
});

// Initialize browser instance
let browser;
let valkeyClient;

async function initBrowser() {
    try {
        browser = await chromium.launch({
            headless: true,
            args: [
                '--no-sandbox',
                '--disable-setuid-sandbox',
                '--disable-dev-shm-usage',
                '--disable-accelerated-2d-canvas',
                '--no-first-run',
                '--no-zygote',
                '--disable-gpu'
            ]
        });
        logger.info('Browser initialized successfully');
    } catch (error) {
        logger.error({ error: error.message, stack: error.stack }, 'Failed to initialize browser');
        process.exit(1);
    }
}

async function connectToValkey() {
    if (!STATE_STORAGE_ENABLED) {
        logger.info('Valkey storage disabled');
        return null;
    }

    try {
        valkeyClient = await GlideClient.createClient({
            addresses: [{
                host: STATE_STORAGE_VALKEY_HOST,
                port: STATE_STORAGE_VALKEY_PORT
            }]
        });

        logger.info({ host: STATE_STORAGE_VALKEY_HOST, port: STATE_STORAGE_VALKEY_PORT }, 'Valkey connection established');
        return valkeyClient;
    } catch (error) {
        if (error instanceof ConnectionTimeoutError) {
            logger.error({ error: error.message }, 'Valkey connection timeout');
        } else {
            logger.error({ error: error.message, stack: error.stack }, 'Failed to connect to Valkey');
        }
        return null;
    }
}

// Storing session state to Valkey
async function storeSessionState(sessionId, context) {
    if (!STATE_STORAGE_ENABLED || !valkeyClient) {
        logger.debug('Storage state disabled or Valkey client not available');
        return false;
    }

    try {
        const storage = await context.storageState();
        // Store as JSON string with TTL
        const key = `session:${sessionId}`;
        await valkeyClient.set(key, JSON.stringify(storage), { expiry: { type: 'EX', count: STATE_STORAGE_TTL } });

        logger.info({ sessionId, ttl: STATE_STORAGE_TTL }, 'Session state stored successfully');
        return true;
    } catch (error) {
        logger.error({ error: error.message, stack: error.stack, sessionId }, 'Failed to store session state');
        return false;
    }
}

// Retrieving session state from Valkey, this should be fed into the Session initialisation
async function getSessionState(sessionId) {
    if (!STATE_STORAGE_ENABLED || !valkeyClient) {
        logger.debug('Storage state disabled or Valkey client not available');
        return null;
    }

    try {
        const key = `session:${sessionId}`;
        const storedState = await valkeyClient.get(key);

        if (!storedState) {
            logger.debug({ sessionId }, 'No session state found for sessionId');
            return null;
        }

        const storageState = JSON.parse(storedState);
        logger.info({ sessionId }, 'Session state retrieved successfully');
        return storageState;
    } catch (error) {
        logger.error({ error: error.message, stack: error.stack, sessionId }, 'Failed to load session state');
        return null;
    }
}

// Generate cryptographically secure session ID
function generateSessionId() {
    return uuidv4();
}

// Check if session exists in Valkey
async function sessionExists(sessionId) {
    if (!STATE_STORAGE_ENABLED || !valkeyClient) {
        return false;
    }

    try {
        const key = `session:${sessionId}`;
        const exists = await valkeyClient.exists([key]);
        return exists === 1;
    } catch (error) {
        logger.error({ error: error.message, sessionId }, 'Failed to check session existence');
        return false;
    }
}

// POST endpoint to fetch content
app.post('/content', async (req, res) => {
    const { url, sessionId } = req.body;

    // Validate input
    if (!url) {
        return res.status(400).json({
            statusCode: 400,
            error: 'URL is required'
        });
    }

    // Validate user-provided or generate new UUID
    let currentSessionId;
    if (sessionId) {
        // Check if user-provided session exists
        const exists = await sessionExists(sessionId);
        if (exists) {
            currentSessionId = sessionId;
            logger.info({ sessionId }, 'Using existing user-provided session');
        } else {
            currentSessionId = generateSessionId();
            logger.info({ providedSessionId: sessionId, newSessionId: currentSessionId }, 'User-provided session not found, generated new UUID');
        }
    } else {
        currentSessionId = generateSessionId();
        logger.info({ sessionId: currentSessionId }, 'Generated new session ID');
    }

    // Validate URL format
    try {
        new URL(url);
    } catch (error) {
        return res.status(400).json({
            statusCode: 400,
            error: 'Invalid URL format'
        });
    }

    let context;
    let page;
    let existingStorageState = null;

    logger.info({ url, sessionId: currentSessionId }, 'Fetching content for URL');

    // Try to retrieve existing session state if session exists
    if (sessionId && currentSessionId === sessionId) {
        existingStorageState = await getSessionState(sessionId);
        if (existingStorageState) {
            logger.info({ sessionId }, 'Using existing session state');
        }
    }

    try {
        // Create a new browser context (isolated session)
        const contextOptions = {
            viewport: { width: 1920, height: 1080 },
            userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
            ignoreHTTPSErrors: true, // Optional: ignore SSL errors
            javaScriptEnabled: true
        };

        // Add storage state if available
        if (existingStorageState) {
            contextOptions.storageState = existingStorageState;
        }

        context = await browser.newContext(contextOptions);

        // Create a new page
        page = await context.newPage();

        // Optional: Set extra HTTP headers
        await page.setExtraHTTPHeaders({
            'Accept-Language': 'en-US,en;q=0.9'
        });

        // Navigate to the URL with enhanced waiting strategies
        const response = await page.goto(url, {
            waitUntil: 'networkidle', // Wait until network is idle
            timeout: 30000 // 30 second timeout
        });

        // Optional: Wait for specific conditions based on common patterns
        try {
            // Wait for common SPA indicators (customize based on your needs)
            await Promise.race([
                page.waitForLoadState('domcontentloaded'),
                page.waitForTimeout(3000) // Max 3 seconds extra wait
            ]);
        } catch (waitError) {
            // Continue even if extra wait fails
            logger.debug('Extra wait completed or timed out');
        }

        // Get the rendered HTML content
        const htmlContent = await page.content();
        const pageResponseCode = response.status();

        // Summary into logs
        logger.info({
            url,
            statusCode: pageResponseCode,
            contentLength: htmlContent.length
        }, 'Successfully fetched URL content');

        // Store session state for future use
        const stateStored = await storeSessionState(currentSessionId, context);

        // Return success response
        res.json({
            statusCode: pageResponseCode,
            content: htmlContent,
            sessionId: currentSessionId,
            stateStored: stateStored
        });

    } catch (error) {
        logger.error({
            error: error.message,
            stack: error.stack,
            url
        }, 'Error fetching content');

        // Determine appropriate status code
        let statusCode = 500;
        if (error.message.includes('timeout')) {
            statusCode = 504; // Gateway timeout
        } else if (error.message.includes('net::')) {
            statusCode = 502; // Bad gateway
        }

        // Return error response
        res.status(statusCode).json({
            error: error.message
        });

    } finally {
        // Clean up resources
        if (page) {
            try {
                await page.close();
            } catch (closeError) {
                logger.error({ error: closeError.message }, 'Error closing page');
            }
        }
        if (context) {
            try {
                await context.close();
            } catch (closeError) {
                logger.error({ error: closeError.message }, 'Error closing context');
            }
        }
    }
});

// Health check endpoint
app.get('/health', async (req, res) => {
    const isConnected = browser && browser.isConnected();
    const valkeyConnected = valkeyClient !== null && valkeyClient !== undefined;

    const isHealthy = isConnected && (!STATE_STORAGE_ENABLED || valkeyConnected);

    res.status(isHealthy ? 200 : 503).json({
        status: isHealthy ? 'healthy' : 'unhealthy',
        browserConnected: isConnected,
        valkeyConnected: valkeyConnected,
        valkeyEnabled: STATE_STORAGE_ENABLED,
        uptime: process.uptime()
    });
});

// Metrics endpoint
app.get('/metrics', async (req, res) => {
    if (!browser || !browser.isConnected()) {
        return res.status(503).json({ error: 'Browser not connected' });
    }

    const contexts = browser.contexts();

    res.json({
        browserConnected: true,
        activeContexts: contexts.length,
        memoryUsage: process.memoryUsage(),
        uptime: process.uptime()
    });
});

// Graceful shutdown
const gracefulShutdown = async (signal) => {
    logger.info({ signal }, 'Graceful shutdown initiated');

    if (browser) {
        await browser.close().catch(err =>
            logger.error({ error: err.message }, 'Error closing browser')
        );
    }

    if (valkeyClient) {
        await valkeyClient.close().catch(err =>
            logger.error({ error: err.message }, 'Error closing Valkey client')
        );
    }

    process.exit(0);
};

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));

// Handle uncaught exceptions
process.on('uncaughtException', (error) => {
    logger.fatal({ error: error.message, stack: error.stack }, 'Uncaught Exception');
    gracefulShutdown('uncaughtException');
});

process.on('unhandledRejection', (reason, promise) => {
    logger.error({ reason, promise: promise.toString() }, 'Unhandled Rejection');
});

// Start server
async function start() {
    await initBrowser();
    await connectToValkey();

    app.listen(PORT, () => {
        logger.info({ port: PORT }, 'Server started successfully');
        logger.info('Available endpoints:');
        logger.info('  POST /content - Fetch and render URL content');
        logger.info('  GET /health - Health check endpoint');
        logger.info('  GET /metrics - Server metrics');
    });
}

start().catch(error => {
    logger.fatal({ error: error.message, stack: error.stack }, 'Failed to start application');
    process.exit(1);
});