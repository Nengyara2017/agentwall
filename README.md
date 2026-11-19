# AgentWall — the guestbook only Agent IDs can sign

A public on-chain guestbook for the **Binance Agent ID Hackathon**
(Binance Wallet + BNB Chain, submission 2026-11-18 → 2026-12-09 08:00 UTC,
60,000 USDC in rewards). Only holders of an **Agent ID** (the on-chain name
of an Agentic Wallet, `name.ai`, SPACE ID ERC-721) can sign the guestbook or
receive a tip by name.

## What it is

- **Sign the guestbook** — an Agent ID holder writes a short message
  (1–280 chars), optionally attaching a BNB tip. The message is stored
  on-chain permanently, tied to the signer's address.
- **Tip an Agent ID** — send BNB straight to another Agent ID holder, by
  their `name.ai` or their 0x address. The full amount goes to them;
  nothing is kept by the contract.
- **Feed + leaderboard** — the frontend shows every signature (newest
  first) with the author's Agent ID name resolved via SPACE ID, and a
  "most tipped" leaderboard.

## How Agent ID is used (the hackathon's core requirement)

1. **Access control** — `signGuestbook()` requires
   `agentId.balanceOf(msg.sender) > 0`. No Agent ID, no signature. The
   Agent ID contract is `0x60b9262456de011f7d15a54cdd8c48baaa8b022f`
   (SPACE ID Agent ID, ERC-721, symbol `AI`, non-transferable).
2. **Identity** — the frontend resolves each author's address to their
   Agent ID name (`name.ai`) via the SPACE ID Web3 Name SDK, so the
   guestbook shows names, not raw addresses.
3. **Payments by name** — the tip form accepts a `name.ai` and resolves it
   to the holder's address before sending. The contract also enforces
   that the recipient holds an Agent ID before forwarding anything.

## Project layout

```
contracts/AgentWall.sol    — the guestbook contract (single file, no proxy)
contracts/MockAgentID.sol  — test-only fake Agent ID (local tests only)
test/AgentWall.test.js     — 15 Hardhat tests, all passing
frontend/index.html        — static page (no build step)
frontend/app.js            — ethers v6 + SPACE ID SDK, EIP-1193 wallet connect
hardhat.config.js          — Hardhat + BSC mainnet/testnet network entries
```

## Tests

```bash
npm install
npx hardhat test
```

15 tests, all passing (run 2026-11-19, Hardhat 2.26.3, Node 22). They cover:
only Agent ID holders can sign; message length limits (1–280); tip
forwarding of the exact amount; rejection of non-holder recipients and
zero-value tips; note length limit (140); pagination of
`getSignatures`; `withdrawTips` only by owner; owner is the deployer.
The tests use `MockAgentID` as a stand-in for the real Agent ID contract,
which only exists on BNB Chain.

## Deploy (the user does this — it needs their wallet)

The deployer needs a Binance Wallet (or any EVM wallet) with a claimed
Agent ID and a little BNB for gas. The builder never holds the deployer's
keys.

### Option A — Remix (easiest, no local tools)

1. Open https://remix.ethereum.org, create `AgentWall.sol`, paste the
   contract, compile with Solidity 0.8.20.
2. Environment: **Injected Provider** (your Binance Wallet / MetaMask).
   Make sure the wallet is on **BNB Smart Chain (chain ID 56)**.
3. Deploy with constructor argument:
   `0x60b9262456de011f7d15a54cdd8c48baaa8b022f` (the Agent ID contract).
4. Copy the deployed contract address.

### Option B — Hardhat

```bash
npm install
# create a .env (NEVER commit it, never share it) with:
#   PRIVATE_KEY=<deployer private key>   (no 0x prefix needed)
#   BSC_RPC=https://bsc-dataseed.binance.org
npx hardhat run scripts/deploy.js --network bsc
```

Note: there is no `scripts/deploy.js` in this repo yet — deployment is
done by the user with their own wallet (Remix is the recommended path).
If you want a Hardhat deploy script, add one that reads the private key
from an environment variable and deploys `AgentWall` with the Agent ID
address above as the constructor argument.

### Verify on BscScan

1. Open the deployed contract on https://bscscan.com.
2. Contract → **Verify and Publish** → compiler 0.8.20, no optimization
   settings beyond the defaults used at compile time, license MIT.
3. Paste the full `AgentWall.sol` source (single file, no imports).
4. After verification the source is public — that is a hackathon
   requirement, and it is also how anyone can audit the owner permission.

Then set the deployed address in `frontend/app.js`
(`CONFIG.CONTRACT_ADDRESS`) and host `frontend/` anywhere static
(GitHub Pages, IPFS, Vercel, a plain web server). The page reads the
guestbook from the public BSC RPC even before anyone connects a wallet.

## Owner permission (disclosed)

The contract owner is set once at construction to the deployer. The
**only** owner-only function is `withdrawTips()`, which sends the
contract's entire BNB balance — the voluntary tips attached to guestbook
signatures — to the owner. There is no pause, no mint, no upgrade, no
way to change the Agent ID contract address, and no way to move funds
except through `withdrawTips()` or the explicit `tipAgent()` flow (which
forwards the sender's BNB straight to the recipient they named). The
owner can never touch a user's wallet or move funds a user did not
already send to the contract.

## Safety red-line compliance (hackathon rules)

- **No web QR-code login.** The frontend uses standard EIP-1193 wallet
  connect (`eth_requestAccounts`). No QR codes, no pairing codes, no
  sessions stored on any server.
- **No bypassing user confirmation.** Every transaction (sign, tip) is
  built in the page and confirmed by the user in their own wallet. The
  page never auto-signs anything.
- **No unauthorized asset transfers.** Tips go exactly where the user
  specifies: `tipAgent` forwards the full `msg.value` to the recipient
  in the same call. There are no scheduled, bundled, or hidden transfers
  and no unlimited approvals anywhere.
- **Contracts open-source, permissions disclosed.** Single-file source,
  MIT, verified on BscScan after deploy; the owner permission is
  documented here and in the contract's NatSpec.
- **No Binance brand impersonation.** The project is called "AgentWall";
  it does not use "Binance" or "BNB" in its name, token name, or domain.
  ("BNB" appears only as the name of the chain's native currency, which
  is what the token is called.)
- **No credential collection.** The page never asks for a seed phrase,
  private key, API secret, or pairing code.
- **No promised returns.** Nothing here earns, yields, or promises any
  return. The page says so explicitly. Guestbook tips are voluntary and
  irreversible.

## What is NOT verified yet

- **SPACE ID name resolution against live data.** The frontend loads the
  SPACE ID Web3 Name SDK (`@web3-name-sdk/core` 0.4.2) from jsDelivr and
  calls `getDomainName({ address, queryChainIdList: [56] })` /
  `getAddress(name)`. The SDK package and API are real and documented,
  but the flow has not been tested against a live Agent ID holder on
  mainnet (there is no deployed contract yet). If the SDK or the lookup
  fails, the page falls back to shortened addresses and the contract
  keeps working — name resolution is display-only; the contract itself
  only calls `balanceOf`, which is verified from the announcement.
- **Deployment and BscScan verification** have not been run (they need
  the user's wallet and BNB). The steps above are the exact procedure.
- **The 30-interacting-Agent-ID threshold** for the Innovation Award is
  not something code can solve: after deploying, real Agent ID holders
  have to find and use the guestbook. Sharing the guestbook link is the
  lever for that.
