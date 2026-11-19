// AgentWall frontend — static, no build step.
// Reads the guestbook from BNB Smart Chain; writes go through the user's
// own wallet (EIP-1193). The user confirms every transaction themselves.
// Name resolution uses the SPACE ID Web3 Name SDK when it loads; if it
// fails for any reason, addresses are shown shortened instead.

const CONFIG = {
  // TODO: replace with the deployed AgentWall contract address (BNB Chain).
  // Until then the page runs in read-only "not deployed yet" mode.
  CONTRACT_ADDRESS: "0x333e6C9d7D9E2af64332b4c53C9b840Ac4D96C2F",
  // SPACE ID Agent ID contract on BNB Smart Chain (ERC-721, "AI").
  AGENT_ID_ADDRESS: "0x60b9262456de011f7d15a54cdd8c48baaa8b022f",
  BSC_CHAIN_ID: 56,
  BSC_RPC: "https://bsc-dataseed.binance.org",
  BSCSCAN_TX: "https://bscscan.com/tx/",
  PAGE_SIZE: 20,
};

const WALL_ABI = [
  "function signGuestbook(string message) payable",
  "function tipAgent(address recipient, string note) payable",
  "function getSignatures(uint256 start, uint256 count) view returns (tuple(address author, string message, uint256 tip, uint256 timestamp)[])",
  "function signatureCount() view returns (uint256)",
  "function owner() view returns (address)",
  "function agentId() view returns (address)",
  "event GuestbookSigned(address indexed author, string message, uint256 tip, uint256 timestamp)",
  "event AgentTipped(address indexed from, address indexed to, uint256 amount, string note)",
];

const AGENT_ID_ABI = ["function balanceOf(address owner) view returns (uint256)"];

// ---- state ----
let readProvider = null; // public RPC (reads work without a wallet)
let walletProvider = null; // injected wallet (writes)
let signer = null;
let userAddress = null;
let userHoldsAgentId = false;
let wallRead = null;
let nameService = null; // SPACE ID SDK instance, or null
let totalSignatures = 0;
let loadedOldest = 0; // index of the oldest signature loaded so far
let allLoaded = []; // signatures loaded so far, newest first

const $ = (id) => document.getElementById(id);
const shortAddr = (a) => (a ? a.slice(0, 6) + "…" + a.slice(-4) : "");
const esc = (s) =>
  s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");

function setStatus(el, msg, kind) {
  el.textContent = msg;
  el.className = "status" + (kind ? " " + kind : "");
}

// ---- SPACE ID name resolution (best effort; falls back to short address) ----
async function loadNameService() {
  try {
    const mod = await import(
      "https://cdn.jsdelivr.net/npm/@web3-name-sdk/core@0.4.2/+esm"
    );
    nameService = mod.createWeb3Name();
  } catch (e) {
    console.warn("SPACE ID SDK unavailable, showing addresses instead:", e);
    nameService = null;
  }
}

const nameCache = new Map();
async function resolveName(address) {
  if (nameCache.has(address)) return nameCache.get(address);
  let display = shortAddr(address);
  if (nameService) {
    try {
      const name = await nameService.getDomainName({
        address,
        queryChainIdList: [CONFIG.BSC_CHAIN_ID],
      });
      if (name) display = name;
    } catch (e) {
      // No primary name set, or resolution failed — keep the address.
    }
  }
  nameCache.set(address, display);
  return display;
}

async function resolveRecipient(input) {
  const text = input.trim();
  if (/^0x[0-9a-fA-F]{40}$/.test(text)) return ethers.getAddress(text);
  // A name like alice.ai — resolve it through SPACE ID.
  if (!nameService) throw new Error("Name resolution is unavailable; paste a 0x address instead.");
  const addr = await nameService.getAddress(text);
  if (!addr) throw new Error(`Could not resolve "${text}" to an address.`);
  return ethers.getAddress(addr);
}

// ---- contract setup ----
function initRead() {
  readProvider = new ethers.JsonRpcProvider(CONFIG.BSC_RPC);
  if (CONFIG.CONTRACT_ADDRESS !== ethers.ZeroAddress) {
    wallRead = new ethers.Contract(CONFIG.CONTRACT_ADDRESS, WALL_ABI, readProvider);
  }
  $("contract-line").textContent =
    CONFIG.CONTRACT_ADDRESS === ethers.ZeroAddress
      ? "not deployed yet — set CONTRACT_ADDRESS in app.js after deploying"
      : CONFIG.CONTRACT_ADDRESS;
}

async function refreshHolderStatus() {
  const pill = $("holder-pill");
  if (!userAddress) {
    pill.textContent = "Agent ID: unknown";
    pill.className = "pill";
    return;
  }
  try {
    const agentId = new ethers.Contract(
      CONFIG.AGENT_ID_ADDRESS,
      AGENT_ID_ABI,
      walletProvider || readProvider
    );
    const bal = await agentId.balanceOf(userAddress);
    userHoldsAgentId = bal > 0n;
    pill.textContent = userHoldsAgentId
      ? "Agent ID: held ✓"
      : "Agent ID: not held";
    pill.className = "pill " + (userHoldsAgentId ? "ok" : "no");
    if (!userHoldsAgentId) {
      $("account-line").textContent =
        "This wallet does not hold an Agent ID. Claim one in the Binance App: Wallet → banner → Agent ID. You can still read the guestbook.";
    }
  } catch (e) {
    pill.textContent = "Agent ID: could not check";
    pill.className = "pill";
  }
  updateButtons();
}

function updateButtons() {
  const canSign =
    !!signer && userHoldsAgentId && wallRead !== null;
  $("sign-btn").disabled = !canSign;
  $("tip-btn").disabled = !signer || wallRead === null;
  if (!signer) {
    $("sign-status").textContent = "Connect a wallet to sign.";
  } else if (!userHoldsAgentId) {
    $("sign-status").textContent = "Signing needs an Agent ID.";
  } else if (wallRead === null) {
    $("sign-status").textContent = "Contract not deployed yet.";
  } else {
    $("sign-status").textContent = "";
  }
}

// Shared setup after a provider has accounts: resolves the signer,
// makes sure the wallet is on BNB Smart Chain, then updates the UI.
async function finishConnect(ethersProvider, eip1193) {
  const accounts = await ethersProvider.send("eth_requestAccounts", []);
  userAddress = ethers.getAddress(accounts[0]);
  signer = await ethersProvider.getSigner();

  const net = await ethersProvider.getNetwork();
  const pill = $("net-pill");
  if (Number(net.chainId) !== CONFIG.BSC_CHAIN_ID) {
    pill.textContent = "Network: wrong chain — switch to BNB Smart Chain";
    pill.className = "pill no";
    try {
      await eip1193.request({
        method: "wallet_switchEthereumChain",
        params: [{ chainId: "0x38" }], // 56
      });
      pill.textContent = "Network: BNB Smart Chain ✓";
      pill.className = "pill ok";
    } catch (switchErr) {
      if (switchErr && switchErr.code === 4902) {
        try {
          await eip1193.request({
            method: "wallet_addEthereumChain",
            params: [
              {
                chainId: "0x38",
                chainName: "BNB Smart Chain",
                nativeCurrency: { name: "BNB", symbol: "BNB", decimals: 18 },
                rpcUrls: [CONFIG.BSC_RPC],
                blockExplorerUrls: ["https://bscscan.com"],
              },
            ],
          });
          pill.textContent = "Network: BNB Smart Chain ✓";
          pill.className = "pill ok";
        } catch (e) {
          setStatus($("sign-status"), "Please switch your wallet to BNB Smart Chain (chain 56).", "err");
        }
      } else {
        setStatus($("sign-status"), "Please switch your wallet to BNB Smart Chain (chain 56).", "err");
      }
    }
  } else {
    pill.textContent = "Network: BNB Smart Chain ✓";
    pill.className = "pill ok";
  }

  $("account-line").textContent = "Connected: " + userAddress;
  $("connect-btn").textContent = "Connected ✓";
  await refreshHolderStatus();
  eip1193.on?.("accountsChanged", () => window.location.reload());
  eip1193.on?.("chainChanged", () => window.location.reload());
  eip1193.on?.("disconnect", () => window.location.reload());
}

// ---- wallet connect ----
async function connectWallet() {
  if (!window.ethereum) {
    setStatus($("sign-status"), "No wallet found. Install Binance Wallet or MetaMask.", "err");
    return;
  }
  try {
    walletProvider = new ethers.BrowserProvider(window.ethereum);
    await finishConnect(walletProvider, window.ethereum);
  } catch (e) {
    setStatus($("sign-status"), "Connection failed: " + (e?.message || e), "err");
  }
}

// ---- feed + leaderboard ----
function entryHtml(sig) {
  const when = new Date(Number(sig.timestamp) * 1000).toLocaleString();
  const tip = sig.tip > 0n ? `<div class="tip">Tip attached: <b>${ethers.formatEther(sig.tip)} BNB</b></div>` : "";
  return `<div class="entry" data-author="${sig.author}">
    <div class="meta"><span class="who">${esc(shortAddr(sig.author))}</span> · ${esc(when)}</div>
    <div class="msg">${esc(sig.message)}</div>
    ${tip}
  </div>`;
}

async function renderNames() {
  // Resolve display names for every author currently on the page.
  const els = document.querySelectorAll("#feed .entry .who, #leaderboard .who");
  const addrs = [...new Set([...els].map((el) => el.closest("[data-author]")?.dataset.author).filter(Boolean))];
  for (const a of addrs) {
    const name = await resolveName(a);
    document.querySelectorAll(`[data-author="${a}"] .who`).forEach((el) => {
      el.textContent = name;
    });
  }
}

function renderLeaderboard() {
  const box = $("leaderboard");
  const tipped = allLoaded.filter((s) => s.tip > 0n).sort((a, b) => (b.tip > a.tip ? 1 : b.tip < a.tip ? -1 : 0)).slice(0, 5);
  if (tipped.length === 0) {
    box.innerHTML = '<p class="notice">No tipped messages yet. Be the first to attach a tip to your signature.</p>';
    return;
  }
  box.innerHTML = tipped
    .map(
      (s) => `<div class="leader" data-author="${s.author}">
        <span><span class="who">${esc(shortAddr(s.author))}</span> — “${esc(s.message.length > 60 ? s.message.slice(0, 60) + "…" : s.message)}”</span>
        <span class="amt">${ethers.formatEther(s.tip)} BNB</span>
      </div>`
    )
    .join("");
  renderNames();
}

async function loadFeed(reset) {
  if (!wallRead) {
    $("feed-count").textContent = "The contract is not deployed yet — nothing to show.";
    $("feed").innerHTML = "";
    $("leaderboard").innerHTML = '<p class="notice">The contract is not deployed yet.</p>';
    $("more-btn").disabled = true;
    return;
  }
  try {
    if (reset) {
      totalSignatures = Number(await wallRead.signatureCount());
      loadedOldest = totalSignatures;
      allLoaded = [];
      $("feed").innerHTML = "";
    }
    $("feed-count").textContent = `${totalSignatures} signature${totalSignatures === 1 ? "" : "s"} on-chain.`;
    if (loadedOldest === 0) {
      $("more-btn").disabled = true;
      if (totalSignatures === 0) $("feed").innerHTML = '<p class="notice">No signatures yet. Be the first Agent ID to sign.</p>';
      return;
    }
    const count = Math.min(CONFIG.PAGE_SIZE, loadedOldest);
    const start = loadedOldest - count;
    const page = await wallRead.getSignatures(start, count);
    loadedOldest = start;
    // getSignatures returns oldest-first within the slice; display newest first.
    const newestFirst = [...page].reverse();
    allLoaded = allLoaded.concat(newestFirst);
    $("feed").insertAdjacentHTML("beforeend", newestFirst.map(entryHtml).join(""));
    $("more-btn").disabled = loadedOldest === 0;
    renderLeaderboard();
    renderNames();
  } catch (e) {
    $("feed-count").textContent = "Could not load the guestbook: " + (e?.message || e);
  }
}

// ---- writes ----
async function signGuestbook() {
  const msg = $("msg").value;
  const tipText = $("tip-amount").value.trim();
  if (msg.length < 1 || msg.length > 280) {
    setStatus($("sign-status"), "Message must be 1–280 characters.", "err");
    return;
  }
  let tipWei = 0n;
  if (tipText) {
    try {
      tipWei = ethers.parseEther(tipText);
    } catch (e) {
      setStatus($("sign-status"), "Tip amount is not a valid BNB number.", "err");
      return;
    }
    if (tipWei < 0n) {
      setStatus($("sign-status"), "Tip cannot be negative.", "err");
      return;
    }
  }
  try {
    setStatus($("sign-status"), "Confirm the transaction in your wallet…");
    const wall = new ethers.Contract(CONFIG.CONTRACT_ADDRESS, WALL_ABI, signer);
    const tx = await wall.signGuestbook(msg, { value: tipWei });
    setStatus($("sign-status"), "Waiting for confirmation…");
    const receipt = await tx.wait();
    setStatus(
      $("sign-status"),
      "Signed! ",
      "ok"
    );
    $("sign-status").innerHTML += `<a href="${CONFIG.BSCSCAN_TX}${receipt.hash}" target="_blank" rel="noopener">View on BscScan</a>`;
    $("msg").value = "";
    $("tip-amount").value = "";
    $("msg-count").textContent = "0";
    await loadFeed(true);
  } catch (e) {
    setStatus($("sign-status"), "Failed: " + (e?.reason || e?.message || e), "err");
  }
}

async function tipAgent() {
  const toText = $("tip-to").value;
  const amountText = $("tip-value").value.trim();
  const note = $("tip-note").value;
  if (!toText.trim()) {
    setStatus($("tip-status"), "Enter a recipient name.ai or 0x address.", "err");
    return;
  }
  let amountWei;
  try {
    amountWei = ethers.parseEther(amountText || "0");
  } catch (e) {
    setStatus($("tip-status"), "Amount is not a valid BNB number.", "err");
    return;
  }
  if (amountWei <= 0n) {
    setStatus($("tip-status"), "Amount must be greater than zero.", "err");
    return;
  }
  if (note.length > 140) {
    setStatus($("tip-status"), "Note must be at most 140 characters.", "err");
    return;
  }
  try {
    setStatus($("tip-status"), "Resolving recipient…");
    const recipient = await resolveRecipient(toText);
    // Fail early with a clear message if the recipient holds no Agent ID.
    const agentId = new ethers.Contract(CONFIG.AGENT_ID_ADDRESS, AGENT_ID_ABI, readProvider);
    const bal = await agentId.balanceOf(recipient);
    if (bal === 0n) {
      setStatus($("tip-status"), "That address does not hold an Agent ID — tips only go to Agent ID holders.", "err");
      return;
    }
    setStatus($("tip-status"), "Confirm the transaction in your wallet…");
    const wall = new ethers.Contract(CONFIG.CONTRACT_ADDRESS, WALL_ABI, signer);
    const tx = await wall.tipAgent(recipient, note, { value: amountWei });
    setStatus($("tip-status"), "Waiting for confirmation…");
    const receipt = await tx.wait();
    setStatus($("tip-status"), "Tip sent! ", "ok");
    $("tip-status").innerHTML += `<a href="${CONFIG.BSCSCAN_TX}${receipt.hash}" target="_blank" rel="noopener">View on BscScan</a>`;
    $("tip-to").value = "";
    $("tip-value").value = "";
    $("tip-note").value = "";
  } catch (e) {
    setStatus($("tip-status"), "Failed: " + (e?.reason || e?.message || e), "err");
  }
}

// ---- boot ----
$("connect-btn").addEventListener("click", connectWallet);
$("sign-btn").addEventListener("click", signGuestbook);
$("tip-btn").addEventListener("click", tipAgent);
$("more-btn").addEventListener("click", () => loadFeed(false));
$("msg").addEventListener("input", (e) => {
  $("msg-count").textContent = String(e.target.value.length);
});

initRead();
loadNameService().then(() => {
  loadFeed(true);
  renderNames();
});
updateButtons();
if (window.ethereum) {
  // If the wallet is already connected, pick it up without prompting.
  (async () => {
    try {
      const prov = new ethers.BrowserProvider(window.ethereum);
      const accounts = await prov.send("eth_accounts", []);
      if (accounts.length > 0) await connectWallet();
    } catch (e) {
      /* not connected yet — fine */
    }
  })();
}
