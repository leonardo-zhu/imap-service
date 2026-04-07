const { ImapFlow } = require('imapflow');
const simpleParser = require('mailparser').simpleParser;

const createImapClient = () => {
    return new ImapFlow({
        host: process.env.IMAP_HOST || 'imap.qq.com',
        port: parseInt(process.env.IMAP_PORT || '993', 10),
        secure: true,
        auth: {
            user: process.env.IMAP_USER,
            pass: process.env.IMAP_PASS
        },
        logger: false,
        // Optional: QQ Mail occasionally drops connections, so keepalive configuration is good
        clientInfo: { name: 'OpenClaw IMAP sync' }
    });
};

const pushToOpenClaw = async (emailData) => {
    try {
        console.log(`🚀 Pushing email [${emailData.subject}] to OpenClaw...`);
        const response = await fetch(`${process.env.OPENCLAW_WEBHOOK_URL}/mail`, {
            method: 'POST',
            headers: { 
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${process.env.OPENCLAW_HOOKS_TOKEN}`
            },
            body: JSON.stringify(emailData)
        });
        
        if (!response.ok) {
            console.error(`❌ Webhook pushed failed with status: ${response.status}`);
        } else {
            console.log(`✅ Webhook pushed successfully.`);
        }
    } catch (err) {
        console.error('❌ Error pushing to webhook:', err.message);
    }
};

const listenForNewEmails = async () => {
    const client = createImapClient();
    
    // Handle error events so the process doesn't crash entirely silently
    client.on('error', err => {
        console.error('IMAP Error:', err);
    });

    client.on('close', () => {
        console.log('IMAP Connection closed. Reconnecting in 5 seconds...');
        setTimeout(listenForNewEmails, 5000); // Simple auto-reconnect
    });

    try {
        await client.connect();
        // Keep the INBOX selected and listen for IDLE/events
        let lock = await client.getMailboxLock('INBOX');
        console.log('📬 Connected to IMAP and listening for new emails...');

        // The "exists" event triggers when new messages arrive
        client.on('exists', async data => {
            const { prevCount, count } = data;
            // new messages only
            if (count > prevCount) {
                console.log(`🔔 New email arrived! (${count - prevCount} new)`);
                
                try {
                    // Fetch using sequence numbers from prevCount+1 to new count
                    for await (let message of client.fetch({ seq: `${prevCount + 1}:${count}` }, { source: true })) {
                        if (message.source) {
                            const parsed = await simpleParser(message.source);
                            const emailData = {
                                uid: message.uid,
                                seq: message.seq,
                                subject: parsed.subject,
                                from: parsed.from?.text,
                                date: parsed.date,
                                text: parsed.text, 
                            };
                            
                            // Immediately push out to OpenClaw
                            await pushToOpenClaw(emailData);
                        }
                    }
                } catch (err) {
                    console.error('Error fetching new messages during IDLE:', err);
                }
            }
        });

    } catch (err) {
        console.error('Failed to start listening to IMAP:', err.message);
        setTimeout(listenForNewEmails, 5000); 
    }
};

module.exports = {
    listenForNewEmails
};
