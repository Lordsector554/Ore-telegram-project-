const crypto = require('crypto');
const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

// ====== EASY-EDIT SETTINGS ======
// Your real receiving wallet — only ever used to RECEIVE deposits, never
// to send anything. Keep this separate from your withdrawal wallet.
const DEPOSIT_ADDRESS = 'UQA_COfGxFNQH7OWd3tjsy5KsBwnDQa-0I08Z3puY0ubN-bq';
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

// Checks the deposit address for any new incoming transaction whose memo
// (comment) matches this user's personal referral code, and credits it.
// tx_hash has a UNIQUE constraint in Supabase, so even if this runs twice
// on the same transaction, it can only ever be credited once.
async function syncDeposits(user) {
  const apiKeyParam = process.env.TONCENTER_API_KEY ? `&api_key=${process.env.TONCENTER_API_KEY}` : '';
  const url = `https://toncenter.com/api/v2/getTransactions?address=${DEPOSIT_ADDRESS}&limit=50${apiKeyParam}`;

  let data;
  try {
    const res = await fetch(url);
    data = await res.json();
  } catch (err) {
    console.error('syncDeposits fetch failed:', err);
    return;
  }
  if (!data.ok) return;

  for (const tx of data.result) {
    const inMsg = tx.in_msg;
    if (!inMsg || !inMsg.value || inMsg.value === '0') continue; // skip non-deposits
    const memo = (inMsg.message || '').trim();
    if (memo !== user.referral_code) continue; // only this user's deposits

    const txHash = tx.transaction_id.hash;
    const amountTon = parseInt(inMsg.value, 10) / 1e9;

    const { data: existing } = await supabase
      .from('deposits')
      .select('id')
      .eq('tx_hash', txHash)
      .maybeSingle();
    if (existing) continue; // already credited

    await supabase.from('deposits').insert({
      user_id: user.id,
      amount: amountTon,
      tx_hash: txHash,
      memo,
      credited_at: new Date().toISOString()
    });

    const { data: freshUser } = await supabase
      .from('users')
      .select('ton_balance')
      .eq('id', user.id)
      .single();

    await supabase
      .from('users')
      .update({ ton_balance: parseFloat(freshUser.ton_balance) + amountTon })
      .eq('id', user.id);
  }
}

module.exports = async (req, res) => {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { initData } = req.body;
  if (!initData) return res.status(400).json({ error: 'Missing initData' });

  const valid = verifyTelegramInitData(initData, process.env.BOT_TOKEN);
  if (!valid) return res.status(401).json({ error: 'Invalid Telegram data' });

  const params = new URLSearchParams(initData);
  const tgUser = JSON.parse(params.get('user'));
  const startParam = params.get('start_param'); // set when opened via a referral link

  let { data: existingUser } = await supabase
    .from('users')
    .select('*')
    .eq('telegram_id', tgUser.id)
    .single();

  if (!existingUser) {
    let referredBy = null;
    if (startParam) {
      const { data: referrer } = await supabase
        .from('users')
        .select('id')
        .eq('referral_code', startParam)
        .single();
      if (referrer) referredBy = referrer.id;
    }

    const referralCode = 'ORE_' + tgUser.id.toString(36).toUpperCase();

    const { data: newUser } = await supabase
      .from('users')
      .insert({
        telegram_id: tgUser.id,
        username: tgUser.username || null,
        first_name: tgUser.first_name || null,
        referral_code: referralCode,
        referred_by: referredBy
      })
      .select()
      .single();

    existingUser = newUser;
  }

  // NEW: tell the frontend which tasks are already done, so checkmarks
  // show correctly on load instead of only after the button is tapped again.
  // Daily tasks only count as "done" if completed today (UTC) — they should
  // reset to claimable each day.
  const { data: completions } = await supabase
    .from('task_completions')
    .select('task_key, completed_at')
    .eq('user_id', existingUser.id);

  const today = new Date().toISOString().slice(0, 10);
  const completedTasks = (completions || [])
    .filter(c => c.task_key !== 'daily_checkin' || c.completed_at.slice(0, 10) === today)
    .map(c => c.task_key);

  // Check for and credit any new deposits, then re-fetch the user so the
  // response reflects the up-to-date balance.
  await syncDeposits(existingUser);
  const { data: refreshedUser } = await supabase
    .from('users')
    .select('*')
    .eq('id', existingUser.id)
    .single();

  return res.status(200).json({
    user: refreshedUser || existingUser,
    completedTasks,
    depositAddress: DEPOSIT_ADDRESS,
    depositMemo: existingUser.referral_code
  });
};
