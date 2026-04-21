/**
 * Hive @buildawhale Burn Post Voter
 * ==================================
 * Uses @hiveio/dhive (Node.js)
 *
 * What it does:
 *   1. Checks your Voting Power (VP)
 *   2. If VP >= 80%, finds today's @buildawhale burn post
 *   3. Votes on the burn post
 *   4. Finds all comments made by @buildawhale on that post and votes on them
 *
 * Setup:
 *   npm install @hiveio/dhive node-cron
 *
 * Run modes:
 *   node hive_burn_voter.js              → starts cron scheduler (23:50 UTC daily)
 *   node hive_burn_voter.js --run-once   → runs immediately and exits (GitHub Actions)
 *
 * Credentials (choose one):
 *   a) Environment variables: HIVE_USERNAME and HIVE_POSTING_KEY  ← recommended
 *   b) Hardcode below in CONFIG (local testing only — never commit your key!)
 */

'use strict';

const dhive = require('@hiveio/dhive');
const cron  = require('node-cron');

// ─────────────────────────── CONFIG ───────────────────────────────────────────

const CONFIG = {
  // Credentials: env vars take priority; fallback to hardcoded values below.
  // For GitHub Actions, set HIVE_USERNAME and HIVE_POSTING_KEY as repo secrets.
  username:   process.env.HIVE_USERNAME    || 'your-hive-username',
  postingKey: process.env.HIVE_POSTING_KEY || '5Jxxx...',

  buildawhale:  'buildawhale',  // account that posts daily burn posts
  vpThreshold:  80,             // minimum VP % required to trigger voting
  voteWeight:   10000,          // 10000 = 100% upvote (range: 1–10000)

  // Cron schedule — default: every day at 23:50 UTC
  // To run on specific days only, e.g. Mon+Wed+Fri: '50 23 * * 1,3,5'
  cronSchedule: '50 23 * * *',

  // Hive RPC nodes (tried in order, falls back automatically)
  nodes: [
    'https://api.hive.blog',
    'https://api.deathwing.me',
    'https://hive-api.arcange.eu',
    'https://anyx.io',
  ],
};

// ──────────────────────────── CLIENT ──────────────────────────────────────────

const client     = new dhive.Client(CONFIG.nodes);
const postingKey = dhive.PrivateKey.fromString(CONFIG.postingKey);

// ──────────────────────────── HELPERS ─────────────────────────────────────────

function log(msg) {
  console.log(`[${new Date().toISOString()}] ${msg}`);
}

/**
 * Calculate current Voting Power percentage (0–100).
 * Hive stores voting_power as 0–10000 and regenerates at 20% per day.
 */
function calcCurrentVP(account) {
  const lastVoteTime = new Date(account.last_vote_time + 'Z').getTime();
  const now          = Date.now();
  const elapsedSec   = (now - lastVoteTime) / 1000;
  const regenerated  = elapsedSec * (10000 / 432000); // 432000s = 5 days full regen
  const currentVP    = Math.min(10000, account.voting_power + regenerated);
  return currentVP / 100;
}

/**
 * Fetch @buildawhale's recent blog posts and return the one published today (UTC).
 */
async function findTodaysBurnPost() {
  const todayUTC = new Date().toISOString().slice(0, 10); // "YYYY-MM-DD"

  const posts = await client.database.getDiscussions('blog', {
    tag:   CONFIG.buildawhale,
    limit: 10,
  });

  for (const post of posts) {
    if (post.parent_author !== '') continue; // skip comments
    const postDate = new Date(post.created + 'Z').toISOString().slice(0, 10);
    if (postDate === todayUTC) return post;
  }

  return null;
}

/**
 * Fetch all replies on a post authored by @buildawhale.
 */
async function findBuildawhaleComments(post) {
  const replies = await client.database.call('get_content_replies', [
    post.author,
    post.permlink,
  ]);
  return replies.filter(r => r.author === CONFIG.buildawhale);
}

/**
 * Vote on a post or comment. Skips silently if already voted.
 */
async function voteOn(content, label) {
  const alreadyVoted = content.active_votes.some(
    v => v.voter === CONFIG.username
  );

  if (alreadyVoted) {
    log(`  ⚠️  Already voted on ${label} — skipping.`);
    return;
  }

  try {
    await client.broadcast.vote(
      {
        voter:    CONFIG.username,
        author:   content.author,
        permlink: content.permlink,
        weight:   CONFIG.voteWeight,
      },
      postingKey
    );
    log(`  ✅  Voted on ${label} (@${content.author}/${content.permlink})`);
  } catch (err) {
    log(`  ❌  Failed to vote on ${label}: ${err.message}`);
  }
}

// ──────────────────────────── MAIN JOB ────────────────────────────────────────

async function runJob() {
  log('═══════════════════════════════════════════');
  log('Starting @buildawhale burn post voter job…');

  // 1. Check Voting Power
  const [account] = await client.database.getAccounts([CONFIG.username]);
  if (!account) {
    log(`❌ Account @${CONFIG.username} not found. Check your username.`);
    return;
  }

  const vp = calcCurrentVP(account);
  log(`⚡ Voting Power for @${CONFIG.username}: ${vp.toFixed(2)}%`);

  if (vp < CONFIG.vpThreshold) {
    log(`🛑 VP (${vp.toFixed(2)}%) is below threshold (${CONFIG.vpThreshold}%). Skipping.`);
    return;
  }

  log(`✅ VP is above ${CONFIG.vpThreshold}%. Proceeding to vote…`);

  // 2. Find today's burn post
  log(`🔍 Looking for today's @${CONFIG.buildawhale} burn post…`);
  const burnPost = await findTodaysBurnPost();

  if (!burnPost) {
    log(`⚠️  No @${CONFIG.buildawhale} burn post found for today.`);
    return;
  }

  log(`📄 Found burn post: "${burnPost.title}" (${burnPost.permlink})`);

  // 3. Vote on the burn post
  log('🗳️  Voting on burn post…');
  const fullPost = await client.database.call('get_content', [
    burnPost.author,
    burnPost.permlink,
  ]);
  await voteOn(fullPost, 'burn post');

  await new Promise(r => setTimeout(r, 3000));

  // 4. Find and vote on @buildawhale's burn comments
  log(`💬 Looking for @${CONFIG.buildawhale} comments on the burn post…`);
  const burnComments = await findBuildawhaleComments(burnPost);

  if (burnComments.length === 0) {
    log('  ℹ️  No burn comments found.');
  } else {
    log(`  Found ${burnComments.length} burn comment(s). Voting…`);
    for (const comment of burnComments) {
      const fullComment = await client.database.call('get_content', [
        comment.author,
        comment.permlink,
      ]);
      await voteOn(fullComment, 'burn comment');
      await new Promise(r => setTimeout(r, 3000));
    }
  }

  log('🎉 Job complete!');
  log('═══════════════════════════════════════════');
}

// ──────────────────────────── ENTRYPOINT ──────────────────────────────────────

const runOnce = process.argv.includes('--run-once');

if (runOnce) {
  // GitHub Actions mode: run immediately then exit
  log('▶️  --run-once flag detected (GitHub Actions mode)');
  runJob()
    .then(() => process.exit(0))
    .catch(err => {
      log(`💥 Fatal error: ${err.message}`);
      process.exit(1);
    });
} else {
  // Local mode: start cron scheduler
  log(`🕐 Scheduler started. Cron: "${CONFIG.cronSchedule}" (UTC)`);
  log(`   Monitoring account : @${CONFIG.username}`);
  log(`   VP threshold       : ${CONFIG.vpThreshold}%`);
  log(`   Vote weight        : ${CONFIG.voteWeight / 100}%`);

  cron.schedule(CONFIG.cronSchedule, () => {
    runJob().catch(err => log(`💥 Unhandled error: ${err.message}`));
  }, { timezone: 'UTC' });
}
