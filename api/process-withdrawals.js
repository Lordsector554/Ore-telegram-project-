const { createClient } = require('@supabase/supabase-js');
const { TonClient, WalletContractV4, internal } = require('@ton/ton');
const { mnemonicToPrivateKey } = require('@ton/crypto');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

// ====== EASY-EDIT SETTINGS ======
// Where successful withdrawals get posted as public proof.
const PAYOUT_CHANNEL_USERNAME = 'ORE_payoutchannel'; // no @, no link
const PAYOUT_IMAGE_URL = 'https://ibb.co/kV04JD7H'; // optional — paste a public image URL here to include an image with each payout post
// =================================

// You trigger this by visiting:
// https://yourdomain.vercel.app/api/process-withdrawals?key=YOUR_ADMIN_SECRET
// after approving one or more withdrawals in Supabase (status = 'approved').
module.exports = async (req, res) => {
  if (req.query.key !== process.env.ADMIN_SECRET) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const mnemonicWords = (process.env.WITHDRAWAL_WALLET_MNEMONIC || '').split(' ');
  if (mnemonicWords.length !== 24) {
    return res.status(500).json({ error: 'WITHDRAWAL_WALLET_MNEMONIC is missing or malformed' });
  }

  const keyPair = await mnemonicToPrivateKey(mnemonicWords);
  const wallet = WalletContractV4.create({ workchain: 0, publicKey: keyPair.publicKey });
  const client = new TonClient({
    endpoint: 'https://toncenter.com/api/v2/jsonRPC',
    apiKey: process.env.TONCENTER_API_KEY || undefined
  });
  const contract = client.open(wallet);

  const { data: approved } = await supabase
    .from('withdrawals')
    .select('*')
    .eq('status', 'approved')
    .eq('sent', false);

  const results = [];

  for (const w of (approved || [])) {
    try {
      const seqno = await contract.getSeqno();
      await contract.sendTransfer({
        seqno,
        secretKey: keyPair.secretKey,
        messages: [internal({
          to: w.wallet_address,
          value: w.amount.toString(),
          body: 'OreTap withdrawal'
        })]
      });

      await supabase
        .from('withdrawals')
        .update({ sent: true, processed_at: new Date().toISOString() })
        .eq('id', w.id);

      try {
        const payoutTime = new Date().toUTCString();
        const messageText = `💰 New Payout Completed\n\n🕒 Time: ${payoutTime}\n💰 Amount: ${w.amount} ${w.currency}\n🌐 Network: TON\n✅ Payment processed successfully`;

        // If PAYOUT_IMAGE_URL is set, posts as a photo with this text as the
        // caption. If left blank, falls back to a plain text message — no
        // need to have an image ready before this works.
        const telegramMethod = PAYOUT_IMAGE_URL ? 'sendPhoto' : 'sendMessage';
        const telegramBody = PAYOUT_IMAGE_URL
          ? { chat_id: '@' + PAYOUT_CHANNEL_USERNAME, photo: PAYOUT_IMAGE_URL, caption: messageText }
          : { chat_id: '@' + PAYOUT_CHANNEL_USERNAME, text: messageText };

        await fetch(`https://api.telegram.org/bot${process.env.BOT_TOKEN}/${telegramMethod}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(telegramBody)
        });
        await supabase.from('withdrawals').update({ notified: true }).eq('id', w.id);
      } catch (notifyErr) {
        console.error('Payout channel post failed for', w.id, notifyErr);
      }

      results.push({ id: w.id, amount: w.amount, status: 'sent' });
    } catch (err) {
      console.error('Withdrawal send failed for', w.id, err);
      results.push({ id: w.id, amount: w.amount, status: 'failed', error: err.message });
    }
  }

  return res.status(200).json({ processed: results.length, results });
};
