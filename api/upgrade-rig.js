const crypto = require('crypto'); 
const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

// ====== EASY-EDIT SETTINGS ======
// Each key is the CURRENT level. Add more rungs whenever you want a deeper
// progression — this list is the authoritative source for costs and rates.
const RIG_LEVELS = {
  2: { nextLevel: 3, cost: 0.50, nextRate: 180 },
  3: { nextLevel: 4, cost: 1.00, nextRate: 250 },
  4: { nextLevel: 5, cost: 2.50, nextRate: 340 }
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

  const levelInfo = RIG_LEVELS[user.rig_level];
  if (!levelInfo) {
    return res.status(400).json({ error: 'Already at max rig level' });
  }

  if (parseFloat(user.ton_balance) < levelInfo.cost) {
    return res.status(402).json({ error: 'Not enough TON' });
  }

  const newBalance = parseFloat(user.ton_balance) - levelInfo.cost;
  const { data: updatedUser, error: updateError } = await supabase
    .from('users')
    .update({
      ton_balance: newBalance,
      rig_level: levelInfo.nextLevel,
      mining_rate: levelInfo.nextRate
    })
    .eq('id', user.id)
    .select()
    .single();

  if (updateError) return res.status(500).json({ error: 'Upgrade failed' });

  const nextInfo = RIG_LEVELS[levelInfo.nextLevel];

  return res.status(200).json({
    user: updatedUser,
    newLevel: levelInfo.nextLevel,
    newRate: levelInfo.nextRate,
    nextCost: nextInfo ? nextInfo.cost : null
  });
};
      
