const { ImapFlow } = require('imapflow');
const simpleParser = require('mailparser').simpleParser;

// Registry of active IMAP clients keyed by account label.
// Used by the HTTP server to look up a connection for mark-as-read operations.
const clientRegistry = new Map();

const createImapClient = (account) => {
    return new ImapFlow({
        host: account.host,
        port: account.port,
        secure: true,
        auth: {
            user: account.user,
            pass: account.pass,
        },
        logger: false,
        clientInfo: { name: 'OpenClaw IMAP sync' },
    });
};

const pushToOpenClaw = async (emailData) => {
    try {
        console.log(`🚀 [${emailData.account}] Pushing email [${emailData.subject}] to OpenClaw...`);
        const response = await fetch(`${process.env.OPENCLAW_WEBHOOK_URL}/mail`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${process.env.OPENCLAW_HOOKS_TOKEN}`,
            },
            body: JSON.stringify(emailData),
        });

        if (!response.ok) {
            console.error(`❌ [${emailData.account}] Webhook push failed with status: ${response.status}`);
        } else {
            console.log(`✅ [${emailData.account}] Webhook pushed successfully.`);
        }
    } catch (err) {
        console.error(`❌ [${emailData.account}] Error pushing to webhook:`, err.message);
    }
};

/**
 * Mark a message as read (\Seen) by its UID on a given account.
 * @param {string} label - The account label.
 * @param {number} uid - The message UID.
 */
const markAsRead = async (label, uid) => {
    const client = clientRegistry.get(label);
    if (!client) {
        throw new Error(`No active IMAP connection found for account: ${label}`);
    }
    // messageFlagsAdd handles exiting IDLE, applying the flag, and re-entering IDLE automatically.
    await client.messageFlagsAdd({ uid }, ['\\Seen'], { uid: true });
    console.log(`📖 [${label}] Marked message UID ${uid} as read.`);
};

const listenForNewEmails = async (account) => {
    const label = account.label ?? account.user;
    const client = createImapClient(account);

    client.on('error', err => {
        console.error(`IMAP Error [${label}]:`, err);
    });

    client.on('close', () => {
        clientRegistry.delete(label);
        console.log(`IMAP connection closed [${label}]. Reconnecting in 5 seconds...`);
        setTimeout(() => listenForNewEmails(account), 5000);
    });

    try {
        await client.connect();
        await client.getMailboxLock('INBOX');

        // Register the connected client so markAsRead can reach it.
        clientRegistry.set(label, client);
        console.log(`📬 [${label}] Connected and listening for new emails...`);

        client.on('exists', async data => {
            const { prevCount, count } = data;
            if (count > prevCount) {
                console.log(`🔔 [${label}] New email arrived! (${count - prevCount} new)`);

                try {
                    for await (let message of client.fetch({ seq: `${prevCount + 1}:${count}` }, { source: true })) {
                        if (message.source) {
                            const parsed = await simpleParser(message.source);
                            const emailData = {
                                account: label,
                                uid: message.uid,
                                seq: message.seq,
                                subject: parsed.subject,
                                from: parsed.from?.text,
                                date: parsed.date,
                                text: parsed.text,
                            };
                            await pushToOpenClaw(emailData);
                        }
                    }
                } catch (err) {
                    console.error(`Error fetching new messages [${label}]:`, err);
                }
            }
        });
    } catch (err) {
        console.error(`Failed to connect [${label}]:`, err.message);
        setTimeout(() => listenForNewEmails(account), 5000);
    }
};

module.exports = { listenForNewEmails, markAsRead };
