const crypto = require('crypto');
const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

// ====== EASY-EDIT SETTINGS ======
// Keep these in sync with the same-named constants in index.html —
// that copy is only used for the browser-preview demo now; this copy
// is what actually decides real games and pays real TON.
const WIN_CHANCE = 0.40;
const STAKE = 0.3;
const PAYOUT_MULTIPLIER = 1.4;
// =================================
const PAYOUT = STAKE * PAYOUT_MULTIPLIER;

const GAME_CHOICES = {
  dice: ['odd', 'even'],
  bottle: ['white', 'black']
};

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

// crypto.randomInt is a stronger random source than Math.random — worth
// using here since this is the one place actual money outcomes hinge on it.
function secureRandomChance() {
  return crypto.randomInt(0, 1_000_000) / 1_000_000;
}

module.exports = async (req, res) => {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { initData, gameType, pick } = req.body;
  if (!initData || !gameType || !pick) {
    return res.status(400).json({ error: 'Missing initData, gameType, or pick' });
  }

  if (!verifyTelegramInitData(initData, process.env.BOT_TOKEN)) {
    return res.status(401).json({ error: 'Invalid Telegram data' });
  }

  const choices = GAME_CHOICES[gameType];
  if (!choices || !choices.includes(pick)) {
    return res.status(400).json({ error: 'Invalid gameType or pick' });
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

  if (parseFloat(user.ton_balance) < STAKE) {
    return res.status(402).json({ error: 'Not enough TON to play' });
  }

  // The actual decision — nothing about this is visible or alterable
  // from the browser, unlike the old client-side version.
  const won = secureRandomChance() < WIN_CHANCE;
  const outcome = won ? pick : choices.find(c => c !== pick);
  const delta = won ? (PAYOUT - STAKE) : -STAKE;
  const newBalance = parseFloat(user.ton_balance) + delta;

  const { data: updatedUser, error: updateError } = await supabase
    .from('users')
    .update({ ton_balance: newBalance })
    .eq('id', user.id)
    .select()
    .single();

  if (updateError) return res.status(500).json({ error: 'Failed to update balance' });

  await supabase.from('game_rounds').insert({
    user_id: user.id,
    game_type: gameType,
    stake: STAKE,
    won,
    payout: won ? PAYOUT : 0
  });

  return res.status(200).json({
    user: updatedUser,
    won,
    outcome,
    payout: won ? PAYOUT : 0,
    stake: STAKE
  });
};
    
