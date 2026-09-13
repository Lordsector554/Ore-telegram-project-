const crypto = require('crypto');
const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

// ====== EASY-EDIT SETTINGS ======
// Change the cycle length any time. Keep MINE_CYCLE_SECONDS in sync with
// the same-named constant in index.html so the on-screen countdown matches
// what the server will actually allow.
const MINE_CYCLE_SECONDS = 14400; // 4 hours
const REFERRAL_ORE_SHARE = 0.10; // 10% of every mine claim also goes to whoever referred this user
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

module.exports = async (req, res) => {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { initData } = req.body;
  if (!initData) return res.status(400).json({ error: 'Missing initData' });

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

  const now = new Date();

  // Enforce the cooldown here, server-side — this is the real check.
  // Anything the frontend shows is just a display of what this endpoint will allow.
  if (user.last_mine_claim) {
    const secondsSinceLastClaim = (now - new Date(user.last_mine_claim)) / 1000;
    if (secondsSinceLastClaim < MINE_CYCLE_SECONDS) {
      const secondsLeft = Math.ceil(MINE_CYCLE_SECONDS - secondsSinceLastClaim);
      return res.status(429).json({ error: 'Not ready yet', secondsLeft });
    }
  }

  const multiplier = parseFloat(user.next_claim_multiplier || 1);
  const reward = (user.mining_rate || 120) * multiplier;
  const newBalance = parseFloat(user.ore_balance) + reward;

  const { data: updatedUser, error: updateError } = await supabase
    .from('users')
    .update({
      ore_balance: newBalance,
      last_mine_claim: now.toISOString(),
      next_claim_multiplier: 1.0 // consumed — resets whether or not it was used
    })
    .eq('id', user.id)
    .select()
    .single();

  if (updateError) return res.status(500).json({ error: 'Failed to update balance' });

  // Pay the referral share, if this user was referred by someone.
  // A failure here shouldn't undo the user's own successful claim, so
  // errors are logged rather than turning this into a failed request.
  if (user.referred_by) {
    const share = reward * REFERRAL_ORE_SHARE;
    const { data: referrer } = await supabase
      .from('users')
      .select('ore_balance, referral_ore_earned')
      .eq('id', user.referred_by)
      .single();

    if (referrer) {
      await supabase
        .from('users')
        .update({
          ore_balance: parseFloat(referrer.ore_balance) + share,
          referral_ore_earned: parseFloat(referrer.referral_ore_earned || 0) + share
        })
        .eq('id', user.referred_by);
    }
  }

  return res.status(200).json({ user: updatedUser, rewarded: reward, cycleSeconds: MINE_CYCLE_SECONDS, wasBoosted: multiplier > 1 });
};
