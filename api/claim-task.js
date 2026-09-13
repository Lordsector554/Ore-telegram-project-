    const crypto = require('crypto');
const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

// ====== EASY-EDIT SETTINGS ======
// Keep both usernames in sync with the same-named constants in index.html
// (and PAYOUT_CHANNEL_USERNAME with process-withdrawals.js too).
const CHANNEL_USERNAME = 'ORE_Announcement';              // no @, no link — just the username
const PAYOUT_CHANNEL_USERNAME = 'ORE_payoutchannel'; // no @, no link
const REFERRAL_TON_BONUS = 0.02; // paid once to the referrer when BOTH gate tasks below are done

// Every claimable task and what it pays. This list is authoritative —
// whatever index.html shows, this is what actually decides and pays out.
// Add a new entry here whenever you add a new claimable task to the page.
//
// dailyReset: resets at UTC midnight, regardless of when it was claimed.
// resetSeconds: rolling window — claimable again N seconds after the last claim.
// Neither: one-time only, forever.
// verifyChannel: set to the channel username to check real membership against.
// isReferralGate: referral unlock + bonus only fire once ALL gate tasks are done.
const TASKS = {
  daily_checkin:       { reward: 50, currency: 'ORE', dailyReset: true },
  join_channel:        { reward: 0.01, currency: 'TON', verifyChannel: CHANNEL_USERNAME, isReferralGate: true },
  join_payout_channel: { reward: 0.01, currency: 'TON', verifyChannel: PAYOUT_CHANNEL_USERNAME, isReferralGate: true },
  follow_x:            { reward: 0.005, currency: 'TON' },
  watch_video:         { reward: 3, currency: 'ORE', resetSeconds: 10800 }, // 3 hours
  react_message:       { reward: 3, currency: 'ORE', resetSeconds: 10800 } // 3 hours — honor-system, not verified
};
const REFERRAL_GATE_TASKS = ['join_channel', 'join_payout_channel'];
// =================================

function verifyTelegramInitData(initData, botToken) {
  const params = new URLSearchParams(initData);
  const hash = params.get('hash');
  params.delete('hash');
  const pairs = [...params.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  const dataCheckString = pairs.map(([k, v]) => `${k}=${v}`).join('\n');
  const secretKey = crypto.createHmac('sha256', 'WebAppData').update(botToken).digest();
  const computedHash = crypto.createHmac('sha256', secretKey).update(dataCheckString).digest('hex');
  return computedHash === hash;
}

// Asks Telegram directly whether this user is really in the given channel.
// This is the ONLY task type that can be checked this way — everything
// else (follow on X, watch a video, react to a message) has to stay honor-system.
async function isChannelMember(telegramId, channelUsername) {
  const url = `https://api.telegram.org/bot${process.env.BOT_TOKEN}/getChatMember?chat_id=@${channelUsername}&user_id=${telegramId}`;
  const res = await fetch(url);
  const data = await res.json();
  console.log('getChatMember response:', JSON.stringify(data)); // check this in Vercel Logs
  if (!data.ok) return false;
  const status = data.result.status;
  return status === 'member' || status === 'administrator' || status === 'creator';
}

function todayString(){
  return new Date().toISOString().slice(0, 10); // YYYY-MM-DD, UTC
}

module.exports = async (req, res) => {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { initData, taskKey } = req.body;
  if (!initData || !taskKey) return res.status(400).json({ error: 'Missing initData or taskKey' });

  if (!verifyTelegramInitData(initData, process.env.BOT_TOKEN)) {
    return res.status(401).json({ error: 'Invalid Telegram data' });
  }

  const task = TASKS[taskKey];
  if (!task) return res.status(400).json({ error: 'Unknown task' });

  const params = new URLSearchParams(initData);
  const tgUser = JSON.parse(params.get('user'));

  const { data: user, error: fetchError } = await supabase
    .from('users')
    .select('*')
    .eq('telegram_id', tgUser.id)
    .single();

  if (fetchError || !user) {
    return res.status(404).json({ error: 'User not found — open the app once first' });
  }

  // Has this task already been claimed? (daily tasks reset each UTC day)
  const { data: existing } = await supabase
    .from('task_completions')
    .select('id, completed_at')
    .eq('user_id', user.id)
    .eq('task_key', taskKey);

  if (task.dailyReset) {
    const alreadyToday = (existing || []).some(row => row.completed_at.slice(0, 10) === todayString());
    if (alreadyToday) return res.status(409).json({ error: 'Already claimed today' });
  } else if (task.resetSeconds) {
    const mostRecentMs = (existing || []).reduce((latest, row) => {
      const t = new Date(row.completed_at).getTime();
      return t > latest ? t : latest;
    }, 0);
    if (mostRecentMs) {
      const secondsSince = (Date.now() - mostRecentMs) / 1000;
      if (secondsSince < task.resetSeconds) {
        const secondsLeft = Math.ceil(task.resetSeconds - secondsSince);
        return res.status(409).json({ error: 'Not ready yet', secondsLeft });
      }
    }
  } else if (existing && existing.length > 0) {
    return res.status(409).json({ error: 'Already claimed' });
  }

  if (task.verifyChannel) {
    const member = await isChannelMember(tgUser.id, task.verifyChannel);
    if (!member) return res.status(403).json({ error: 'Not a member of that channel yet' });
  }

  const balanceField = task.currency === 'TON' ? 'ton_balance' : 'ore_balance';
  const newBalance = parseFloat(user[balanceField]) + task.reward;

  const { data: updatedUser, error: updateError } = await supabase
    .from('users')
    .update({ [balanceField]: newBalance })
    .eq('id', user.id)
    .select()
    .single();

  if (updateError) return res.status(500).json({ error: 'Failed to update balance' });

  await supabase.from('task_completions').insert({
    user_id: user.id,
    task_key: taskKey,
    reward_amount: task.reward,
    currency: task.currency
  });

  // Referral unlock + one-time bonus: only fires once ALL gate tasks are
  // done (currently join_channel AND join_payout_channel), and only once
  // ever — guarded by the joined_channel flag, which is only ever set here.
  let unlockedReferral = false;
  if (task.isReferralGate && !user.joined_channel) {
    const { data: gateCompletions } = await supabase
      .from('task_completions')
      .select('task_key')
      .eq('user_id', user.id)
      .in('task_key', REFERRAL_GATE_TASKS);

    const doneKeys = new Set((gateCompletions || []).map(c => c.task_key));
    const allGatesDone = REFERRAL_GATE_TASKS.every(key => doneKeys.has(key));

    if (allGatesDone) {
      unlockedReferral = true;
      await supabase.from('users').update({ joined_channel: true }).eq('id', user.id);

      if (user.referred_by) {
        const { data: referrer } = await supabase
          .from('users')
          .select('ton_balance, referral_ton_earned')
          .eq('id', user.referred_by)
          .single();

        if (referrer) {
          await supabase
            .from('users')
            .update({
              ton_balance: parseFloat(referrer.ton_balance) + REFERRAL_TON_BONUS,
              referral_ton_earned: parseFloat(referrer.referral_ton_earned || 0) + REFERRAL_TON_BONUS
            })
            .eq('id', user.referred_by);
        }
      }
    }
  }

  return res.status(200).json({
    user: updatedUser,
    rewarded: task.reward,
    currency: task.currency,
    unlockedReferral
  });
};
