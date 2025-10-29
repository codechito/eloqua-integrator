const { logger } = require('../utils');

/**
 * Middleware to handle re-authorization required errors
 * This should be placed BEFORE the general error handler in server.js
 */
function handleReauth(err, req, res, next) {
    if (err && err.code === 'REAUTH_REQUIRED') {
        logger.warn('Re-authorization required', {
            path: req.path,
            method: req.method,
            installId: req.query.installId || req.params.installId || req.body?.installId,
            reAuthUrl: err.reAuthUrl
        });

        // If it's an AJAX request, return JSON with reauth URL
        if (req.xhr || req.headers.accept?.indexOf('json') > -1) {
            return res.status(401).json({
                error: 'Re-authorization required',
                message: 'Your Eloqua session has expired. Please re-authorize the application.',
                code: 'REAUTH_REQUIRED',
                reAuthUrl: err.reAuthUrl
            });
        }

        // For regular requests, show HTML page with auto-redirect
        return res.status(401).send(`
            <!DOCTYPE html>
            <html>
            <head>
                <meta charset="utf-8">
                <title>Re-authorization Required</title>
                <style>
                    body {
                        font-family: Arial, sans-serif;
                        display: flex;
                        justify-content: center;
                        align-items: center;
                        height: 100vh;
                        margin: 0;
                        background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
                    }
                    .container {
                        text-align: center;
                        background: white;
                        padding: 40px;
                        border-radius: 10px;
                        box-shadow: 0 10px 40px rgba(0,0,0,0.2);
                        max-width: 500px;
                    }
                    .icon {
                        font-size: 64px;
                        margin-bottom: 20px;
                    }
                    h2 {
                        color: #333;
                        margin-bottom: 10px;
                    }
                    p {
                        color: #666;
                        margin: 15px 0;
                        line-height: 1.6;
                    }
                    .btn {
                        display: inline-block;
                        margin-top: 20px;
                        padding: 12px 30px;
                        background: #4CAF50;
                        color: white;
                        text-decoration: none;
                        border-radius: 5px;
                        font-weight: bold;
                        transition: background 0.3s;
                    }
                    .btn:hover {
                        background: #45a049;
                    }
                    .countdown {
                        margin-top: 20px;
                        font-size: 14px;
                        color: #999;
                    }
                    @keyframes spin {
                        0% { transform: rotate(0deg); }
                        100% { transform: rotate(360deg); }
                    }
                    .spinner {
                        border: 3px solid #f3f3f3;
                        border-top: 3px solid #4CAF50;
                        border-radius: 50%;
                        width: 30px;
                        height: 30px;
                        animation: spin 1s linear infinite;
                        display: inline-block;
                        margin-bottom: 20px;
                    }
                </style>
            </head>
            <body>
                <div class="container">
                    <div class="icon">⚠️</div>
                    <h2>Re-authorization Required</h2>
                    <p>Your Eloqua session has expired. Please re-authorize the application to continue.</p>
                    <p style="font-size: 14px; color: #999;">
                        This happens when your Eloqua access token has expired and cannot be refreshed.
                    </p>
                    <a href="${err.reAuthUrl}" class="btn" id="reauth-btn">Re-authorize Now</a>
                    <div class="countdown">
                        Redirecting automatically in <span id="countdown">5</span> seconds...
                    </div>
                </div>
                <script>
                    var countdown = 5;
                    var countdownEl = document.getElementById('countdown');
                    
                    var interval = setInterval(function() {
                        countdown--;
                        if (countdownEl) {
                            countdownEl.textContent = countdown;
                        }
                        
                        if (countdown <= 0) {
                            clearInterval(interval);
                            // Show spinner
                            document.querySelector('.icon').innerHTML = '<div class="spinner"></div>';
                            document.querySelector('h2').textContent = 'Redirecting...';
                            // Redirect
                            window.location.href = '${err.reAuthUrl}';
                        }
                    }, 1000);
                    
                    // Also redirect on button click
                    document.getElementById('reauth-btn').addEventListener('click', function() {
                        clearInterval(interval);
                    });
                </script>
            </body>
            </html>
        `);
    }

    // Pass to next error handler if not reauth error
    next(err);
}

module.exports = handleReauth;