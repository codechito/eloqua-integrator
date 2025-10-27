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
    sanitizeInput
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
    crossOriginOpenerPolicy: false
}));

// Request logging
app.use(requestLogger);

// Morgan for HTTP logging in development
if (process.env.NODE_ENV === 'development') {
    app.use(morgan('dev'));
}

// Body parsing middleware
app.use(bodyParser.json({ limit: '10mb' }));
app.use(bodyParser.urlencoded({ extended: true, limit: '10mb' }));

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
        endpoints: {
            health: '/health',
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
app.get('/health', (req, res) => {
    const mongoose = require('mongoose');
    res.json({
        status: 'OK',
        uptime: process.uptime(),
        timestamp: new Date().toISOString(),
        database: mongoose.connection.readyState === 1 ? 'connected' : 'disconnected',
        environment: process.env.NODE_ENV || 'development',
        memory: {
            used: Math.round(process.memoryUsage().heapUsed / 1024 / 1024) + ' MB',
            total: Math.round(process.memoryUsage().heapTotal / 1024 / 1024) + ' MB'
        }
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

// Error handler
app.use(errorHandler);

// Start server
const server = app.listen(PORT, () => {
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
    console.log('========================================');
});

// Graceful shutdown
process.on('SIGTERM', () => {
    logger.info('SIGTERM received, shutting down gracefully');
    server.close(() => {
        logger.info('Server closed');
        const mongoose = require('mongoose');
        mongoose.connection.close(false, () => {
            logger.info('MongoDB connection closed');
            process.exit(0);
        });
    });
});

process.on('SIGINT', () => {
    logger.info('SIGINT received, shutting down gracefully');
    server.close(() => {
        logger.info('Server closed');
        const mongoose = require('mongoose');
        mongoose.connection.close(false, () => {
            logger.info('MongoDB connection closed');
            process.exit(0);
        });
    });
});

// Handle uncaught exceptions
process.on('uncaughtException', (error) => {
    logger.error('Uncaught Exception', { error: error.message, stack: error.stack });
    process.exit(1);
});

// Handle unhandled promise rejections
process.on('unhandledRejection', (reason, promise) => {
    logger.error('Unhandled Rejection', { reason, promise });
});

module.exports = app;