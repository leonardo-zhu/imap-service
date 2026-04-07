const http = require('http');
const { markAsRead } = require('./imapClient');
const logger = require('./logger');

const PORT = parseInt(process.env.HTTP_PORT || '2525', 10);
const TOKEN = process.env.OPENCLAW_HOOKS_TOKEN;

/**
 * Minimal HTTP server exposing internal control endpoints.
 */
const createServer = () => {
    const server = http.createServer(async (req, res) => {
        // Auth check
        const auth = req.headers['authorization'] ?? '';
        if (auth !== `Bearer ${TOKEN}`) {
            logger.error('Unauthorized access attempt');
            res.writeHead(401, { 'Content-Type': 'application/json' });
            return res.end(JSON.stringify({ error: 'Unauthorized' }));
        }

        // POST /mail/mark-read
        if (req.method === 'POST' && req.url === '/mail/mark-read') {
            let body = '';
            req.on('data', chunk => { body += chunk; });
            req.on('end', async () => {
                try {
                    const { uid, account } = JSON.parse(body);

                    if (!uid || !account) {
                        res.writeHead(400, { 'Content-Type': 'application/json' });
                        return res.end(JSON.stringify({ error: '`uid` and `account` are required.' }));
                    }

                    await markAsRead(account, uid);
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
        logger.info(`Mail minimal HTTP server listening on port ${PORT}`, '', '🌐');
    });

    return server;
};

module.exports = { createServer };

