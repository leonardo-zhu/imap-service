const { google } = require('googleapis');
const logger = require('./logger');

// Registry of active Gmail clients and configurations keyed by account label and user email.
// Account entry: { label, user, clientId, clientSecret, refreshToken, topicName, auth, gmail, lastHistoryId }
const gmailRegistry = new Map();

/**
 * Get Gmail registry entry by account label or user email (case-insensitive).
 */
const getGmailReg = (accountKey) => {
    if (!accountKey) return null;
    if (gmailRegistry.has(accountKey)) return gmailRegistry.get(accountKey);
    const lowerKey = accountKey.toLowerCase();
    if (gmailRegistry.has(lowerKey)) return gmailRegistry.get(lowerKey);
    for (const entry of gmailRegistry.values()) {
        if (
            (entry.label && entry.label.toLowerCase() === lowerKey) ||
            (entry.user && entry.user.toLowerCase() === lowerKey)
        ) {
            return entry;
        }
    }
    return null;
};

/**
 * Extract case-insensitive header value from Gmail message payload headers.
 */
const getHeader = (headers = [], name) => {
    const found = headers.find(h => h.name.toLowerCase() === name.toLowerCase());
    return found ? found.value : '';
};

/**
 * Recursively extract plain text content from Gmail message payload parts.
 */
const extractTextBody = (part) => {
    if (!part) return '';
    if (part.mimeType === 'text/plain' && part.body && part.body.data) {
        return Buffer.from(part.body.data, 'base64url').toString('utf-8');
    }
    if (part.parts && part.parts.length > 0) {
        for (const subPart of part.parts) {
            const text = extractTextBody(subPart);
            if (text) return text;
        }
    }
    return '';
};

/**
 * Create OAuth2 client and Gmail API instance for an account config.
 */
const createGmailClient = (account) => {
    const oAuth2Client = new google.auth.OAuth2(
        account.clientId,
        account.clientSecret,
        account.redirectUri
    );
    oAuth2Client.setCredentials({ refresh_token: account.refreshToken });

    const gmail = google.gmail({ version: 'v1', auth: oAuth2Client });
    return { oAuth2Client, gmail };
};

/**
 * Register or renew Gmail watch() subscription on GCP Pub/Sub.
 */
const renewWatch = async (account) => {
    const label = account.label ?? account.user;
    const reg = getGmailReg(label);
    if (!reg) return;

    try {
        logger.info(`Registering Gmail watch() on topic [${account.topicName}]...`, label, '🔄');
        const res = await reg.gmail.users.watch({
            userId: 'me',
            requestBody: {
                topicName: account.topicName,
                labelIds: account.labelIds || ['INBOX'],
            },
        });

        reg.lastHistoryId = res.data.historyId;
        const expirationDate = new Date(parseInt(res.data.expiration, 10)).toLocaleString();
        logger.success(`Gmail watch() registered successfully. HistoryId: ${res.data.historyId}, Expires: ${expirationDate}`, label);
    } catch (err) {
        logger.error(`Failed to register Gmail watch(): ${err.message}`, label);
    }
};

/**
 * Initialize listening for all configured Gmail accounts.
 */
const listenForGmailAccounts = async (accounts = []) => {
    for (const account of accounts) {
        const label = account.label ?? account.user;
        logger.info(`Initializing Gmail account...`, label, '📧');

        const { oAuth2Client, gmail } = createGmailClient(account);
        const reg = {
            account,
            label,
            user: account.user,
            auth: oAuth2Client,
            gmail,
            lastHistoryId: null,
        };

        if (label) {
            gmailRegistry.set(label, reg);
            gmailRegistry.set(label.toLowerCase(), reg);
        }
        if (account.user) {
            gmailRegistry.set(account.user, reg);
            gmailRegistry.set(account.user.toLowerCase(), reg);
        }

        // Initial watch registration
        await renewWatch(account);

        // Schedule periodic watch renewal every 24 hours (Gmail watch expires max in 7 days)
        setInterval(() => renewWatch(account), 24 * 60 * 60 * 1000);
    }
};

/**
 * Process an incoming GCP Pub/Sub Push POST request.
 * Expected req.body format: { message: { data: "<base64_encoded_json>", messageId: "..." } }
 */
const handlePubSubPush = async (reqBody) => {
    if (!reqBody || !reqBody.message || !reqBody.message.data) {
        throw new Error('Invalid Pub/Sub payload structure: missing `message.data`.');
    }

    const decodedStr = Buffer.from(reqBody.message.data, 'base64').toString('utf-8');
    let pushData;
    try {
        pushData = JSON.parse(decodedStr);
    } catch (err) {
        throw new Error(`Failed to parse Pub/Sub base64 JSON payload: ${err.message}`);
    }

    const { emailAddress, historyId } = pushData;
    if (!emailAddress || !historyId) {
        logger.warn(`Pub/Sub push payload missing emailAddress or historyId.`);
        return;
    }

    // Match registered Gmail account by user email or fallback to first registered account
    let reg = null;
    for (const entry of gmailRegistry.values()) {
        if (entry.user && entry.user.toLowerCase() === emailAddress.toLowerCase()) {
            reg = entry;
            break;
        }
    }
    if (!reg && gmailRegistry.size > 0) {
        reg = gmailRegistry.values().next().value;
    }

    if (!reg) {
        logger.error(`No matching Gmail account found for emailAddress: ${emailAddress}`);
        return;
    }

    const label = reg.label;
    logger.info(`Received Pub/Sub notification for ${emailAddress} (HistoryID: ${historyId})`, label, '🔔');

    const startHistoryId = reg.lastHistoryId || historyId;
    reg.lastHistoryId = historyId;

    try {
        const historyRes = await reg.gmail.users.history.list({
            userId: 'me',
            startHistoryId: startHistoryId,
            historyTypes: ['messageAdded'],
        });

        const newMsgIds = new Set();
        if (historyRes.data.history) {
            for (const item of historyRes.data.history) {
                if (item.messagesAdded) {
                    for (const msgAdded of item.messagesAdded) {
                        if (msgAdded.message && msgAdded.message.id) {
                            if (!msgAdded.message.labelIds || msgAdded.message.labelIds.includes('INBOX')) {
                                newMsgIds.add(msgAdded.message.id);
                            }
                        }
                    }
                }
            }
        }

        if (newMsgIds.size === 0) {
            logger.info(`No new inbox messages found in history range.`, label);
            return;
        }

        logger.info(`Found ${newMsgIds.size} new message(s) to fetch...`, label, '📥');

        for (const msgId of newMsgIds) {
            const msgRes = await reg.gmail.users.messages.get({
                userId: 'me',
                id: msgId,
                format: 'full',
            });

            const msg = msgRes.data;
            const headers = msg.payload ? msg.payload.headers : [];

            const subject = getHeader(headers, 'subject') || '(No Subject)';
            const from = getHeader(headers, 'from') || '';
            const dateStr = getHeader(headers, 'date');
            const date = dateStr ? new Date(dateStr) : new Date(parseInt(msg.internalDate, 10));
            const text = extractTextBody(msg.payload) || msg.snippet || '';

            const emailData = {
                account: label,
                uid: msg.id,
                seq: msg.historyId,
                subject,
                from,
                date: date.toISOString(),
                text,
            };

            logger.info(`Pushing Gmail [${emailData.subject}] to OpenClaw...`, label, '🚀');

            const response = await fetch(`${process.env.OPENCLAW_WEBHOOK_URL}/mail`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${process.env.OPENCLAW_HOOKS_TOKEN}`,
                },
                body: JSON.stringify(emailData),
            });

            if (!response.ok) {
                try {
                    const errorJson = await response.json();
                    logger.error(`Webhook push failed (Status ${response.status}): ${errorJson.error}`, label);
                } catch (e) {
                    logger.error(`Webhook push failed (Status ${response.status})`, label);
                }
            } else {
                logger.success(`Webhook pushed successfully.`, label);
            }
        }
    } catch (err) {
        logger.error(`Failed to process Gmail history/messages: ${err.message}`, label);
    }
};

/**
 * Mark a Gmail message as read (remove UNREAD label) by message ID.
 */
const markGmailAsRead = async (accountKey, uid) => {
    const reg = getGmailReg(accountKey);
    if (!reg) {
        throw new Error(`No active Gmail account found for account: ${accountKey}`);
    }

    await reg.gmail.users.messages.modify({
        userId: 'me',
        id: uid,
        requestBody: {
            removeLabelIds: ['UNREAD'],
        },
    });

    logger.info(`Marked Gmail message ID ${uid} as read.`, reg.label, '📖');
};

/**
 * Check if an account label or user email belongs to a registered Gmail account.
 */
const isGmailAccount = (accountKey) => {
    return getGmailReg(accountKey) !== null;
};

module.exports = {
    listenForGmailAccounts,
    handlePubSubPush,
    markGmailAsRead,
    isGmailAccount,
};
