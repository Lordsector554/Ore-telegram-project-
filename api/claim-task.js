const crypto = require('crypto');
const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

// ====== EASY-EDIT SETTINGS ======
// Keep CHANNEL_USERNAME in sync with the same-named constant in index.html.
const CHANNEL_USERNAME = 'YourChannel'; // no @, no link — just the username

// Every claimable task and what it pays. This list is authoritative —
// whatever index.html shows, this is what actually decides and pays out.
// Add a new entry here whenever you add a new claimable task to the page.
const TASKS = {
  daily_checkin: { reward: 0.50, currency: 'TON', dailyReset: true },
  join_channel:  { reward: 2.00, currency: 'TON', verifyChannel: true, unlocksReferral: true },
  follow_x:      { reward: 1.50, currency: 'TON' },
  watch_video:   { reward: 0.30, currency: 'TON' }
};
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

// Asks Telegram directly whether this user is really in the channel.
// This is the ONLY task type that can be checked this way — everything
// else (follow on X, watch a video) has to stay honor-system.
async function isChannelMember(telegramId) {
  const url = `https://api.telegram.org/bot${process.env.BOT_TOKEN}/getChatMember?chat_id=@${CHANNEL_USERNAME}&user_id=${telegramId}`;
  const res = await fetch(url);
  const data = await res.json();
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
  } else if (existing && existing.length > 0) {
    return res.status(409).json({ error: 'Already claimed' });
  }

  if (task.verifyChannel) {
    const member = await isChannelMember(tgUser.id);
    if (!member) return res.status(403).json({ error: 'Not a member of the channel yet' });
  }

  const balanceField = task.currency === 'TON' ? 'ton_balance' : 'ore_balance';
  const newBalance = parseFloat(user[balanceField]) + task.reward;

  const updates = { [balanceField]: newBalance };
  if (task.unlocksReferral) updates.joined_channel = true;

  const { data: updatedUser, error: updateError } = await supabase
    .from('users')
    .update(updates)
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

  return res.status(200).json({
    user: updatedUser,
    rewarded: task.reward,
    currency: task.currency,
    unlockedReferral: !!task.unlocksReferral
  });
};
    
