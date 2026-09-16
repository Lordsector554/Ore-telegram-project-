// ====== EASY-EDIT SETTINGS ======
// Your real ORE Jetton contract address, even before it has liquidity.
// This is public information, not a secret — safe to keep as a plain constant.
const ORE_JETTON_ADDRESS = 'PUT_YOUR_ORE_JETTON_CONTRACT_ADDRESS_HERE';
// =================================

// Public market data — no Telegram auth needed, since this isn't user-specific.
// Before you add liquidity, this will correctly return hasLiquidity: false,
// since there's genuinely no market yet — that's expected, not a bug.
// The moment a real pool exists on any major TON DEX, this starts returning
// a real price automatically, with no code changes needed.
module.exports = async (req, res) => {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const url = `https://api.geckoterminal.com/api/v2/networks/ton/tokens/${ORE_JETTON_ADDRESS}`;
    const response = await fetch(url, { headers: { Accept: 'application/json' } });

    if (!response.ok) {
      return res.status(200).json({ hasLiquidity: false, priceUsd: null });
    }

    const data = await response.json();
    const priceUsd = parseFloat(data?.data?.attributes?.price_usd);

    if (!priceUsd || isNaN(priceUsd)) {
      return res.status(200).json({ hasLiquidity: false, priceUsd: null });
    }

    return res.status(200).json({ hasLiquidity: true, priceUsd });
  } catch (err) {
    console.error('ore-price fetch failed:', err);
    return res.status(200).json({ hasLiquidity: false, priceUsd: null });
  }
};
