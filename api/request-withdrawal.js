const crypto = require('crypto');
const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

const MIN_TON_WITHDRAW = 0.20; 
const MIN_ORE_WITHDRAW = 1500;

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

module.exports = async (req, res) => {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { initData, amount, walletAddress, currency } = req.body;
  if (!initData || !amount || !walletAddress || !currency) {
    return res.status(400).json({ error: 'Missing initData, amount, walletAddress, or currency' });
  }
  if (currency !== 'TON' && currency !== 'ORE') {
    return res.status(400).json({ error: 'Invalid currency' });
  }

  if (!verifyTelegramInitData(initData, process.env.BOT_TOKEN)) {
    return res.status(401).json({ error: 'Invalid Telegram data' });
  }

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

  const balanceField = currency === 'TON' ? 'ton_balance' : 'ore_balance';
  const minWithdraw = currency === 'TON' ? MIN_TON_WITHDRAW : MIN_ORE_WITHDRAW;

  const amt = parseFloat(amount);
  if (isNaN(amt) || amt < minWithdraw) {
    return res.status(400).json({ error: `Minimum withdrawal is ${minWithdraw} ${currency}` });
  }
  if (amt > parseFloat(user[balanceField])) {
    return res.status(402).json({ error: `Not enough ${currency} in your balance` });
  }

  // Deduct immediately so the same balance can't be withdrawn twice while pending.
  const newBalance = parseFloat(user[balanceField]) - amt;
  const { data: updatedUser, error: updateError } = await supabase
    .from('users')
    .update({ [balanceField]: newBalance })
    .eq('id', user.id)
    .select()
    .single();

  if (updateError) return res.status(500).json({ error: 'Failed to update balance' });

  const { error: insertError } = await supabase.from('withdrawals').insert({
    user_id: user.id,
    currency,
    amount: amt,
    status: 'pending',
    wallet_address: walletAddress
  });

  if (insertError) {
    console.error('Failed to insert withdrawal record:', insertError);
    // The balance was already deducted above — refund it, since there's no
    // actual withdrawal request on record to honor. Never silently keep
    // someone's balance without a corresponding request existing.
    await supabase
      .from('users')
      .update({ [balanceField]: parseFloat(user[balanceField]) })
      .eq('id', user.id);
    return res.status(500).json({ error: 'Failed to record withdrawal request — your balance was not deducted' });
  }

  return res.status(200).json({ user: updatedUser });
};
