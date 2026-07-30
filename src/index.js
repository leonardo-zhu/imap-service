require('dotenv').config();
const { listenForNewEmails } = require('./imapClient');
const { listenForGmailAccounts } = require('./gmailClient');
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

let imapAccounts = [];
let gmailAccounts = [];

// Parse IMAP accounts
if (process.env.IMAP_ACCOUNTS) {
    try {
        imapAccounts = JSON.parse(process.env.IMAP_ACCOUNTS);
        if (!Array.isArray(imapAccounts)) {
            throw new Error('IMAP_ACCOUNTS must be a JSON array.');
        }
    } catch (err) {
        logger.error(`CRITICAL ERROR: Failed to parse IMAP_ACCOUNTS: ${err.message}`);
        process.exit(1);
    }
} else if (process.env.IMAP_USER && process.env.IMAP_PASS) {
    imapAccounts = [{
        host: process.env.IMAP_HOST || 'imap.qq.com',
        port: parseInt(process.env.IMAP_PORT || '993', 10),
        user: process.env.IMAP_USER,
        pass: process.env.IMAP_PASS,
        label: 'default',
    }];
}

// Parse Gmail accounts
if (process.env.GMAIL_ACCOUNTS) {
    try {
        gmailAccounts = JSON.parse(process.env.GMAIL_ACCOUNTS);
        if (!Array.isArray(gmailAccounts)) {
            throw new Error('GMAIL_ACCOUNTS must be a JSON array.');
        }
    } catch (err) {
        logger.error(`CRITICAL ERROR: Failed to parse GMAIL_ACCOUNTS: ${err.message}`);
        process.exit(1);
    }
}

if (imapAccounts.length === 0 && gmailAccounts.length === 0) {
    logger.error('CRITICAL ERROR: No email accounts configured.');
    logger.info('Configure IMAP_ACCOUNTS, GMAIL_ACCOUNTS, or IMAP_USER + IMAP_PASS.');
    process.exit(1);
}

// Start IMAP accounts
if (imapAccounts.length > 0) {
    logger.info(`Starting IMAP Push Service with ${imapAccounts.length} account(s)...`, '', '🚀');
    imapAccounts.forEach(account => {
        logger.info(`${account.host}:${account.port}`, account.label ?? account.user, ' ·');
        listenForNewEmails(account);
    });
}

// Start Gmail accounts
if (gmailAccounts.length > 0) {
    logger.info(`Starting Gmail Pub/Sub Service with ${gmailAccounts.length} account(s)...`, '', '📧');
    gmailAccounts.forEach(account => {
        logger.info(`Gmail: ${account.user}`, account.label ?? account.user, ' ·');
    });
    listenForGmailAccounts(gmailAccounts);
}

createServer();
