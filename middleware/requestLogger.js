const { logger } = require('../utils');

/**
 * Request logging middleware
 */
function requestLogger(req, res, next) {
    const startTime = Date.now();

    // Log request
    logger.info('Incoming request', {
        method: req.method,
        path: req.path,
        ip: req.ip,
        userAgent: req.get('user-agent'),
        query: req.query
    });

    // Log response
    res.on('finish', () => {
        const duration = Date.now() - startTime;
        
        const logLevel = res.statusCode >= 400 ? 'warn' : 'info';
        
        logger[logLevel]('Request completed', {
            method: req.method,
            path: req.path,
            statusCode: res.statusCode,
            duration: `${duration}ms`,
            ip: req.ip
        });
    });

    next();
}

module.exports = requestLogger;