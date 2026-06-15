// Test helper (run via bun): build a fixture db.
//   bun _mkfixture.ts lain  <path>   → a real lain exploration db
//   bun _mkfixture.ts other <path>   → an unrelated sqlite db (one "peers" table)
import { Storage, Graph } from "@lain/core";
import { Database } from "bun:sqlite";

const kind = process.argv[2];
const target = process.argv[3];

if (kind === "lain") {
  const s = new Storage(target);
  new Graph(s).createExploration({
    id: "fx", name: "fixture exploration", seed: "fixture exploration",
    n: 1, m: 1, strategy: "bf", planDetail: "sentence", extension: "freeform",
  });
  s.close();
} else {
  const d = new Database(target, { create: true });
  d.run("CREATE TABLE peers (id TEXT)");
  d.close();
}
