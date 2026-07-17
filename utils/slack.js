const axios = require('axios');

const SLACK_WEBHOOK_URL = process.env.SLACK_WEBHOOK_URL;

/**
 * Send a plain text message to Slack.
 * Silently skips if SLACK_WEBHOOK_URL is not set.
 */
async function slackNotify(text, fields = []) {
    if (!SLACK_WEBHOOK_URL) return;

    const payload = { text };

    if (fields.length > 0) {
        payload.attachments = [{
            color: fields._color || '#36a64f',
            fields: fields.map(f => ({
                title: f.title,
                value: f.value,
                short: true
            }))
        }];
    }

    try {
        await axios.post(SLACK_WEBHOOK_URL, payload, { timeout: 5000 });
    } catch (err) {
        console.warn('Slack notification failed:', err.message);
    }
}

module.exports = { slackNotify };
