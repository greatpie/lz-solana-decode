#!/usr/bin/env -S node --no-warnings
import { Connection, PublicKey } from "@solana/web3.js";

/**
 * 硬编码：OFT Program（你给的）
 */
const PROGRAM_ID = new PublicKey("YALAoTj27wZ1vsu8V8kbk79Dupx6a7ubQFKMfciYKh8");

/**
 * 可改：RPC
 */
const RPC = "https://api.mainnet-beta.solana.com";

/** 工具函数 */
const hex = (u: Uint8Array) => "0x" + Buffer.from(u).toString("hex");
const short = (s: string) => s.slice(0, 6) + "..." + s.slice(-6);

/** 判断切片是否可能是 bytes32(EVM address) */
function looksLikeBytes32EvmAddress(slice32: Uint8Array): boolean {
  if (slice32.length !== 32) return false;
  // 前 12 字节全 0
  for (let i = 0; i < 12; i++) if (slice32[i] !== 0) return false;
  // 后 20 字节不全 0
  let allZero = true;
  for (let i = 12; i < 32; i++) if (slice32[i] !== 0) { allZero = false; break; }
  return !allZero;
}

/** bytes32 -> 20B EVM 地址（lowercase，带 0x） */
function bytes32ToEvm(slice32: Uint8Array): string {
  return "0x" + Buffer.from(slice32.slice(12)).toString("hex");
}

/** 提取账户数据中所有可能的 bytes32(EVM) 及其偏移 */
function extractAllEvmPeers(data: Buffer): { off: number; b32: string; evm: string }[] {
  const out: { off: number; b32: string; evm: string }[] = [];
  for (let off = 0; off + 32 <= data.length; off++) {
    const s = data.subarray(off, off + 32);
    if (looksLikeBytes32EvmAddress(s)) {
      const b32 = hex(s);
      const evm = bytes32ToEvm(s);
      // 去重：同一地址多次命中时只保留第一次
      if (!out.find((x) => x.evm === evm)) out.push({ off, b32, evm });
    }
  }
  return out;
}

/** 取 Anchor discriminator（前 8 字节），仅用作分组标签 */
function discriminatorOf(data: Buffer | null | undefined): string | null {
  if (!data || data.length < 8) return null;
  return hex(data.subarray(0, 8));
}

async function main() {
  const conn = new Connection(RPC, { commitment: "confirmed" });

  console.log("RPC      :", RPC);
  console.log("Program  :", PROGRAM_ID.toBase58());
  console.log("Fetching program accounts...");

  const accs = await conn.getProgramAccounts(PROGRAM_ID, {
    // dataSlice: { offset: 0, length: 0 }, // 如需只拿 meta，可启用
    commitment: "confirmed",
  });

  console.log("Total accounts owned by program:", accs.length);

  // 先按 discriminator 分组，便于粗定位账户类型
  const groups = new Map<string, typeof accs>();
  for (const a of accs) {
    const disc = discriminatorOf(a.account.data) ?? "no-disc";
    if (!groups.has(disc)) groups.set(disc, []);
    groups.get(disc)!.push(a);
  }

  // 打印各组概览
  console.log("\n== Discriminator groups ==");
  for (const [disc, list] of groups.entries()) {
    const sizes = Array.from(new Set(list.map((x) => x.account.data.length))).sort((a, b) => a - b);
    console.log(
      ` - disc=${disc}  count=${list.length}  dataLens=${sizes.join(",")}`
    );
  }

  // 逐账户扫描潜在 peer
  const peerRows: Array<{
    pubkey: string;
    dataLen: number;
    disc: string | null;
    peers: { off: number; evm: string; b32: string }[];
  }> = [];

  for (const { pubkey, account } of accs) {
    const data = account.data;
    const peers = extractAllEvmPeers(data);
    if (peers.length > 0) {
      peerRows.push({
        pubkey: pubkey.toBase58(),
        dataLen: data.length,
        disc: discriminatorOf(data),
        peers: peers.map((p) => ({ off: p.off, evm: p.evm, b32: p.b32 })),
      });
    }
  }

  // 汇总与打印
  console.log("\n== Candidate peers (bytes32(EVM) found) ==");
  if (peerRows.length === 0) {
    console.log("No bytes32(EVM) patterns found in program-owned accounts.");
  } else {
    for (const row of peerRows.sort((a, b) => a.dataLen - b.dataLen)) {
      console.log(
        `• ${short(row.pubkey)}  len=${row.dataLen}  disc=${row.disc}  peers=${row.peers.length}`
      );
      for (const p of row.peers) {
        console.log(`    - off=${p.off.toString().padStart(5)}  evm=${p.evm}  b32=${p.b32}`);
      }
    }
  }

  // 如果你想把结果写成 JSON，取消下面注释：
  // import { writeFileSync } from "fs";
  // const out = {
  //   rpc: RPC,
  //   programId: PROGRAM_ID.toBase58(),
  //   totalAccounts: accs.length,
  //   groups: Array.from(groups.entries()).map(([disc, list]) => ({
  //     disc, count: list.length, sizes: Array.from(new Set(list.map(x => x.account.data.length))).sort((a,b)=>a-b)
  //   })),
  //   candidates: peerRows,
  // };
  // writeFileSync("scan-output.json", JSON.stringify(out, null, 2));
  // console.log('\nWrote scan-output.json');
}

main().catch((e) => {
  console.error(e?.stack || e?.message || e);
  process.exit(1);
});
