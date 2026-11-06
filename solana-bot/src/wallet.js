// Portefeuille réel (mode live uniquement) : clé privée locale + swaps via Jupiter.
// La clé ne quitte jamais cette machine : les transactions sont signées ici.
import fs from 'node:fs';
import { config } from './config.js';
import { getJson } from './data/http.js';

export const SOL_MINT = 'So11111111111111111111111111111111111111112';
let web3;
let keypair;
let conn;

export async function initWallet() {
  web3 = await import('@solana/web3.js');
  const bs58 = (await import('bs58')).default;
  let secret;
  if (config.live.keypairPath) {
    secret = Uint8Array.from(JSON.parse(fs.readFileSync(config.live.keypairPath, 'utf8')));
  } else {
    const raw = config.live.privateKey.trim();
    secret = raw.startsWith('[') ? Uint8Array.from(JSON.parse(raw)) : bs58.decode(raw);
  }
  keypair = web3.Keypair.fromSecretKey(secret);
  conn = new web3.Connection(config.rpcUrl, 'confirmed');
  return keypair.publicKey.toBase58();
}

export async function getSolBalance() {
  return (await conn.getBalance(keypair.publicKey, 'confirmed')) / 1e9;
}

export async function getTokenBalanceRaw(mint) {
  const res = await conn.getParsedTokenAccountsByOwner(keypair.publicKey, { mint: new web3.PublicKey(mint) }, 'confirmed');
  let total = 0n;
  for (const acc of res.value) total += BigInt(acc.account.data.parsed.info.tokenAmount.amount);
  return total;
}

const jupHeaders = () => (config.jupApiKey ? { 'x-api-key': config.jupApiKey } : {});

/** Swap via Jupiter. amount = montant brut (lamports ou unités du token). */
export async function swap({ inputMint, outputMint, amount, slippageBps }) {
  const q = new URLSearchParams({
    inputMint,
    outputMint,
    amount: amount.toString(),
    slippageBps: String(slippageBps ?? config.executor.slippageBps),
    restrictIntermediateTokens: 'true',
  });
  const quote = await getJson(`${config.jupApiUrl}/quote?${q}`, { headers: jupHeaders() });
  if (!quote?.outAmount) throw new Error('Pas de route Jupiter');

  const swapRes = await getJson(`${config.jupApiUrl}/swap`, {
    method: 'POST',
    headers: jupHeaders(),
    retries: 0,
    body: {
      quoteResponse: quote,
      userPublicKey: keypair.publicKey.toBase58(),
      wrapAndUnwrapSol: true,
      dynamicComputeUnitLimit: true,
      prioritizationFeeLamports: {
        priorityLevelWithMaxLamports: { maxLamports: config.executor.maxPriorityLamports, priorityLevel: 'high' },
      },
    },
  });
  if (!swapRes?.swapTransaction) throw new Error('Jupiter n’a pas renvoyé de transaction');

  const tx = web3.VersionedTransaction.deserialize(Buffer.from(swapRes.swapTransaction, 'base64'));
  tx.sign([keypair]);
  const sig = await conn.sendRawTransaction(tx.serialize(), { skipPreflight: true, maxRetries: 3 });
  const conf = await conn.confirmTransaction(
    { signature: sig, blockhash: tx.message.recentBlockhash, lastValidBlockHeight: swapRes.lastValidBlockHeight },
    'confirmed'
  );
  if (conf.value.err) throw new Error(`Transaction échouée ${sig}: ${JSON.stringify(conf.value.err)}`);
  return { sig, inAmount: BigInt(quote.inAmount), outAmount: BigInt(quote.outAmount) };
}
