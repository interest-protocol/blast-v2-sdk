import assert from "node:assert/strict";
import test from "node:test";

import {
  moveTypeNameBcs,
  suiBalanceBcs,
  suiIdBcs,
  suiObjectIdBcs,
  suiUidBcs,
} from "@interest-protocol/blast-core/bcs";

test("round-trips canonical Sui BCS primitives", () => {
  assert.match(
    suiIdBcs.parse(suiIdBcs.serialize({ bytes: "0xc" }).toBytes()).bytes,
    /0c$/,
  );
  assert.match(
    suiUidBcs.parse(suiUidBcs.serialize({ id: { bytes: "0xd" } }).toBytes()).id
      .bytes,
    /0d$/,
  );
  assert.equal(
    suiBalanceBcs.parse(suiBalanceBcs.serialize({ value: 7n }).toBytes()).value,
    "7",
  );
  assert.match(
    suiObjectIdBcs.parse(suiObjectIdBcs.serialize("0xe").toBytes()),
    /0e$/,
  );
  assert.equal(
    moveTypeNameBcs.parse(moveTypeNameBcs.serialize("0x2::sui::SUI").toBytes()),
    "0x0000000000000000000000000000000000000000000000000000000000000002::sui::SUI",
  );
});
