const { Client, PrivateKey } = require('@hiveio/dhive');
require('dotenv').config(); // Load environment variables

// Load accounts dynamically from environment
const ACCOUNTS = [];
let accountIndex = 1;
while (process.env[`ACCOUNT_${accountIndex}_USERNAME`]) {
    const username = process.env[`ACCOUNT_${accountIndex}_USERNAME`];
    const postingKey = process.env[`ACCOUNT_${accountIndex}_POSTING_KEY`];

    if (username && postingKey) {
        ACCOUNTS.push({
            username: username,
            postingKey: postingKey
        });
    }
    accountIndex++;
}

// Load other settings from environment (with defaults)
const TARGET_AUTHOR = process.env.TARGET_AUTHOR || 'buildawhale';
const MIN_VOTING_POWER = parseInt(process.env.MIN_VOTING_POWER) || 8000;
const VOTE_WEIGHT = parseInt(process.env.VOTE_WEIGHT) || 10000;
const HOURS_BACK = parseInt(process.env.HOURS_BACK) || 24;
const DELAY_BETWEEN_ACCOUNTS = parseInt(process.env.DELAY_BETWEEN_ACCOUNTS) || 5000;
const DELAY_BETWEEN_VOTES = parseInt(process.env.DELAY_BETWEEN_VOTES) || 3000;

const client = new Client('https://hive-api.3speak.tv');

console.log(`\n🐋 Loaded ${ACCOUNTS.length} accounts from environment`);
console.log(`Accounts: ${ACCOUNTS.map(a => a.username).join(', ')}`);

/**
 * Get current voting power with smart regeneration detection
 */
async function getCurrentVotingPower(username) {
    try {
        const accounts = await client.database.getAccounts([username]);
        const account = accounts[0];

        const currentMana = account.voting_manabar.current_mana;
        const maxMana = parseFloat(account.voting_power);
        const lastUpdateTime = account.voting_manabar.last_update_time;

        // Calculate time since last vote
        const hoursSinceLastVote = (Date.now() / 1000 - lastUpdateTime) / 3600;
        const regeneratedPower = hoursSinceLastVote * (2000 / 24); // 20% per day

        console.log(`\n--- VP Analysis for @${username} ---`);
        console.log(`Current mana: ${currentMana}`);
        console.log(`Max voting power: ${maxMana}`);
        console.log(`Hours since last vote: ${hoursSinceLastVote.toFixed(2)}`);
        console.log(`Regenerated power: ${regeneratedPower.toFixed(2)}`);

        // KEY LOGIC: If regenerated power is high (>75), maxMana is stale, use currentMana
        let currentVP;
        if (regeneratedPower > 75) {
            // High regeneration means voting_power is stale, use current mana
            console.log(`🔄 High regeneration detected (${regeneratedPower.toFixed(2)} > 75)`);
            console.log(`Using current mana: ${currentMana}`);
            currentVP = currentMana;
        } else {
            // Low regeneration means voting_power is current, use it
            console.log(`✅ Low regeneration (${regeneratedPower.toFixed(2)} ≤ 75)`);
            currentVP = Math.min(currentMana, maxMana);
            console.log(`Using standard calculation: ${currentVP}`);
        }

        console.log(`Final current VP: ${currentVP}/10000 (${(currentVP / 100).toFixed(2)}%)`);

        return Math.floor(currentVP);

    } catch (error) {
        console.error('Error getting voting power:', error.message);
        return 0;
    }
}

/**
 * Get the latest post from author
 */
async function getLatestPost(author, hoursBack) {
    try {
        const cutoffTime = new Date(Date.now() - (hoursBack * 60 * 60 * 1000));

        const posts = await client.database.getDiscussions('blog', {
            tag: author,
            limit: 5
        });

        const validPosts = posts.filter(post => new Date(post.created) > cutoffTime);

        if (validPosts.length > 0) {
            return validPosts[0];
        }

        return null;
    } catch (error) {
        console.error('Error getting latest post:', error.message);
        return null;
    }
}

/**
 * Get buildawhale's comments on a post
 */
async function getBuildawhaleComments(postAuthor, postPermlink) {
    const comments = [];

    try {
        const allReplies = await client.database.call('get_content_replies', [postAuthor, postPermlink]);

        for (const reply of allReplies) {
            if (reply.author === TARGET_AUTHOR) {
                comments.push({
                    author: reply.author,
                    permlink: reply.permlink,
                    title: `Comment: ${reply.body.substring(0, 80)}...`,
                    created: reply.created,
                    parent_author: reply.parent_author,
                    parent_permlink: reply.parent_permlink,
                    body: reply.body,
                    net_votes: reply.net_votes
                });
            }
        }

        return comments;

    } catch (error) {
        console.error('Error getting comments:', error.message);
        return [];
    }
}

/**
 * Check if user has already voted
 */
async function hasAlreadyVoted(username, author, permlink) {
    try {
        const activeVotes = await client.database.call('get_active_votes', [author, permlink]);
        return activeVotes.some(vote => vote.voter === username);
    } catch (error) {
        return false;
    }
}

/**
 * Cast a vote
 */
async function castVote(username, postingKey, author, permlink, weight) {
    try {
        const privateKey = PrivateKey.fromString(postingKey);

        const voteOperation = [
            'vote',
            {
                voter: username,
                author: author,
                permlink: permlink,
                weight: weight
            }
        ];

        const result = await client.broadcast.sendOperations([voteOperation], privateKey);
        return result;

    } catch (error) {
        console.error('Error casting vote:', error.message);
        throw error;
    }
}

/**
 * Process voting for a single account
 */
async function processAccount(account) {
    console.log(`\n🐋 Processing Account: @${account.username}`);
    console.log('='.repeat(50));

    try {
        // Get starting voting power with smart regeneration detection
        let currentVP = await getCurrentVotingPower(account.username);

        if (currentVP < MIN_VOTING_POWER) {
            console.log(`❌ Below minimum voting power (${MIN_VOTING_POWER/100}%) - skipping account`);
            return { username: account.username, votesCast: 0, startVP: currentVP, endVP: currentVP };
        }

        // Get the latest post
        console.log(`\n1️⃣ Getting latest post from @${TARGET_AUTHOR}...`);
        const latestPost = await getLatestPost(TARGET_AUTHOR, HOURS_BACK);

        if (!latestPost) {
            console.log('No recent posts found.');
            return { username: account.username, votesCast: 0, startVP: currentVP, endVP: currentVP };
        }

        console.log(`Latest post: "${latestPost.title}" (${latestPost.created})`);

        // Get buildawhale's comments
        console.log(`\n2️⃣ Getting @${TARGET_AUTHOR}'s comments...`);
        const comments = await getBuildawhaleComments(latestPost.author, latestPost.permlink);

        // Combine post + comments
        const allContent = [
            {
                author: latestPost.author,
                permlink: latestPost.permlink,
                title: latestPost.title,
                created: latestPost.created,
                isPost: true
            },
            ...comments.map(comment => ({
                ...comment,
                isPost: false
            }))
        ];

        console.log(`Found ${allContent.length} total items to vote on (1 post + ${comments.length} comments)`);

        // Vote on everything until VP drops to target
        console.log(`\n3️⃣ Voting until VP reaches ${MIN_VOTING_POWER/100}%...`);
        let votesCast = 0;
        const startVP = currentVP;

        for (const item of allContent) {
            try {
                // Check current voting power before each vote
                currentVP = await getCurrentVotingPower(account.username);

                if (currentVP < MIN_VOTING_POWER) {
                    console.log(`🛑 Reached target VP of ${MIN_VOTING_POWER/100}%. Stopping.`);
                    break;
                }

                // Check if already voted
                const alreadyVoted = await hasAlreadyVoted(account.username, item.author, item.permlink);

                if (!alreadyVoted) {
                    const itemType = item.isPost ? 'Post' : 'Comment';
                    console.log(`Current VP: ${currentVP}/10000 (${(currentVP/100).toFixed(2)}%)`);
                    console.log(`Voting on ${itemType}: "${item.title}"`);

                    await castVote(account.username, account.postingKey, item.author, item.permlink, VOTE_WEIGHT);
                    console.log(`✅ Voted successfully!`);

                    votesCast++;

                    // Wait between votes
                    if (allContent.indexOf(item) < allContent.length - 1) {
                        await new Promise(resolve => setTimeout(resolve, DELAY_BETWEEN_VOTES));
                    }
                } else {
                    console.log(`Already voted on: "${item.title}"`);
                }
            } catch (voteError) {
                console.log(`Error voting on "${item.title}": ${voteError.message}`);
            }
        }

        // Final voting power
        const finalVP = await getCurrentVotingPower(account.username);
        console.log(`\n📊 Account Results for @${account.username}:`);
        console.log(`Votes cast: ${votesCast}`);
        console.log(`VP changed from ${startVP}/10000 to ${finalVP}/10000`);

        return {
            username: account.username,
            votesCast: votesCast,
            startVP: startVP,
            endVP: finalVP
        };

    } catch (error) {
        console.error(`Error processing account @${account.username}:`, error.message);
        return {
            username: account.username,
            votesCast: 0,
            startVP: 0,
            endVP: 0
        };
    }
}

/**
 * Main function - process all accounts
 */
async function runMultiAccountVoter() {
    console.log('\n🐋 Buildawhale Flexible Multi-Account Auto-Voter');
    console.log(`Target: @${TARGET_AUTHOR}`);
    console.log(`Accounts: ${ACCOUNTS.map(a => a.username).join(', ')}`);
    console.log(`Stop at: ${MIN_VOTING_POWER/100}% VP each`);
    console.log(`Vote weight: ${VOTE_WEIGHT/100}%`);
    console.log(`Loaded from: .env file (flexible format)`);
    console.log('========================================\n');

    if (ACCOUNTS.length === 0) {
        console.log('❌ No accounts found in environment variables!');
        console.log('Please check your .env file uses the format:');
        console.log('ACCOUNT_1_USERNAME=yourusername');
        console.log('ACCOUNT_1_POSTING_KEY=5YOURKEYHERE');
        console.log('ACCOUNT_2_USERNAME=anotherusername');
        console.log('ACCOUNT_2_POSTING_KEY=5ANOTHERKEYHERE');
        return;
    }

    const results = [];

    // Process each account sequentially
    for (let i = 0; i < ACCOUNTS.length; i++) {
        const account = ACCOUNTS[i];
        const result = await processAccount(account);
        results.push(result);

        // Wait between accounts (except for the last one)
        if (i < ACCOUNTS.length - 1) {
            console.log(`\n⏳ Waiting ${DELAY_BETWEEN_ACCOUNTS/1000} seconds before next account...`);
            await new Promise(resolve => setTimeout(resolve, DELAY_BETWEEN_ACCOUNTS));
        }
    }

    // Final summary
    console.log('\n' + '='.repeat(60));
    console.log('📊 FINAL RESULTS FOR ALL ACCOUNTS');
    console.log('='.repeat(60));

    let totalVotes = 0;
    results.forEach(result => {
        console.log(`\n@${result.username}:`);
        console.log(`  Votes cast: ${result.votesCast}`);
        console.log(`  VP used: ${((result.startVP - result.endVP)/100).toFixed(2)}%`);
        console.log(`  Final VP: ${(result.endVP/100).toFixed(2)}%`);
        totalVotes += result.votesCast;
    });

    console.log(`\n🎯 Total votes cast across all accounts: ${totalVotes}`);
    console.log('✅ Multi-account voting complete!');
}

// Run the multi-account voter
runMultiAccountVoter().catch(error => {
    console.error('Multi-account voter failed:', error.message);
});
