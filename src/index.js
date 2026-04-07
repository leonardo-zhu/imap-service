require('dotenv').config();
const { listenForNewEmails } = require('./imapClient');
const { createServer } = require('./server');
const logger = require('./logger');

// Validate shared required env vars
const requiredEnv = ['OPENCLAW_WEBHOOK_URL', 'OPENCLAW_HOOKS_TOKEN'];
requiredEnv.forEach(key => {
    if (!process.env[key]) {
        logger.error(`CRITICAL ERROR: Environment variable "${key}" is missing.`);
        process.exit(1);
    }
});

let accounts = [];

if (process.env.IMAP_ACCOUNTS) {
    // Multi-account mode: parse JSON array from IMAP_ACCOUNTS
    try {
        accounts = JSON.parse(process.env.IMAP_ACCOUNTS);
        if (!Array.isArray(accounts) || accounts.length === 0) {
            throw new Error('IMAP_ACCOUNTS must be a non-empty JSON array.');
        }
    } catch (err) {
        logger.error(`CRITICAL ERROR: Failed to parse IMAP_ACCOUNTS: ${err.message}`);
        logger.info('Expected format: [{"host":"...","port":993,"user":"...","pass":"...","label":"..."}]');
        process.exit(1);
    }
} else if (process.env.IMAP_USER && process.env.IMAP_PASS) {
    // Single-account legacy mode: fall back to IMAP_USER / IMAP_PASS
    accounts = [{
        host: process.env.IMAP_HOST || 'imap.qq.com',
        port: parseInt(process.env.IMAP_PORT || '993', 10),
        user: process.env.IMAP_USER,
        pass: process.env.IMAP_PASS,
        label: 'default',
    }];
} else {
    logger.error('CRITICAL ERROR: No IMAP account configured.');
    logger.info('Set IMAP_ACCOUNTS (JSON array) or IMAP_USER + IMAP_PASS.');
    process.exit(1);
}

logger.info(`IMAP Push Service is starting with ${accounts.length} account(s)...`, '', '🚀');
accounts.forEach(account => {
    logger.info(`${account.host}:${account.port}`, account.label ?? account.user, ' ·');
    listenForNewEmails(account);
});

createServer();


