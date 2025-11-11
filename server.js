require('dotenv').config();
const express = require('express');
const bodyParser = require('body-parser');
const cookieParser = require('cookie-parser');
const session = require('express-session');
const cors = require('cors');
const helmet = require('helmet');
const morgan = require('morgan');
const path = require('path');

// Import database connection
const connectDB = require('./config/database');

// Import middleware
const { 
    errorHandler, 
    notFoundHandler,
    requestLogger,
    rateLimit,
    sanitizeInput,
    handleReauth
} = require('./middleware');

// Import routes
const { 
    appRoutes,
    actionRoutes,
    decisionRoutes,
    feederRoutes,
    webhookRoutes
} = require('./routes');

// Import logger
const { logger } = require('./utils');

// Import SMS Worker
const SmsWorker = require('./workers/smsWorker');
const DecisionCleanupWorker = require('./workers/decisionCleanupWorker');

// Initialize Express app
const app = express();

// Configuration
const PORT = process.env.PORT || 3000;

// Connect to Database
connectDB();

// CORS Configuration - MUST BE BEFORE HELMET
const corsOptions = {
    origin: '*', // Allow all origins (Eloqua needs this)
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With'],
    optionsSuccessStatus: 200
};

app.use(cors(corsOptions));

// Handle preflight requests for all routes
app.use((req, res, next) => {
    if (req.method === 'OPTIONS') {
        res.setHeader('Access-Control-Allow-Origin', '*');
        res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
        res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Requested-With');
        res.setHeader('Access-Control-Max-Age', '86400'); // 24 hours
        return res.status(200).end();
    }
    next();
});

// Security Middleware with relaxed policies for Eloqua
app.use(helmet({
    contentSecurityPolicy: false,
    crossOriginEmbedderPolicy: false,
    crossOriginResourcePolicy: { policy: "cross-origin" },
    crossOriginOpenerPolicy: false,
    frameguard: false
}));

// Request logging
app.use(requestLogger);

// Morgan for HTTP logging in development
if (process.env.NODE_ENV === 'development') {
    app.use(morgan('dev'));
}

// ADD: Raw body capture for notify endpoints (BEFORE body-parser)
app.use((req, res, next) => {
    if (req.path.includes('/notify')) {
        let rawData = '';
        
        req.on('data', chunk => {
            rawData += chunk.toString('utf8');
        });
        
        req.on('end', () => {
            req.rawBody = rawData;
            
            logger.debug('Raw body captured', {
                path: req.path,
                method: req.method,
                contentType: req.headers['content-type'],
                contentLength: req.headers['content-length'],
                rawBodyLength: rawData.length,
                rawBodyPreview: rawData.substring(0, 500),
                rawBodyFull: rawData.length < 2000 ? rawData : rawData.substring(0, 2000) + '... (truncated)'
            });
        });
    }
    next();
});

// Body parsing middleware
app.use(bodyParser.json({ 
    limit: '10mb',
    verify: (req, res, buf, encoding) => {
        if (req.path.includes('/notify')) {
            logger.debug('Body parser JSON verify', {
                path: req.path,
                bufferLength: buf.length,
                bufferPreview: buf.toString('utf8').substring(0, 500),
                encoding
            });
        }
    }
}));

app.use(bodyParser.urlencoded({ 
    extended: true, 
    limit: '10mb'
}));

// ADD: Log parsed body for notify endpoints (AFTER body-parser)
app.use((req, res, next) => {
    if (req.path.includes('/notify')) {
        logger.debug('Body after parsing', {
            path: req.path,
            method: req.method,
            hasBody: !!req.body,
            bodyType: typeof req.body,
            bodyConstructor: req.body?.constructor?.name,
            bodyIsArray: Array.isArray(req.body),
            bodyIsObject: typeof req.body === 'object' && req.body !== null,
            bodyKeys: req.body ? Object.keys(req.body) : [],
            bodyKeysCount: req.body ? Object.keys(req.body).length : 0,
            bodyStringified: JSON.stringify(req.body).substring(0, 1000),
            hasItems: req.body && 'items' in req.body,
            itemsType: req.body?.items ? typeof req.body.items : 'undefined',
            itemsIsArray: Array.isArray(req.body?.items),
            itemsLength: req.body?.items?.length
        });
    }
    next();
});

// Cookie parser
app.use(cookieParser());

// Input sanitization
app.use(sanitizeInput);

// Session configuration
app.use(session({
    secret: process.env.SESSION_SECRET || 'eloqua-secret',
    resave: false,
    saveUninitialized: true,
    cookie: { 
        secure: process.env.NODE_ENV === 'production',
        maxAge: 24 * 60 * 60 * 1000,
        httpOnly: true,
        sameSite: process.env.NODE_ENV === 'production' ? 'none' : 'lax'
    }
}));

// Rate limiting
app.use(rateLimit(100, 60000));

// View engine setup
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

// Static files middleware with proper headers
app.use('/eloqua-service/assets', (req, res, next) => {
    // Set CORS headers for static files
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
    
    // Set appropriate content types
    const ext = path.extname(req.url).toLowerCase();
    const contentTypes = {
        '.png': 'image/png',
        '.jpg': 'image/jpeg',
        '.jpeg': 'image/jpeg',
        '.gif': 'image/gif',
        '.svg': 'image/svg+xml',
        '.css': 'text/css',
        '.js': 'application/javascript',
        '.json': 'application/json'
    };
    
    if (contentTypes[ext]) {
        res.setHeader('Content-Type', contentTypes[ext]);
    }
    
    next();
}, express.static(path.join(__dirname, 'public/assets'), {
    maxAge: '1d',
    etag: true
}));

// Basic routes
app.get('/', (req, res) => {
    res.json({
        message: 'Eloqua TransmitSMS Integration API',
        version: '1.0.0',
        status: 'running',
        timestamp: new Date().toISOString(),
        environment: process.env.NODE_ENV || 'development',
        worker: {
            enabled: true,
            mode: 'in-process-scheduled'
        },
        endpoints: {
            health: '/health',
            workerHealth: '/eloqua/action/worker/health',
            app: {
                install: 'GET /eloqua/app/install',
                configure: 'GET /eloqua/app/configure',
                status: 'GET /eloqua/app/status',
                authorize: 'GET /eloqua/app/authorize'
            },
            action: {
                create: 'GET /eloqua/action/create',
                configure: 'GET /eloqua/action/configure',
                notify: 'POST /eloqua/action/notify'
            },
            decision: {
                create: 'GET /eloqua/decision/create',
                configure: 'GET /eloqua/decision/configure',
                notify: 'POST /eloqua/decision/notify'
            },
            feeder: {
                create: 'GET /eloqua/feeder/create',
                configure: 'GET /eloqua/feeder/configure',
                notify: 'POST /eloqua/feeder/notify'
            },
            webhooks: {
                dlr: 'POST /webhooks/dlr',
                reply: 'POST /webhooks/reply',
                linkHit: 'POST /webhooks/linkhit'
            }
        }
    });
});

// Health check endpoint
app.get('/health', async (req, res) => {
    const mongoose = require('mongoose');
    
    // Get worker stats if available
    let workerStats = null;
    if (global.smsWorker) {
        try {
            workerStats = await global.smsWorker.getStats();
        } catch (error) {
            logger.error('Error getting worker stats', { error: error.message });
        }
    }
    
    res.json({
        status: 'OK',
        uptime: process.uptime(),
        timestamp: new Date().toISOString(),
        database: mongoose.connection.readyState === 1 ? 'connected' : 'disconnected',
        environment: process.env.NODE_ENV || 'development',
        memory: {
            used: Math.round(process.memoryUsage().heapUsed / 1024 / 1024) + ' MB',
            total: Math.round(process.memoryUsage().heapTotal / 1024 / 1024) + ' MB',
            percentage: Math.round((process.memoryUsage().heapUsed / process.memoryUsage().heapTotal) * 100) + '%'
        },
        worker: workerStats || { status: 'not started' }
    });
});

// Mount routes
app.use('/eloqua/app', appRoutes);
app.use('/eloqua/action', actionRoutes);
app.use('/eloqua/decision', decisionRoutes);
app.use('/eloqua/feeder', feederRoutes);
app.use('/webhooks', webhookRoutes);

// 404 handler
app.use(notFoundHandler);

// Reauth handler
app.use(handleReauth);

// Error handler
app.use(errorHandler);

// Initialize worker after routes are set up
let smsWorker = null;
let decisionCleanupWorker = null;

async function initializeWorker() {
    try {
        logger.info('Initializing SMS Worker...');
        
        // Create worker instance
        smsWorker = new SmsWorker();
        
        // Store globally for health checks
        global.smsWorker = smsWorker;
        
        // Start the worker
        smsWorker.start();
        
        logger.info('SMS Worker started successfully', {
            mode: 'in-process-scheduled',
            schedule: 'Every 30 seconds'
        });

        // ADD DECISION CLEANUP WORKER
        logger.info('Initializing Decision Cleanup Worker...');
        
        decisionCleanupWorker = new DecisionCleanupWorker();
        global.decisionCleanupWorker = decisionCleanupWorker;
        
        decisionCleanupWorker.start();

        logger.info('Decision Cleanup Worker started successfully', {
            mode: 'in-process-scheduled',
            schedule: 'Every 10 minutes'
        });
        
        // Log worker stats periodically (every 5 minutes)
        setInterval(async () => {
            try {
                const stats = await smsWorker.getStats();
                logger.info('SMS Worker Stats', stats);
            } catch (error) {
                logger.error('Error getting worker stats', { error: error.message });
            }
        }, 5 * 60 * 1000); // Every 5 minutes
        
    } catch (error) {
        logger.error('Failed to initialize workers', {
            error: error.message,
            stack: error.stack
        });
        // Don't crash the server if worker fails to start
        // The web server can still run without the worker
    }
}

// Start server
const server = app.listen(PORT,'0.0.0.0', async () => {
    logger.info('Server started', {
        port: PORT,
        environment: process.env.NODE_ENV || 'development',
        nodeVersion: process.version
    });

    console.log('========================================');
    console.log('  Eloqua TransmitSMS Integration');
    console.log('========================================');
    console.log(`  ✓ Server running on port ${PORT}`);
    console.log(`  ✓ Environment: ${process.env.NODE_ENV || 'development'}`);
    console.log(`  ✓ URL: http://localhost:${PORT}`);
    console.log(`  ✓ Health: http://localhost:${PORT}/health`);
    console.log(`  ✓ Worker Health: http://localhost:${PORT}/eloqua/action/worker/health`);
    console.log('========================================');
    
    // Initialize worker after server starts
    await initializeWorker();
    
    console.log('========================================');
    console.log('  ✓ SMS Worker: Active (Scheduled)');
    console.log('  ✓ Schedule: Every 30 seconds');
    console.log('  ✓ Decision Cleanup Worker: Active');
    console.log('  ✓ Schedule: Every 10 minutes');
    console.log('========================================');
});

// Graceful shutdown
async function gracefulShutdown(signal) {
    logger.info(`${signal} received, shutting down gracefully`);
    
    console.log('========================================');
    console.log(`  Shutting down (${signal})...`);
    console.log('========================================');
    
    // Stop accepting new requests
    server.close(() => {
        logger.info('HTTP server closed');
        console.log('  ✓ HTTP server closed');
    });
    
    // Stop the SMS worker
    if (smsWorker) {
        try {
            smsWorker.stop();
            logger.info('SMS Worker stopped');
            console.log('  ✓ SMS Worker stopped');
        } catch (error) {
            logger.error('Error stopping SMS Worker', { error: error.message });
        }
    }
    
    // Stop decision cleanup worker
    if (decisionCleanupWorker) {
        try {
            decisionCleanupWorker.stop();
            logger.info('Decision Cleanup Worker stopped');
            console.log('  ✓ Decision Cleanup Worker stopped');
        } catch (error) {
            logger.error('Error stopping Decision Cleanup Worker', { error: error.message });
        }
    }
    
    // Wait for current jobs to complete (max 10 seconds)
    console.log('  ⏳ Waiting for current jobs to complete...');
    await new Promise(resolve => setTimeout(resolve, 10000));
    
    // Close MongoDB connection
    const mongoose = require('mongoose');
    try {
        await mongoose.connection.close(false);
        logger.info('MongoDB connection closed');
        console.log('  ✓ MongoDB connection closed');
    } catch (error) {
        logger.error('Error closing MongoDB', { error: error.message });
    }
    
    console.log('========================================');
    console.log('  ✓ Shutdown complete');
    console.log('========================================');
    
    process.exit(0);
}

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));

// Handle uncaught exceptions
process.on('uncaughtException', (error) => {
    logger.error('Uncaught Exception', { 
        error: error.message, 
        stack: error.stack 
    });
    
    console.error('========================================');
    console.error('  ✗ UNCAUGHT EXCEPTION');
    console.error('========================================');
    console.error(error);
    console.error('========================================');
    
    // Try to shutdown gracefully
    gracefulShutdown('UNCAUGHT_EXCEPTION');
});

// Handle unhandled promise rejections
process.on('unhandledRejection', (reason, promise) => {
    logger.error('Unhandled Rejection', { reason, promise });
    
    console.error('========================================');
    console.error('  ✗ UNHANDLED REJECTION');
    console.error('========================================');
    console.error('Reason:', reason);
    console.error('Promise:', promise);
    console.error('========================================');
});

// Log memory usage warnings
setInterval(() => {
    const usage = process.memoryUsage();
    const heapUsedMB = Math.round(usage.heapUsed / 1024 / 1024);
    const heapTotalMB = Math.round(usage.heapTotal / 1024 / 1024);
    const percentage = Math.round((usage.heapUsed / usage.heapTotal) * 100);
    
    if (percentage > 90) {
        logger.warn('High memory usage detected', {
            heapUsed: heapUsedMB + ' MB',
            heapTotal: heapTotalMB + ' MB',
            percentage: percentage + '%'
        });
        
        // Force garbage collection if available
        if (global.gc) {
            logger.info('Running garbage collection');
            global.gc();
        }
    }
}, 60000); // Check every minute

module.exports = app;