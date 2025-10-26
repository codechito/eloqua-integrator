const { logger } = require('../utils');

/**
 * Global error handler middleware
 */
function errorHandler(err, req, res, next) {
    // Log error
    logger.error('Error occurred', {
        error: err.message,
        stack: err.stack,
        path: req.path,
        method: req.method,
        ip: req.ip,
        body: req.body,
        query: req.query
    });

    // Mongoose validation error
    if (err.name === 'ValidationError') {
        const errors = Object.values(err.errors).map(e => ({
            field: e.path,
            message: e.message
        }));

        return res.status(400).json({
            error: 'Validation Error',
            message: 'Invalid input data',
            details: errors
        });
    }

    // Mongoose duplicate key error
    if (err.code === 11000) {
        const field = Object.keys(err.keyPattern)[0];
        return res.status(400).json({
            error: 'Duplicate Entry',
            message: `A record with this ${field} already exists`
        });
    }

    // Mongoose cast error (invalid ObjectId)
    if (err.name === 'CastError') {
        return res.status(400).json({
            error: 'Invalid ID',
            message: `Invalid ${err.path}: ${err.value}`
        });
    }

    // JWT errors
    if (err.name === 'JsonWebTokenError') {
        return res.status(401).json({
            error: 'Invalid Token',
            message: 'Authentication token is invalid'
        });
    }

    if (err.name === 'TokenExpiredError') {
        return res.status(401).json({
            error: 'Token Expired',
            message: 'Authentication token has expired'
        });
    }

    // Axios/API errors
    if (err.isAxiosError) {
        const statusCode = err.response?.status || 500;
        const message = err.response?.data?.message || err.message;

        return res.status(statusCode).json({
            error: 'API Error',
            message: message,
            ...(process.env.NODE_ENV === 'development' && {
                details: err.response?.data
            })
        });
    }

    // Default error
    const statusCode = err.statusCode || err.status || 500;
    const message = err.message || 'Internal Server Error';

    res.status(statusCode).json({
        error: statusCode === 500 ? 'Internal Server Error' : 'Error',
        message: message,
        timestamp: new Date().toISOString(),
        ...(process.env.NODE_ENV === 'development' && {
            stack: err.stack
        })
    });
}

/**
 * Not found handler (404)
 */
function notFoundHandler(req, res, next) {
    logger.warn('Route not found', {
        path: req.path,
        method: req.method,
        ip: req.ip
    });

    res.status(404).json({
        error: 'Not Found',
        message: `Cannot ${req.method} ${req.url}`,
        timestamp: new Date().toISOString()
    });
}

/**
 * Async handler wrapper
 * Wraps async route handlers to catch errors
 */
function asyncHandler(fn) {
    return (req, res, next) => {
        Promise.resolve(fn(req, res, next)).catch(next);
    };
}

/**
 * Validation error formatter
 */
function formatValidationErrors(errors) {
    return errors.map(error => ({
        field: error.param,
        message: error.msg,
        value: error.value
    }));
}

module.exports = {
    errorHandler,
    notFoundHandler,
    asyncHandler,
    formatValidationErrors
};