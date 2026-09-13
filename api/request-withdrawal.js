const crypto = require('crypto');
const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

const MIN_TON_WITHDRAW = 5.00;

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

  const { initData, amount, walletAddress } = req.body;
  if (!initData || !amount || !walletAddress) {
    return res.status(400).json({ error: 'Missing initData, amount, or walletAddress' });
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

  const amt = parseFloat(amount);
  if (isNaN(amt) || amt < MIN_TON_WITHDRAW) {
    return res.status(400).json({ error: `Minimum withdrawal is ${MIN_TON_WITHDRAW.toFixed(2)} TON` });
  }
  if (amt > parseFloat(user.ton_balance)) {
    return res.status(402).json({ error: 'Not enough TON in your balance' });
  }

  // Deduct immediately so the same balance can't be withdrawn twice while pending.
  const newBalance = parseFloat(user.ton_balance) - amt;
  const { data: updatedUser, error: updateError } = await supabase
    .from('users')
    .update({ ton_balance: newBalance })
    .eq('id', user.id)
    .select()
    .single();

  if (updateError) return res.status(500).json({ error: 'Failed to update balance' });

  await supabase.from('withdrawals').insert({
    user_id: user.id,
    currency: 'TON',
    amount: amt,
    status: 'pending',
    wallet_address: walletAddress
  });

  return res.status(200).json({ user: updatedUser });
};
