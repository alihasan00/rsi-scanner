import { SYMBOLS } from './symbols'

export type CoinFamilyKind = 'ecosystem' | 'sector' | 'meme' | 'other'

export interface CoinFamilyMember {
  symbol: string
  name: string
  relationship: string
}

export interface CoinFamily {
  id: string
  name: string
  kind: CoinFamilyKind
  anchorSymbol: string | null
  description: string
  color: string
  members: readonly CoinFamilyMember[]
}

const member = (ticker: string, name: string, relationship: string): CoinFamilyMember => ({
  symbol: `${ticker}USDT`, name, relationship,
})

// These are curated thematic relationships, not measured correlations. A token
// can belong to several families; membership never implies exclusive deployment.
const CURATED_FAMILIES: readonly CoinFamily[] = [
  {
    id: 'ethereum', name: 'Ethereum', kind: 'ecosystem', anchorSymbol: 'ETHUSDT', color: '#8895ff',
    description: 'Ethereum and projects built around its rollups, staking and applications.',
    members: [
      member('ETH', 'Ethereum', 'Ethereum network asset'),
      member('UNI', 'Uniswap', 'Ethereum-origin DEX; now multichain'),
      member('AAVE', 'Aave', 'Ethereum-origin lending; now multichain'),
      member('LDO', 'Lido', 'Ethereum liquid-staking governance'),
      member('ARB', 'Arbitrum', 'Ethereum rollup governance'),
      member('STRK', 'Starknet', 'Ethereum validity-rollup token'),
      member('ETHFI', 'ether.fi', 'Ethereum staking and restaking'),
      member('EIGEN', 'EigenCloud', 'Ethereum restaking ecosystem'),
      member('ENS', 'Ethereum Name Service', 'Ethereum naming governance'),
      member('LINK', 'Chainlink', 'Oracle network used on Ethereum and other chains'),
    ],
  },
  {
    id: 'solana', name: 'Solana', kind: 'ecosystem', anchorSymbol: 'SOLUSDT', color: '#a68bfa',
    description: 'Solana applications, infrastructure and community tokens.',
    members: [
      member('SOL', 'Solana', 'Solana network asset'),
      member('JUP', 'Jupiter', 'Solana trading and liquidity'),
      member('PYTH', 'Pyth Network', 'Solana-origin oracle network; serves multiple chains'),
      member('RENDER', 'Render', 'Distributed GPU network with token on Solana'),
      member('PUMP', 'Pump.fun', 'Solana token-launch platform'),
      member('WIF', 'dogwifhat', 'Solana meme token'),
      member('TRUMP', 'Official Trump', 'Solana meme token'),
      member('PENGU', 'Pudgy Penguins', 'Consumer-brand token launched on Solana'),
      member('PNUT', 'Peanut the Squirrel', 'Solana meme token'),
      member('HUMA', 'Huma Finance', 'Payment-financing protocol deployed on Solana and other chains'),
    ],
  },
  {
    id: 'bnb', name: 'BNB Chain', kind: 'ecosystem', anchorSymbol: 'BNBUSDT', color: '#f0bd57',
    description: 'BNB Chain applications and tokens, including projects that span other chains.',
    members: [
      member('BNB', 'BNB', 'BNB Chain network asset'),
      member('CAKE', 'PancakeSwap', 'BNB Chain-origin DEX; now multichain'),
      member('ASTER', 'Aster', 'Multichain derivatives platform including BNB Chain'),
      member('FORM', 'Four', 'BNB Chain token-launch ecosystem'),
      member('BROCCOLI714', 'Broccoli', 'BNB Chain meme token'),
      member('币安人生', '币安人生', 'BNB Chain meme token'),
    ],
  },
  {
    id: 'bitcoin', name: 'Bitcoin', kind: 'ecosystem', anchorSymbol: 'BTCUSDT', color: '#f6a34d',
    description: 'Bitcoin plus projects building applications or liquidity around BTC.',
    members: [
      member('BTC', 'Bitcoin', 'Bitcoin network asset'),
      member('STX', 'Stacks', 'Smart-contract network secured through Bitcoin'),
      member('SOLV', 'Solv Protocol', 'Bitcoin liquidity and yield across multiple chains'),
    ],
  },
  {
    id: 'cosmos', name: 'Cosmos', kind: 'ecosystem', anchorSymbol: 'ATOMUSDT', color: '#949de7',
    description: 'Independent networks connected by the Cosmos SDK and interchain technology.',
    members: [
      member('ATOM', 'Cosmos Hub', 'Cosmos Hub network asset'),
      member('INJ', 'Injective', 'Cosmos SDK financial-applications network'),
      member('TIA', 'Celestia', 'Cosmos SDK modular data-availability network'),
      member('SEI', 'Sei', 'Independent network built with Cosmos technology'),
      member('KAVA', 'Kava', 'Cosmos SDK network with EVM support'),
      member('DYDX', 'dYdX', 'Cosmos SDK derivatives appchain'),
    ],
  },
  {
    id: 'base', name: 'Base', kind: 'ecosystem', anchorSymbol: 'ETHUSDT', color: '#6e98ff',
    description: 'Applications on Base. ETH is the gas and settlement reference; Base has no token here.',
    members: [
      member('ETH', 'Ethereum', 'Base gas asset; Ethereum settlement reference'),
      member('AERO', 'Aerodrome', 'Base-native exchange and liquidity protocol'),
      member('VIRTUAL', 'Virtuals Protocol', 'Base-origin AI-agent platform; expanded to other chains'),
      member('AVNT', 'Avantis', 'Derivatives protocol on Base'),
      member('MORPHO', 'Morpho', 'Lending protocol on Ethereum, Base and other chains'),
      member('KAITO', 'Kaito', 'Information-finance project with token on Base'),
    ],
  },
  {
    id: 'payments', name: 'XRP & payments', kind: 'sector', anchorSymbol: 'XRPUSDT', color: '#61bde3',
    description: 'A payments theme across separate networks; these are not all XRP Ledger tokens.',
    members: [
      member('XRP', 'XRP', 'XRP Ledger payments asset'),
      member('XLM', 'Stellar', 'Separate payments and asset-issuance network'),
      member('LTC', 'Litecoin', 'Independent proof-of-work payments network'),
      member('BCH', 'Bitcoin Cash', 'Separate Bitcoin-fork payments network'),
      member('TRX', 'TRON', 'Independent network used for stablecoin transfers'),
      member('HUMA', 'Huma Finance', 'Onchain payment-financing protocol'),
    ],
  },
  {
    id: 'memes', name: 'Meme coins', kind: 'meme', anchorSymbol: 'DOGEUSDT', color: '#f5bd74',
    description: 'Community and meme assets across different chains, grouped by narrative.',
    members: [
      member('DOGE', 'Dogecoin', 'Independent proof-of-work meme coin'),
      member('SHIB', 'Shiba Inu', 'Ethereum-origin meme ecosystem'),
      member('PEPE', 'Pepe', 'Ethereum meme token'),
      member('WIF', 'dogwifhat', 'Solana meme token'),
      member('TRUMP', 'Official Trump', 'Solana meme token'),
      member('PENGU', 'Pudgy Penguins', 'Solana token for a consumer and NFT community'),
      member('PNUT', 'Peanut the Squirrel', 'Solana meme token'),
      member('GIGGLE', 'Giggle Fund', 'Community meme token'),
      member('BROCCOLI714', 'Broccoli', 'BNB Chain meme token'),
      member('币安人生', '币安人生', 'BNB Chain meme token'),
    ],
  },
  {
    id: 'ai', name: 'AI & compute', kind: 'sector', anchorSymbol: 'TAOUSDT', color: '#64d3bf',
    description: 'AI networks, agent platforms and decentralized computing infrastructure.',
    members: [
      member('TAO', 'Bittensor', 'Decentralized machine-learning network'),
      member('FET', 'Artificial Superintelligence Alliance', 'AI agents and decentralized AI ecosystem'),
      member('RENDER', 'Render', 'Distributed GPU rendering and compute'),
      member('VIRTUAL', 'Virtuals Protocol', 'AI-agent creation and ownership platform'),
      member('KITE', 'Kite', 'AI-agent payment infrastructure'),
      member('ACT', 'Act I', 'AI-community token on Solana'),
    ],
  },
  {
    id: 'defi', name: 'DeFi', kind: 'sector', anchorSymbol: 'AAVEUSDT', color: '#70ccb8',
    description: 'Lending, exchanges, yield and stablecoin protocols across multiple chains.',
    members: [
      member('AAVE', 'Aave', 'Multichain lending protocol'),
      member('UNI', 'Uniswap', 'Decentralized exchange protocol'),
      member('CRV', 'Curve', 'Stable-asset exchange and liquidity'),
      member('PENDLE', 'Pendle', 'Yield-trading protocol'),
      member('ENA', 'Ethena', 'Synthetic-dollar protocol'),
      member('MORPHO', 'Morpho', 'Lending markets and vaults'),
      member('SKY', 'Sky', 'Stablecoin and lending ecosystem'),
      member('COMP', 'Compound', 'Lending-protocol governance'),
      member('SNX', 'Synthetix', 'Derivatives liquidity infrastructure'),
      member('SUSHI', 'Sushi', 'Multichain decentralized exchange'),
      member('ZRX', '0x', 'Token-exchange infrastructure'),
      member('JST', 'JUST', 'TRON lending and stablecoin ecosystem'),
      member('CAKE', 'PancakeSwap', 'Multichain decentralized exchange'),
      member('JUP', 'Jupiter', 'Solana trading and liquidity'),
      member('ASTER', 'Aster', 'Derivatives trading platform'),
      member('AVNT', 'Avantis', 'Base derivatives platform'),
    ],
  },
  {
    id: 'gaming', name: 'Gaming & worlds', kind: 'sector', anchorSymbol: 'IMXUSDT', color: '#d494ee',
    description: 'Gaming platforms, digital collectibles and entertainment applications.',
    members: [
      member('IMX', 'Immutable', 'Ethereum gaming and NFT scaling ecosystem'),
      member('GALA', 'Gala', 'Gaming and entertainment ecosystem'),
      member('ENJ', 'Enjin', 'Gaming and digital-asset infrastructure'),
      member('FLOW', 'Flow', 'Consumer and digital-collectibles network'),
      member('CHZ', 'Chiliz', 'Sports fan-token ecosystem'),
      member('PENGU', 'Pudgy Penguins', 'Consumer and digital-collectibles community'),
    ],
  },
  {
    id: 'rwa', name: 'Real-world assets', kind: 'sector', anchorSymbol: 'ONDOUSDT', color: '#e0c47c',
    description: 'Projects building tokenized finance and the infrastructure it uses.',
    members: [
      member('ONDO', 'Ondo', 'Governance for a tokenized-finance ecosystem'),
      member('LINK', 'Chainlink', 'Oracle and cross-chain infrastructure for tokenization'),
      member('HUMA', 'Huma Finance', 'Onchain payment financing'),
    ],
  },
  {
    id: 'gold', name: 'Gold tokens', kind: 'sector', anchorSymbol: 'PAXGUSDT', color: '#ddc187',
    description: 'Gold-backed tokens whose prices primarily follow gold, separately from tokenization-platform governance tokens.',
    members: [
      member('PAXG', 'PAX Gold', 'Gold-backed token; price primarily follows gold'),
      member('XAUT', 'Tether Gold', 'Gold-backed token; price primarily follows gold'),
    ],
  },
  {
    id: 'privacy', name: 'Privacy', kind: 'sector', anchorSymbol: 'ZECUSDT', color: '#8eb89b',
    description: 'Assets with privacy-oriented network or application designs.',
    members: [
      member('ZEC', 'Zcash', 'Network with shielded transactions'),
      member('DASH', 'Dash', 'Payments network with optional mixing features'),
      member('NIGHT', 'Midnight', 'Privacy-oriented smart-contract ecosystem'),
    ],
  },
  {
    id: 'storage', name: 'Storage & data', kind: 'sector', anchorSymbol: 'FILUSDT', color: '#6dbecb',
    description: 'Decentralized storage, indexing and data infrastructure.',
    members: [
      member('FIL', 'Filecoin', 'Decentralized data-storage network'),
      member('AR', 'Arweave', 'Permanent data-storage network'),
      member('GRT', 'The Graph', 'Blockchain data-indexing protocol'),
      member('JASMY', 'JasmyCoin', 'Data ownership and connected-device project'),
    ],
  },
  {
    id: 'layer1', name: 'Layer 1s', kind: 'sector', anchorSymbol: 'ETHUSDT', color: '#80afe3',
    description: 'Independent base networks grouped by infrastructure role, not a shared ecosystem.',
    members: [
      member('ETH', 'Ethereum', 'Smart-contract base network'),
      member('SOL', 'Solana', 'Smart-contract base network'),
      member('BNB', 'BNB', 'BNB Chain network asset'),
      member('SUI', 'Sui', 'Move-based smart-contract network'),
      member('ADA', 'Cardano', 'Proof-of-stake smart-contract network'),
      member('AVAX', 'Avalanche', 'Smart-contract and application-chain network'),
      member('NEAR', 'NEAR Protocol', 'Sharded smart-contract network'),
      member('APT', 'Aptos', 'Move-based smart-contract network'),
      member('DOT', 'Polkadot', 'Shared-security multichain network'),
      member('ICP', 'Internet Computer', 'Decentralized application-compute network'),
      member('HBAR', 'Hedera', 'Hashgraph distributed network'),
      member('ETC', 'Ethereum Classic', 'Separate proof-of-work Ethereum fork'),
      member('VET', 'VeChain', 'Enterprise-focused smart-contract network'),
      member('ALGO', 'Algorand', 'Proof-of-stake smart-contract network'),
      member('CFX', 'Conflux', 'Smart-contract base network'),
      member('KSM', 'Kusama', 'Polkadot-related experimentation network'),
      member('ONE', 'Harmony', 'Sharded smart-contract network'),
      member('QTUM', 'Qtum', 'UTXO-based smart-contract network'),
      member('IOST', 'IOST', 'Smart-contract network'),
      member('ZIL', 'Zilliqa', 'Sharded smart-contract network'),
      member('EGLD', 'MultiversX', 'Sharded smart-contract network'),
      member('XPL', 'Plasma', 'Stablecoin-focused base network'),
    ],
  },
  {
    id: 'layer2', name: 'Scaling & rollups', kind: 'sector', anchorSymbol: 'ARBUSDT', color: '#9ca8f5',
    description: 'Rollups, scaling ecosystems and supporting infrastructure.',
    members: [
      member('ARB', 'Arbitrum', 'Ethereum optimistic-rollup governance'),
      member('STRK', 'Starknet', 'Ethereum validity-rollup token'),
      member('IMX', 'Immutable', 'Ethereum gaming and scaling ecosystem'),
      member('POL', 'Polygon', 'Polygon scaling ecosystem; includes a separate PoS chain'),
      member('CELO', 'Celo', 'Ethereum layer-2 network'),
      member('ALT', 'AltLayer', 'Rollup deployment and restaking infrastructure'),
      member('TIA', 'Celestia', 'Independent data-availability layer used by rollups'),
    ],
  },
  {
    id: 'crosschain', name: 'Cross-chain', kind: 'sector', anchorSymbol: 'LINKUSDT', color: '#8abeb2',
    description: 'Interoperability, cross-chain messaging and native-asset exchange infrastructure.',
    members: [
      member('LINK', 'Chainlink', 'Oracle network and cross-chain messaging'),
      member('ZRO', 'LayerZero', 'Cross-chain messaging protocol'),
      member('QNT', 'Quant', 'Distributed-ledger interoperability platform'),
      member('RUNE', 'THORChain', 'Native-asset cross-chain exchange network'),
      member('PARTI', 'Particle Network', 'Chain-abstraction infrastructure'),
    ],
  },
]

const supportedSymbols = new Set(SYMBOLS)
const curatedFamilies = CURATED_FAMILIES.map((family) => ({
  ...family,
  members: family.members.filter(({ symbol }) => supportedSymbols.has(symbol)),
}))
const assignedSymbols = new Set(curatedFamilies.flatMap(({ members }) => members.map(({ symbol }) => symbol)))
const otherMembers = SYMBOLS.filter((symbol) => !assignedSymbols.has(symbol)).map((symbol) => ({
  symbol,
  name: symbol.replace(/USDT$/, ''),
  relationship: 'Not assigned to a curated family; no shared relationship implied',
}))

export const COIN_FAMILIES: readonly CoinFamily[] = [
  ...curatedFamilies,
  ...(otherMembers.length ? [{
    id: 'other', name: 'Other assets', kind: 'other' as const, anchorSymbol: null,
    description: 'The rest of your scanner universe. These assets are not grouped by a shared relationship.',
    color: '#94a3b8', members: otherMembers,
  }] : []),
]

/** One deduplicated spot-ticker request covers every family, including overlaps. */
export const FAMILY_SYMBOLS: readonly string[] = [...new Set(
  COIN_FAMILIES.flatMap(({ members }) => members.map(({ symbol }) => symbol)),
)]
