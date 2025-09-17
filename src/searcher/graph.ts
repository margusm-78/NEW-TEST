import { Pool } from "./univ3";
export type Edge = { pool: Pool; direction: "token0->token1" | "token1->token0" };
export type Route = { edges: Edge[]; description: string };

export function buildTwoPoolLoop(p0: Pool, p1: Pool): Route[] {
  return [
    { edges: [{ pool: p0, direction: "token0->token1" }, { pool: p1, direction: "token1->token0" }], description: `${p0.name} -> ${p1.name}` },
    { edges: [{ pool: p1, direction: "token0->token1" }, { pool: p0, direction: "token1->token0" }], description: `${p1.name} -> ${p0.name}` }
  ];
}
