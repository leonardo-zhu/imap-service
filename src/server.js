const http = require('http');
const url = require('url');
const { markAsRead } = require('./imapClient');
const { handlePubSubPush, markGmailAsRead, isGmailAccount } = require('./gmailClient');
const logger = require('./logger');

const PORT = parseInt(process.env.HTTP_PORT || '2525', 10);
const TOKEN = process.env.OPENCLAW_HOOKS_TOKEN;
const PUBSUB_TOKEN = process.env.PUBSUB_PUSH_TOKEN;

/**
 * Minimal HTTP server exposing internal control endpoints and Pub/Sub push webhooks.
 */
const createServer = () => {
    const server = http.createServer(async (req, res) => {
        const parsedUrl = url.parse(req.url, true);
        const pathname = parsedUrl.pathname;

        // POST /gmail/pubsub - Endpoint for GCP Pub/Sub push webhooks
        if (req.method === 'POST' && pathname === '/gmail/pubsub') {
            // Verify security token if configured
            if (PUBSUB_TOKEN) {
                const queryToken = parsedUrl.query.token;
                const authHeader = req.headers['authorization'] ?? '';
                if (queryToken !== PUBSUB_TOKEN && authHeader !== `Bearer ${PUBSUB_TOKEN}`) {
                    logger.error('Unauthorized Pub/Sub push attempt');
                    res.writeHead(401, { 'Content-Type': 'application/json' });
                    return res.end(JSON.stringify({ error: 'Unauthorized Pub/Sub request' }));
                }
            }

            let body = '';
            req.on('data', chunk => { body += chunk; });
            req.on('end', async () => {
                try {
                    const payload = JSON.parse(body);
                    // Acknowledge GCP Pub/Sub immediately with 200 OK
                    res.writeHead(200, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ ok: true }));

                    // Asynchronously handle event processing
                    handlePubSubPush(payload).catch(err => {
                        logger.error(`Error processing Pub/Sub push: ${err.message}`);
                    });
                } catch (err) {
                    logger.error(`Invalid JSON in Pub/Sub push body: ${err.message}`);
                    res.writeHead(400, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ error: 'Invalid JSON payload' }));
                }
            });
            return;
        }

        // Auth check for internal control endpoints
        const auth = req.headers['authorization'] ?? '';
        if (auth !== `Bearer ${TOKEN}`) {
            logger.error('Unauthorized access attempt to internal endpoint');
            res.writeHead(401, { 'Content-Type': 'application/json' });
            return res.end(JSON.stringify({ error: 'Unauthorized' }));
        }

        // POST /mail/mark-read
        if (req.method === 'POST' && pathname === '/mail/mark-read') {
            let body = '';
            req.on('data', chunk => { body += chunk; });
            req.on('end', async () => {
                try {
                    const { uid, account } = JSON.parse(body);

                    if (!uid || !account) {
                        res.writeHead(400, { 'Content-Type': 'application/json' });
                        return res.end(JSON.stringify({ error: '`uid` and `account` are required.' }));
                    }

                    if (isGmailAccount(account)) {
                        await markGmailAsRead(account, uid);
                    } else {
                        await markAsRead(account, uid);
                    }

                    res.writeHead(200, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ ok: true, uid, account }));
                } catch (err) {
                    logger.error(`mark-as-read failed: ${err.message}`);
                    res.writeHead(500, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ error: err.message }));
                }
            });
            return;
        }

        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Not found' }));
    });

    server.listen(PORT, () => {
        logger.info(`Mail HTTP server listening on port ${PORT} (Endpoints: POST /mail/mark-read, POST /gmail/pubsub)`, '', '🌐');
    });

    return server;
};

module.exports = { createServer };
