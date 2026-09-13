const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

// Keep in sync with AD_BOOST_MULTIPLIER in activate-boost.js
const AD_BOOST_MULTIPLIER = 2.0;

// Adsgram calls this directly from THEIR server after confirming a user
// genuinely watched an ad to completion — not triggered by the user's
// own browser, which is what makes this trustworthy. There's no Telegram
// initData here (Adsgram doesn't have it to send), so this endpoint is
// secured differently: only Adsgram's servers know this URL, and the
// worst-case abuse is just one extra mining-claim multiplier — low stakes,
// since it can't touch TON balances or withdrawals at all.
module.exports = async (req, res) => {
  if (req.method !== 'GET') return res.status(405).send('Method not allowed');

  const telegramId = req.query.userId;
  if (!telegramId) return res.status(400).send('Missing userId');

  const { data: user, error } = await supabase
    .from('users')
    .select('id, next_claim_multiplier')
    .eq('telegram_id', telegramId)
    .single();

  if (error || !user) return res.status(404).send('User not found');

  if (parseFloat(user.next_claim_multiplier || 1) > 1) {
    return res.status(200).send('Already boosted'); // prevents double-granting on retries
  }

  await supabase
    .from('users')
    .update({ next_claim_multiplier: AD_BOOST_MULTIPLIER })
    .eq('id', user.id);

  return res.status(200).send('OK');
};
