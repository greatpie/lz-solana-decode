#!/usr/bin/env -S node --no-warnings
import { Connection, PublicKey } from "@solana/web3.js";

const RPC = "https://api.mainnet-beta.solana.com";
const PROGRAM_ID = new PublicKey("YALAoTj27wZ1vsu8V8kbk79Dupx6a7ubQFKMfciYKh8");

// 常见主网 EID（可自行增补）：
const CANDIDATE_EIDS = [
  30101, // Ethereum
  30102, // BNB
  30106, // Avalanche
  30109, // Polygon
  30110, // Arbitrum
  30111, // Optimism
  30145, // Base
  30168, // Solana（用于对照；这里反解 Polygon->Solana 的 Peer 仍以 Polygon EID 为准）
  30184, // Linea / zk 生态之一
];

const hex = (u: Uint8Array) => "0x" + Buffer.from(u).toString("hex");
const bytes32ToEvm = (b32: Uint8Array) => "0x" + Buffer.from(b32.slice(12)).toString("hex");
const u32LE = (n: number) => { const b = Buffer.alloc(4); b.writeUInt32LE(n); return b; };
const u32BE = (n: number) => { const b = Buffer.alloc(4); b.writeUInt32BE(n); return b; };

async function deriveStorePda(programId: PublicKey) {
  const [pda] = PublicKey.findProgramAddressSync([Buffer.from("Store")], programId);
  return pda;
}

function peerPdaFor(programId: PublicKey, store: PublicKey, eid: number, endian: "LE"|"BE") {
  const seedEid = endian === "LE" ? u32LE(eid) : u32BE(eid);
  const [pda] = PublicKey.findProgramAddressSync(
    [Buffer.from("Peer"), store.toBuffer(), seedEid],
    programId
  );
  return pda;
}

async function main() {
  const conn = new Connection(RPC, { commitment: "confirmed" });
  const storePda = await deriveStorePda(PROGRAM_ID);

  // 1) 拉所有 program-owned accounts
  const accs = await conn.getProgramAccounts(PROGRAM_ID, { commitment: "confirmed" });

  // 2) 根据你扫描的特征：dataLen=1654、且同一个 discriminator（我们直接用长度判定）
  const candidates = accs.filter(a => a.account.data.length === 1654);

  if (candidates.length === 0) {
    console.log("No 1654-byte accounts found; program may not be the expected OFT or layout differs.");
    return;
  }

  // 3) 精确从 offset=8 读取 peer(bytes32)（你样本里 peer 就在这里）
  const rows = candidates.map(({ pubkey, account }) => {
    const data = account.data;
    const peerB32 = data.subarray(8, 8 + 32);
    const peerEvm = bytes32ToEvm(peerB32);
    return {
      acc: pubkey,
      dataLen: data.length,
      peerBytes32: hex(peerB32),
      peerEvm,
    };
  });

  // 4) 反解每个账户属于哪个 EID（用 PDA 等式匹配）
  //    同时记录大小端（LE/BE）
  const resolved: Array<{eid:number; endian:"LE"|"BE"; acc: string; peerEvm: string; peerBytes32: string}> = [];
  for (const r of rows) {
    let matched = false;
    for (const eid of CANDIDATE_EIDS) {
      const pLE = peerPdaFor(PROGRAM_ID, storePda, eid, "LE");
      const pBE = peerPdaFor(PROGRAM_ID, storePda, eid, "BE");
      if (pLE.equals(r.acc)) { resolved.push({ eid, endian: "LE", acc: r.acc.toBase58(), peerEvm: r.peerEvm, peerBytes32: r.peerBytes32 }); matched = true; break; }
      if (pBE.equals(r.acc)) { resolved.push({ eid, endian: "BE", acc: r.acc.toBase58(), peerEvm: r.peerEvm, peerBytes32: r.peerBytes32 }); matched = true; break; }
    }
    if (!matched) {
      // 没在候选表里：可以打印出来手动加 EID
      resolved.push({ eid: -1 as any, endian: "LE", acc: r.acc.toBase58(), peerEvm: r.peerEvm, peerBytes32: r.peerBytes32 });
    }
  }

  // 输出
  console.log("Store PDA :", storePda.toBase58());
  console.log("Accounts (len=1654) =", rows.length);
  console.log("\nEID → Peer map:");
  for (const x of resolved.sort((a,b)=>a.eid-b.eid)) {
    const tag = x.eid === -1 ? "UNKNOWN_EID" : x.eid;
    console.log(` - EID=${tag} (${x.endian})  ACC=${x.acc}  PEER=${x.peerEvm}  B32=${x.peerBytes32}`);
  }
}

main().catch(e => { console.error(e?.stack || e?.message || e); process.exit(1); });
