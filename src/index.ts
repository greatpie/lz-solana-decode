#!/usr/bin/env -S node --no-warnings
import { Connection, PublicKey, type AccountInfo } from "@solana/web3.js";

// ---------- CLI ----------
type Args = {
  rpc: string;
  program: string;
  eid?: number;
  list?: boolean;
  eidlist?: string;
  json?: boolean;
};

function parseArgs(): Args {
  const a = process.argv.slice(2);
  const m = new Map<string, string>(); // 统一收集为字符串，避免 undefined

  for (let i = 0; i < a.length; i++) {
    const arg = a[i];
    if (!arg.startsWith("--")) continue;

    const key = arg.slice(2);
    const hasNext = i + 1 < a.length;
    const next = hasNext ? a[i + 1] : undefined;

    // 如果下一个是值（不是下一个开关），用它；否则把 "true" 作为字符串存进去
    if (next && !next.startsWith("--")) {
      m.set(key, next);
      i++; // 消耗掉值
    } else {
      m.set(key, "true");
    }
  }

  const program = m.get("program") ?? "";
  if (!program) {
    console.error(
      'Usage: tsx src/index.ts --program <OFT_PROGRAM_ID> [--eid 30109] [--list] [--eidlist "30109,30168,..."] [--rpc <URL>] [--json]'
    );
    process.exit(1);
  }

  const eidStr = m.get("eid");
  const eid = eidStr != null ? parseInt(eidStr, 10) : undefined;

  return {
    rpc: m.get("rpc") ?? "https://api.mainnet-beta.solana.com",
    program,
    eid: Number.isFinite(eid as number) ? (eid as number) : undefined,
    list: (m.get("list") ?? "false") === "true",
    eidlist: m.get("eidlist") ?? undefined,
    json: (m.get("json") ?? "false") === "true",
  };
}

// ---------- utils ----------
const toB58 = (k?: PublicKey | null) => (k ? k.toBase58() : null);
const hex = (u: Uint8Array) => "0x" + Buffer.from(u).toString("hex");
const u32LE = (n: number) => {
  const b = Buffer.alloc(4);
  b.writeUInt32LE(n);
  return b;
};
const u32BE = (n: number) => {
  const b = Buffer.alloc(4);
  b.writeUInt32BE(n);
  return b;
};
const bytes32ToEvm = (b32: Uint8Array) =>
  "0x" + Buffer.from(b32.slice(12)).toString("hex");

function extractPeerBytes32(data: Buffer): Uint8Array | null {
  // 寻找 bytes32(EVM地址)：前12字节全0，后20字节非全0
  for (let off = 0; off + 32 <= data.length; off++) {
    const s = data.subarray(off, off + 32);
    const headZeros = s.subarray(0, 12).every((b) => b === 0);
    const tailAllZero = s.subarray(12).every((b) => b === 0);
    if (headZeros && !tailAllZero) return new Uint8Array(s);
  }
  return null;
}

async function deriveStorePda(programId: PublicKey) {
  const [pda] = PublicKey.findProgramAddressSync(
    [Buffer.from("Store")],
    programId
  );
  return pda;
}

type Endian = "LE" | "BE" | null;

async function derivePeerPda(
  programId: PublicKey,
  store: PublicKey,
  eid: number,
  conn: Connection
): Promise<{
  pda: PublicKey | null;
  ai: AccountInfo<Buffer> | null;
  endian: Endian;
}> {
  const [pLE] = PublicKey.findProgramAddressSync(
    [Buffer.from("Peer"), store.toBuffer(), u32LE(eid)],
    programId
  );
  const [pBE] = PublicKey.findProgramAddressSync(
    [Buffer.from("Peer"), store.toBuffer(), u32BE(eid)],
    programId
  );

  const aiLE = await conn.getAccountInfo(pLE);
  if (aiLE) return { pda: pLE, ai: aiLE, endian: "LE" };

  const aiBE = await conn.getAccountInfo(pBE);
  if (aiBE) return { pda: pBE, ai: aiBE, endian: "BE" };

  return { pda: null, ai: null, endian: null };
}

// ---------- main ----------
async function main() {
  const args = parseArgs();
  const conn = new Connection(args.rpc, { commitment: "confirmed" });
  const programId = new PublicKey(args.program);

  const storePda = await deriveStorePda(programId);
  const storeAi = await conn.getAccountInfo(storePda);

  async function readOne(eid: number) {
    const peer = await derivePeerPda(programId, storePda, eid, conn);
    let peerB32: Uint8Array | null = null;
    let peerEvm: string | null = null;
    if (peer.ai?.data) {
      peerB32 = extractPeerBytes32(peer.ai.data);
      if (peerB32) peerEvm = bytes32ToEvm(peerB32);
    }
    return {
      eid,
      peerPda: toB58(peer.pda),
      exists: !!peer.ai,
      endian: peer.endian,
      bytes32: peerB32 ? hex(peerB32) : null,
      evm: peerEvm,
    };
  }

  if (!args.list) {
    const eid = args.eid ?? 30109; // 默认 Polygon
    const row = await readOne(eid);
    const out = {
      rpc: args.rpc,
      programId: programId.toBase58(),
      storePda: toB58(storePda),
      storeExists: !!storeAi,
      storeOwner: storeAi ? storeAi.owner.toBase58() : null,
      peer: row,
    };
    if (args.json) {
      console.log(JSON.stringify(out, null, 2));
    } else {
      console.log("RPC         :", out.rpc);
      console.log("Program     :", out.programId);
      console.log(
        "Store PDA   :",
        out.storePda,
        "exists =",
        out.storeExists,
        "owner =",
        out.storeOwner
      );
      console.log(
        `Peer EID=${row.eid}  exists=${row.exists}  seed=${row.endian}  PDA=${row.peerPda}`
      );
      console.log("peer(bytes32):", row.bytes32);
      console.log("peer(EVM)   :", row.evm);
    }
    return;
  }

  // 批量（默认常见主网 EID，可用 --eidlist 覆盖）
  const eids =
    args.eidlist
      ?.split(",")
      .map((s) => parseInt(s.trim(), 10))
      .filter((n) => Number.isFinite(n)) ||
    [30101, 30102, 30106, 30109, 30110, 30111, 30145, 30168, 30184];

  const rows = [];
  for (const eid of eids) {
    try {
      const r = await readOne(eid);
      if (r.exists) rows.push(r);
    } catch {
      // 忽略单项错误继续
    }
  }

  const out = {
    rpc: args.rpc,
    programId: programId.toBase58(),
    storePda: toB58(storePda),
    storeExists: !!storeAi,
    storeOwner: storeAi ? storeAi.owner.toBase58() : null,
    peersFound: rows.length,
    peers: rows.sort((a, b) => a.eid - b.eid),
  };

  if (args.json) {
    console.log(JSON.stringify(out, null, 2));
  } else {
    console.log("RPC       :", out.rpc);
    console.log("Program   :", out.programId);
    console.log(
      "Store PDA :",
      out.storePda,
      "exists =",
      out.storeExists,
      "owner =",
      out.storeOwner
    );
    console.log("Peers     :", out.peersFound);
    for (const r of out.peers) {
      console.log(
        ` - EID=${r.eid} (${r.endian})  PDA=${r.peerPda}  EVM=${r.evm}  bytes32=${r.bytes32}`
      );
    }
  }
}

main().catch((e) => {
  console.error(e?.message || e);
  process.exit(1);
});
