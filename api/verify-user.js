const crypto = require('crypto');
const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

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

  return res.status(200).json({ user: existingUser, completedTasks });
};
    
