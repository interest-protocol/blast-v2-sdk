import assert from "node:assert/strict";
import test from "node:test";
import {
  admissionRunbook,
  defineBlastDeployment,
} from "@interest-protocol/blast-deployments-sdk";
import type { Transaction } from "@mysten/sui/transactions";
import { normalizeStructTag, normalizeSuiObjectId } from "@mysten/sui/utils";
import { NON_PRODUCTION_MANIFEST } from "./fixtures/non-production-deployment.ts";
import { manifestWithVenues } from "./fixtures/venue-deployment.ts";

const ADMIN_CAP = normalizeSuiObjectId("0xadc");
const OPTIONS = {
  launchpad: {},
  launchpadNotices: {},
  presale: {},
  presaleNotices: {},
  witnessDelayMs: 172_800_000n,
};

const original = (name: keyof typeof NON_PRODUCTION_MANIFEST.packages) =>
  normalizeSuiObjectId(
    NON_PRODUCTION_MANIFEST.packages[name].originalPackageId,
  );
const type = (
  name: keyof typeof NON_PRODUCTION_MANIFEST.packages,
  path: string,
) => normalizeStructTag(`${original(name)}::${path}`);

/** Each MoveCall as `module::function`, with its type arguments. */
function calls(tx: Transaction) {
  return tx.getData().commands.flatMap((command) =>
    command.MoveCall
      ? [
          {
            call: `${command.MoveCall.module}::${command.MoveCall.function}`,
            typeArguments: command.MoveCall.typeArguments.map((argument) =>
              normalizeStructTag(argument),
            ),
          },
        ]
      : [],
  );
}

test("the admission runbook follows the contracts' four paused steps in order", () => {
  const deployment = defineBlastDeployment(NON_PRODUCTION_MANIFEST);
  const steps = admissionRunbook(deployment, ADMIN_CAP, OPTIONS);
  assert.equal(steps.length, 9);
  const [
    witnesses,
    launchpadSettings,
    presaleSettings,
    witnessNotice,
    ,
    ,
    vault,
    launchpad,
    presale,
  ] = steps.map(calls);
  const venueAdmin = type("core", "blast_domain::VenueAdmin");
  const venueTypes = [
    type("migrators", "bluefin::Venue"),
    type("migrators", "cetus::Venue"),
  ];

  // 1. The vault registry admits both package witnesses and both venues at notice zero.
  assert.deepEqual(witnesses?.[0], {
    call: "blast_acl::sign_in",
    typeArguments: [venueAdmin],
  });
  const admitted = [
    type("launchpad", "blast_fun::PackageWitness"),
    type("presale", "blast_presale_package::PackageWitness"),
    ...venueTypes,
  ];
  assert.deepEqual(
    witnesses?.slice(1),
    admitted.flatMap((witness) => [
      {
        call: "blast_vault_package::schedule_witness",
        typeArguments: [witness],
      },
      { call: "blast_vault_package::apply_witness", typeArguments: [witness] },
    ]),
  );

  // 2. Each product's configureNow admits the migrators venues; no vendor is recorded.
  for (const [settings, module] of [
    [launchpadSettings, "launch_config"],
    [presaleSettings, "creation_policy"],
  ] as const) {
    assert.deepEqual(settings, [
      { call: "blast_acl::sign_in", typeArguments: [venueAdmin] },
      ...venueTypes.flatMap((venue) => [
        { call: `${module}::schedule_venue`, typeArguments: [venue] },
        { call: `${module}::apply_venue`, typeArguments: [venue] },
      ]),
    ]);
  }

  // 3. The vault's witness notice is raised.
  assert.deepEqual(
    witnessNotice?.map(({ call }) => call),
    [
      "blast_acl::sign_in",
      "blast_vault_package::schedule_witness_delay",
      "blast_vault_package::apply_witness_delay",
    ],
  );

  // 4. The vault, then each product, unpauses with its package's UnpauseAdmin.
  const unpauseAdmin = (otw: string) =>
    normalizeStructTag(
      `${original("admin")}::package_admin::UnpauseAdmin<${otw}>`,
    );
  for (const [step, otw, call] of [
    [
      vault,
      type("vault", "blast_vault_package::BLAST_VAULT_PACKAGE"),
      "blast_vault_package::unpause",
    ],
    [
      launchpad,
      type("launchpad", "blast_fun::BLAST_FUN"),
      "launch_config::unpause",
    ],
    [
      presale,
      type("presale", "blast_presale_package::BLAST_PRESALE_PACKAGE"),
      "creation_policy::unpause",
    ],
  ] as const) {
    assert.deepEqual(step, [
      { call: "blast_acl::sign_in", typeArguments: [unpauseAdmin(otw)] },
      { call, typeArguments: [] },
    ]);
  }
});

test("the presale also admits the vendor venue when the manifest records it", () => {
  const deployment = defineBlastDeployment(
    manifestWithVenues(["aftermathDao"]),
  );
  const [witnesses, , venues] = admissionRunbook(
    deployment,
    ADMIN_CAP,
    OPTIONS,
  ).map(calls);
  // The vendor creates no vault, so the registry never lists it.
  assert.equal(witnesses?.length, 1 + 4 * 2);
  const vendor = normalizeStructTag(
    `${normalizeSuiObjectId(deployment.packages.aftermathDaoPresale!.originalPackageId)}::blast_aftermath_dao_presale::Venue`,
  );
  assert.deepEqual(venues?.slice(-2), [
    { call: "creation_policy::schedule_venue", typeArguments: [vendor] },
    { call: "creation_policy::apply_venue", typeArguments: [vendor] },
  ]);
});
