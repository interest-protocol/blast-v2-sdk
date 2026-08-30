import assert from "node:assert/strict";
import test from "node:test";

import {
  moveTypeNameBcs,
  suiBalanceBcs,
  suiIdBcs,
  suiUidBcs,
} from "../src/lib/bcs.ts";

test("round-trips canonical Sui BCS primitives", () => {
  assert.match(suiIdBcs.parse(suiIdBcs.serialize("0xc").toBytes()), /0c$/);
  assert.match(
    suiUidBcs.parse(suiUidBcs.serialize({ id: "0xd" }).toBytes()).id,
    /0d$/,
  );
  assert.equal(
    suiBalanceBcs.parse(suiBalanceBcs.serialize({ value: 7n }).toBytes()).value,
    7n,
  );
  assert.equal(
    moveTypeNameBcs.parse(moveTypeNameBcs.serialize("0x2::sui::SUI").toBytes()),
    "0x0000000000000000000000000000000000000000000000000000000000000002::sui::SUI",
  );
});
