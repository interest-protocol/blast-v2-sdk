import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Every artifact is frozen at the contracts commit the next releases follow;
 * refreeze at contracts main with `check:abi:write` for an approved change,
 * and keep CI's checkout (`.github/workflows/check.yml`) on the same commit.
 */
const BASELINE_COMMIT = "86ee8cf9df8e9b2ec920f9564e2fda8afbf82106";
const BASELINE = {
  contractsCommit: BASELINE_COMMIT,
  workingTreeDifferedAtFreeze: false,
};
/** blast_sui and boosts adopt the generic administration separately; their artifacts stay frozen here. */
const BLAST_SUI_BOOSTS_BASELINE = {
  contractsCommit: "01d7659617abcd552cece6d05b9db409ec4ff2c0",
  workingTreeDifferedAtFreeze: false,
};
const LAUNCH_STACK_FREEZE =
  "contracts ADR 0137 (amended 2026-11-05) and PRs #178-#215: the fresh one-way launch stack, first freeze";
const DEEP_REVIEW_FIXES =
  "contracts #217: every product's unpause also requires the core Treasury guarded; MigrationAllocationPaid names its vesting schedules; venue auto-LP compounding moves to compound_auto_lp";
const SEALED_TREASURY_CAPS =
  "contracts ADR 0138 (PR #219): a generated coin's TreasuryCap is sealed under its product in blast_core::sealed_treasury_cap::SealedTreasuryCap; launch_ticket::new and the new blast_presale::sale_token::new return the sealed cap, launch::new and blast_presale::new open it, launch_config::venue_admission and creation_policy::venue_admission issue the VenueAdmission cetus::prepare takes with &mut SealedTreasuryCap, bluefin::prepare takes &SealedTreasuryCap, and presale_coin_template is the presale's generated sale-token package";
const sdkRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const artifactDeclarations = [
  {
    path: "production-admin-v1.json",
    approvedAbiAmendments: [
      LAUNCH_STACK_FREEZE,
      "contracts #179, #199 and #211: generic package_version::PackageVersion<OTW> and package_admin::PackageAdmin<OTW> replace upgrade_custody and operational_version",
      "contracts #220: delayed::Deadline holds a pending admission's or entry change's fixed deadline; PendingDelay is only a proposed next delay",
    ],
    packages: [["admin", "admin", "blast_admin"]],
  },
  {
    path: "production-partners-v1.json",
    approvedAbiAmendments: [
      LAUNCH_STACK_FREEZE,
      "contracts #198 and #208: partner_list::PartnerList and the Partner readiness readers",
    ],
    packages: [["partners", "partners", "blast_partners"]],
  },
  {
    path: "production-core-v1.json",
    approvedAbiAmendments: [LAUNCH_STACK_FREEZE, SEALED_TREASURY_CAPS],
    packages: [["core", "core", "blast_core"]],
  },
  {
    path: "production-vault-v1.json",
    approvedAbiAmendments: [LAUNCH_STACK_FREEZE, DEEP_REVIEW_FIXES],
    packages: [["vault", "vault", "blast_vault"]],
  },
  {
    path: "production-migrators-v1.json",
    approvedAbiAmendments: [
      LAUNCH_STACK_FREEZE,
      "contracts #200: one product-agnostic blast_migrators venue package for launches and presales",
      DEEP_REVIEW_FIXES,
      SEALED_TREASURY_CAPS,
      "contracts #225: canonical auto-LP compounding checks the venue price and bounds spent liquidity",
    ],
    packages: [["migrators", "migrators", "blast_migrators"]],
  },
  {
    path: "production-launchpad-v1.json",
    approvedAbiAmendments: [
      LAUNCH_STACK_FREEZE,
      "contracts #204: launch::migrate returns a Migration for the venue's migrate; generic administration, core roles and the core Treasury ledger",
      DEEP_REVIEW_FIXES,
      SEALED_TREASURY_CAPS,
    ],
    packages: [
      ["launchpad", "launchpad", "blast_fun"],
      [
        "launchTicketTemplate",
        "launch_ticket_template",
        "launch_ticket_template",
      ],
      ["coinTemplate", "coin_template", "coin_template"],
    ],
  },
  {
    path: "production-presale-v1.json",
    approvedAbiAmendments: [
      LAUNCH_STACK_FREEZE,
      "contracts #202: blast_presale::migrate returns a Migration for the venue's migrate; the presale's own venues, vault and rewards are removed",
      DEEP_REVIEW_FIXES,
      SEALED_TREASURY_CAPS,
    ],
    packages: [
      ["presale", "presale", "blast_presale"],
      ["presaleCoinTemplate", "presale_coin_template", "presale_coin_template"],
    ],
  },
  {
    path: "production-aftermath-dao-presale-v1.json",
    approvedAbiAmendments: [
      LAUNCH_STACK_FREEZE,
      "contracts #200: the vendor is a plain venue over blast_core (prepare, migrate)",
    ],
    packages: [
      [
        "aftermathDaoPresale",
        "vendors/aftermath_dao_presale",
        "blast_aftermath_dao_presale",
      ],
    ],
  },
  {
    path: "production-blast-sui-v1.json",
    baseline: BLAST_SUI_BOOSTS_BASELINE,
    packages: [["blastSui", "blast_sui", "blast_sui"]],
    approvedAbiAmendments: [
      "contracts ADR 0059: remove sender and unchanged state from event payloads",
      "contracts ADR 0060: retain both currency metadata caps and the receipt-display cap in PackageAdmin custody",
      "contracts ADR 0061: restore routine AdminCap authorization and composable PackageAdmin custody",
      "contracts ADR 0065: retain discoverable TreasuryCap child objects under Vault custody",
      "contracts ADR 0085: name every explorer-visible type after Blast",
      "contracts ADR 0097: package custody and the redeem fee take blast_admin::blast_acl::AdminWitness of the typed UpgradeAdmin and FeeAdmin roles",
      "contracts ADR 0097 (amended 2026-10-02): PackageVersion lives in the one-time-witness module as blast_sui_package::PackageVersion, seeded from that witness",
    ],
  },
  {
    path: "production-boosts-v1.json",
    baseline: BLAST_SUI_BOOSTS_BASELINE,
    packages: [
      ["boostsCore", "boosts/core", "blast_boosts_core"],
      ["boostsProducts", "boosts/products", "blast_boosts_products"],
      ["boostsAftermath", "boosts/aftermath_adapter", "blast_boosts_aftermath"],
    ],
  },
];
const contractsRoot = resolve(
  sdkRoot,
  process.argv.slice(2).find((argument) => !argument.startsWith("--")) ??
    process.env.BLAST_CONTRACTS_DIR ??
    "../blast-v2-contracts",
);
const write = process.argv.includes("--write");
const temporaryRoot = mkdtempSync(join(tmpdir(), "blast-production-abi-"));

function main() {
  try {
    verifySuiCliVersion();
    for (const declaration of artifactDeclarations) {
      checkArtifact(declaration);
    }
  } finally {
    rmSync(temporaryRoot, { recursive: true, force: true });
  }
}

/** Each independently released package is checked against its recorded source commit. */
function frozenSources(commit) {
  const directory = join(temporaryRoot, commit);
  if (existsSync(directory)) return directory;
  mkdirSync(directory);
  const archive = spawnSync(
    "git",
    ["-C", contractsRoot, "archive", commit, "sui"],
    {
      maxBuffer: 64 * 1024 * 1024,
    },
  );
  if (archive.status !== 0) throw new Error(String(archive.stderr));
  const extract = spawnSync("tar", ["-x", "-C", directory], {
    input: archive.stdout,
  });
  if (extract.status !== 0) throw new Error(String(extract.stderr));
  return directory;
}

function checkArtifact(declaration) {
  const artifactPath = join(sdkRoot, "abi", declaration.path);
  const baseline = declaration.baseline ?? BASELINE;
  const sourceRoot = frozenSources(baseline.contractsCommit);
  const packages = Object.fromEntries(
    declaration.packages.map(([name, directory, packageName]) => [
      name,
      summarizePackage(join(sourceRoot, "sui", directory), packageName),
    ]),
  );
  const artifact = {
    schemaVersion: 1,
    baseline: {
      ...baseline,
      ...(declaration.approvedAbiAmendments === undefined
        ? {}
        : { approvedAbiAmendments: declaration.approvedAbiAmendments }),
      suiCli: "1.77.2-51d177ad7d65",
    },
    packages,
  };
  const serialized = `${JSON.stringify(artifact, null, 2)}\n`;

  if (write) {
    mkdirSync(dirname(artifactPath), { recursive: true });
    writeFileSync(artifactPath, serialized);
    console.log(`wrote ${artifactPath}`);
    return;
  }

  const expected = readFileSync(artifactPath, "utf8");
  if (expected !== serialized) {
    console.error(
      `production Move ABI differs from abi/${declaration.path}; run npm run check:abi:write only for an approved ABI migration`,
    );
    process.exitCode = 1;
    return;
  }
  console.log(
    `current production Move ABI matches abi/${declaration.path} frozen at ${baseline.contractsCommit}`,
  );
}

function verifySuiCliVersion() {
  const result = spawnSync("sui", ["--version"], { encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error(
      result.stderr || result.stdout || "failed to read Sui CLI version",
    );
  }
  const actual = result.stdout.trim().replace(/^sui\s+/, "");
  for (const declaration of artifactDeclarations) {
    const artifactPath = join(sdkRoot, "abi", declaration.path);
    // A new package's artifact is first created by --write.
    if (write && !existsSync(artifactPath)) continue;
    const artifact = JSON.parse(readFileSync(artifactPath, "utf8"));
    const expected = artifact.baseline?.suiCli;
    if (typeof expected !== "string") {
      throw new TypeError(`abi/${declaration.path} has no Sui CLI version`);
    }
    if (actual !== expected) {
      throw new Error(
        `Sui CLI ${actual} does not match abi/${declaration.path} value ${expected}`,
      );
    }
  }
}

function summarizePackage(packagePath, packageName) {
  const outputDirectory = join(temporaryRoot, packageName);
  const result = spawnSync(
    "sui",
    [
      "move",
      "summary",
      "--quiet",
      "--path",
      packagePath,
      "--output-directory",
      outputDirectory,
    ],
    { encoding: "utf8" },
  );
  if (result.status !== 0) {
    throw new Error(
      result.stderr || result.stdout || `failed to summarize ${packageName}`,
    );
  }

  const packageDirectory = join(outputDirectory, packageName);
  const moduleNames = readdirSync(packageDirectory)
    .filter((name) => name.endsWith(".json"))
    .map((name) => name.slice(0, -5))
    .sort();
  return {
    address: packageName,
    modules: Object.fromEntries(
      moduleNames.map((moduleName) => [
        moduleName,
        normalizeModule(
          packageName,
          moduleName,
          JSON.parse(
            readFileSync(join(packageDirectory, `${moduleName}.json`), "utf8"),
          ),
        ),
      ]),
    ),
  };
}

function normalizeModule(packageName, moduleName, summary) {
  const functions = Object.entries(summary.functions)
    // The private Boosts observation is called only with simulation checks disabled.
    .filter(
      ([name, definition]) =>
        definition.visibility === "Public" ||
        definition.entry ||
        (packageName === "blast_boosts_aftermath" &&
          moduleName === "operations" &&
          name === "observe"),
    )
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([name, definition]) => ({
      name,
      sdk: classifyFunction(packageName, moduleName, name),
      entry: definition.entry,
      typeParameters: definition.type_parameters.map(normalizeTypeParameter),
      parameters: definition.parameters.map((parameter) =>
        normalizeType(parameter.type_),
      ),
      returns: definition.return_.map(normalizeType),
    }));
  const normalizedStructs = normalizeStructs(summary.structs);
  const events = normalizedStructs
    .filter(({ name }) => isEventStruct(packageName, moduleName, name))
    .map((event) => ({
      ...event,
      sdk: classifyEvent(packageName, moduleName, event),
    }));
  const structs = normalizedStructs.filter(
    ({ name }) => !isEventStruct(packageName, moduleName, name),
  );
  const enums = Object.entries(summary.enums)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([name, definition]) => ({
      name,
      abilities: [...definition.abilities],
      typeParameters: definition.type_parameters.map(normalizeTypeParameter),
      variants: Object.entries(definition.variants)
        .sort(([, left], [, right]) => left.index - right.index)
        .map(([variantName, variant]) => ({
          name: variantName,
          fields: normalizeFields(variant.fields),
        })),
    }));

  return { functions, structs, enums, events };
}

function normalizeStructs(structs) {
  return Object.entries(structs)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([name, definition]) => ({
      name,
      abilities: [...definition.abilities],
      typeParameters: definition.type_parameters.map(normalizeTypeParameter),
      positional: definition.fields.positional_fields,
      fields: normalizeFields(definition.fields),
    }));
}

function normalizeFields(fields) {
  return Object.entries(fields.fields)
    .sort(([, left], [, right]) => left.index - right.index)
    .map(([name, field]) => ({ name, type: normalizeType(field.type_) }));
}

function normalizeTypeParameter(parameter) {
  return {
    name: parameter.name,
    phantom: parameter.phantom ?? false,
    constraints: [...parameter.constraints],
  };
}

function normalizeType(type) {
  if (type === null || typeof type !== "object") return type;
  if (Array.isArray(type)) return type.map(normalizeType);
  return Object.fromEntries(
    Object.entries(type)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, value]) => [key, normalizeType(value)]),
  );
}

function classifyFunction(packageName, moduleName, functionName) {
  const classifier = functionClassifiers[packageName];
  if (!classifier) throw new Error(`unknown package ${packageName}`);
  const sdk = classifier(moduleName, functionName);
  if (sdk === undefined) {
    throw new Error(
      `unclassified function ${packageName}::${moduleName}::${functionName}`,
    );
  }
  return sdk;
}

/** `module::function` → SDK role, for each set. */
function classifierOf(sets, byModule = {}) {
  return (moduleName, functionName) => {
    const key = `${moduleName}::${functionName}`;
    for (const [sdk, names] of Object.entries(sets)) {
      if (names.includes(key)) return sdk;
    }
    return byModule[moduleName];
  };
}

const functionClassifiers = {
  blast_admin: classifierOf(
    {
      builder: [
        "blast_acl::sign_in",
        "blast_acl::grant_admin",
        "blast_acl::revoke_admin",
        "blast_acl::grant_role",
        "blast_acl::revoke_role",
        "blast_acl::destroy_admin_cap",
        "blast_acl::begin_super_admin_transfer",
        "blast_acl::cancel_super_admin_transfer",
        "blast_acl::accept_super_admin_transfer",
        "blast_acl::destroy_retired_super_admin_cap",
        "package_admin::pause",
        "package_admin::schedule_upgrade",
        "package_admin::schedule_make_immutable",
        "package_admin::cancel_upgrade_action",
        "package_admin::schedule_upgrade_delay",
        "package_admin::apply_upgrade_delay",
      ],
      read: [
        "blast_acl::admin_count",
        "blast_acl::admin_roles",
        "blast_acl::has_role",
        "blast_acl::is_admin",
        "blast_acl::max_roles_per_admin",
        "blast_acl::super_admin_cap_id",
        "blast_acl::super_admin_transfer",
        "blast_acl::super_admin_transfer_delay_ms",
        "package_admin::current_package_id",
        "package_admin::has_upgrade_cap",
        "package_admin::initial_upgrade_delay_ms",
        "package_admin::is_upgrade_delay_guarded",
        "package_admin::pending_upgrade",
        "package_admin::publisher_id",
        "package_admin::upgrade_cap_id",
        "package_admin::upgrade_cap_version",
        "package_admin::upgrade_delay_ms",
        "package_admin::upgrade_digest",
        "package_admin::upgrade_policy",
      ],
      // Only a package's own code holds its PackageWitness or Publisher.
      "move-composition": [
        "package_admin::clear_pause_bits",
        "package_admin::publisher",
        "package_admin::publisher_mut",
      ],
      // Publishing wraps the Publication; upgrades are Sui CLI publish tooling.
      "intentional-deployment-exclusion": ["package_admin::wrap"],
      "intentional-upgrade-exclusion": [
        "package_admin::authorize_upgrade",
        "package_admin::commit_upgrade_and_advance",
        "package_admin::make_immutable",
      ],
    },
    {
      // Consumers embed these values in their own objects.
      delayed: "move-composition",
      delayed_action: "move-composition",
      delayed_map: "move-composition",
      delayed_set: "move-composition",
      package_version: "move-composition",
    },
  ),
  blast_partners: classifierOf(
    {
      builder: [
        "blast_partners::register",
        "blast_partners::schedule_share",
        "blast_partners::apply_share",
        "blast_partners::cancel_share",
        "blast_partners::schedule_cap",
        "blast_partners::apply_cap",
        "blast_partners::cancel_cap",
        "blast_partners::set_recipient",
        "blast_partners::new_cap",
        "blast_partners::destroy_cap",
      ],
      read: [
        "blast_partners::cap_id",
        "blast_partners::delay_ms",
        "blast_partners::is_cap_ready",
        "blast_partners::is_share_ready",
        "blast_partners::max_share_bps",
        "blast_partners::pending_cap_id",
        "blast_partners::pending_share_bps",
        "blast_partners::recipient",
        "blast_partners::share_bps",
      ],
      // Products pay partners from Blast's own fee balance.
      "move-composition": ["blast_partners::pay"],
    },
    {
      // Products embed a PartnerList in their own config.
      partner_list: "move-composition",
    },
  ),
  blast_core: classifierOf(
    {
      builder: [
        "blast_treasury::schedule_destination",
        "blast_treasury::apply_destination",
        "blast_treasury::cancel_destination",
      ],
      // Values built in the PTB for a product or vault call.
      compositional: [
        "bps::new",
        "fee_split::address_destination",
        "fee_split::owner_destination",
        "fee_split::auto_lp_destination",
        "fee_split::holder_rewards_destination",
        "fee_split::burn_destination",
        "fee_split::route",
        "fee_split::new",
        "payout::vesting_terms",
        "payout::recipient",
      ],
      read: [
        "blast_treasury::destination",
        "blast_treasury::delay_ms",
        "blast_treasury::pending_destination",
        "blast_treasury::is_destination_ready",
        "blast_treasury::is_guarded",
        "sealed_treasury_cap::package_witness",
        "sealed_treasury_cap::treasury_cap_id",
        "sealed_treasury_cap::total_supply",
        "sealed_treasury_cap::admission_package_witness",
        "sealed_treasury_cap::admission_venue",
      ],
    },
    {
      // Mirrored off chain as constants and bigint math.
      constants: "read",
      bps: "move-composition",
      fee_split: "move-composition",
      payout: "move-composition",
      merkle: "move-composition",
      migration: "move-composition",
      owner_proof: "move-composition",
      protocol_fees: "move-composition",
      // Sealing, admitting and opening take a package or venue witness.
      sealed_treasury_cap: "move-composition",
    },
  ),
  blast_vault: classifierOf({
    builder: [
      "blast_vault_package::schedule_witness",
      "blast_vault_package::apply_witness",
      "blast_vault_package::cancel_witness",
      "blast_vault_package::remove_witness",
      "blast_vault_package::schedule_witness_delay",
      "blast_vault_package::apply_witness_delay",
      "blast_vault_package::cancel_witness_delay",
      "blast_vault_package::unpause",
      "blast_vault_package::make_immutable",
      "holder_rewards::schedule_round",
      "holder_rewards::cancel_round",
      "holder_rewards::publish_round",
      "holder_rewards::claim",
      "holder_rewards::close_round",
      "holder_rewards::settle_gas_reserve",
      "holder_rewards::schedule_round_delay",
      "holder_rewards::apply_round_delay",
      "holder_rewards::cancel_round_delay",
      "vault::claim_owner_balances",
      "vault::schedule_fee_split",
      "vault::cancel_fee_split",
      "vault::schedule_protocol_bps",
      "vault::apply_protocol_bps",
      "vault::cancel_protocol_bps",
      "vault::pay_protocol_fees_with_partner",
    ],
    read: ["vault::assert_fee_split_ready", "vault::pool_id"],
    // Each takes the venue's own witness; the migrators venues call them.
    "move-composition": [
      "vault::new",
      "vault::share_with_position",
      "vault::position_mut",
      "vault::has_auto_lp_position",
      "vault::attach_auto_lp_position",
      "vault::auto_lp_position",
      "vault::auto_lp_position_mut",
      "vault::split_fees",
      "vault::apply_fee_split",
      "vault::take_auto_lp",
      "vault::keep_auto_lp",
      "vault::take_buyback_quote",
      "vault::burn_buyback",
    ],
  }),
  blast_migrators: classifierOf({
    builder: ["cetus", "bluefin"].flatMap((venue) =>
      [
        "prepare",
        "migrate",
        "collect_fees",
        "settle_and_apply_fee_split",
        "compound_auto_lp",
        "buyback_and_burn",
        "compound_auto_lp",
      ].map((name) => `${venue}::${name}`),
    ),
  }),
  blast_fun: classifyLaunchpadFunction,
  launch_ticket_template: () => undefined,
  coin_template: () => undefined,
  blast_presale: classifyPresaleFunction,
  presale_coin_template: () => undefined,
  blast_aftermath_dao_presale: classifierOf({
    builder: [
      "blast_aftermath_dao_presale::prepare",
      "blast_aftermath_dao_presale::migrate",
    ],
  }),
  blast_sui: classifyBlastSuiFunction,
  blast_boosts_core: () => "move-composition",
  // A generated-package template runs only its initializer.
  blast_boosts_products: () => undefined,
  blast_boosts_aftermath: classifyBoostsFunction,
};

/** The launchpad's own entry points the SDK builds, by module. */
const launchpadBuilders = {
  launch: [
    "apply_creator_metadata_cap_delay",
    "apply_creator_metadata_cap_reassignment",
    "apply_curve_fee_cap_delay",
    "apply_curve_fee_cap_reassignment",
    "buy",
    "cancel_creator_metadata_cap_reassignment",
    "cancel_curve_fee_cap_reassignment",
    "claim_creator_caps",
    "claim_creator_fees",
    "claim_protocol_fees",
    "claim_protocol_fees_with_partner",
    "deliver_opening_round",
    "finalize",
    "join_opening_round",
    "migrate",
    "new",
    "prove_owner",
    "schedule_creator_metadata_cap_delay",
    "schedule_creator_metadata_cap_reassignment",
    "schedule_curve_fee_cap_delay",
    "schedule_curve_fee_cap_reassignment",
    "sell",
    "set_allocation_plan",
    "set_description",
    "set_graduation_target",
    "set_icon_url",
    "set_lp_fee_split",
    "set_name",
    "set_opening_round",
    "set_partner",
    "set_virtual_quote",
    "settle_opening_round",
    "share",
  ],
  launch_config: [
    "add_partner",
    "apply_creation_fee",
    "apply_protocol_allocation",
    "apply_protocol_lp_fees",
    "apply_trade_fees",
    "apply_venue",
    "apply_venue_delay",
    "cancel_creation_fee",
    "cancel_protocol_allocation",
    "cancel_protocol_lp_fees",
    "cancel_trade_fees",
    "cancel_venue",
    "cancel_venue_delay",
    "remove_partner",
    "remove_venue",
    "schedule_creation_fee",
    "schedule_protocol_allocation",
    "schedule_protocol_lp_fees",
    "schedule_trade_fees",
    "schedule_venue",
    "schedule_venue_delay",
    "set_meme_decimals_allowed",
    "set_quote_allowed",
    "unpause",
  ],
  runtime_config: [
    "apply_creator_claim_signer",
    "apply_creator_claim_signer_delay",
    "apply_protocol_fee_share",
    "cancel_creator_claim_signer",
    "cancel_creator_claim_signer_delay",
    "cancel_protocol_fee_share",
    "revoke_creator_claim_signer",
    "schedule_creator_claim_signer",
    "schedule_creator_claim_signer_delay",
    "schedule_protocol_fee_share",
  ],
};

function classifyLaunchpadFunction(moduleName, functionName) {
  const key = `${moduleName}::${functionName}`;
  if (launchpadBuilders[moduleName]?.includes(functionName)) return "builder";
  if (
    key === "allocation::recipient_share" ||
    key === "allocation::plan" ||
    key === "launch_config::venue_admission"
  ) {
    return "compositional";
  }
  if (key === "launch_ticket::new") return "template-builder";
  if (moduleName === "creator_authority") {
    if (functionName.startsWith("new_")) return "template-internal";
    if (functionName.startsWith("destroy_")) return "move-composition";
  }
  return undefined;
}

/** The presale's own entry points the SDK builds, by module. */
const presaleBuilders = {
  blast_presale: [
    "allowlisted_eligibility",
    "cancel_unlaunched",
    "claim",
    "commit_allowlisted",
    "commit_open",
    "commit_uncapped",
    "destroy_cap",
    "finalize",
    "migrate",
    "new",
    "open_eligibility",
    "pay_protocol_fees_with_partner",
    "prove_owner",
    "recipient_share",
    "set_eligibility",
    "set_fee_split",
    "set_hard_cap",
    "set_participant_vesting",
    "set_partner",
    "set_protocol_fees",
    "set_raise",
    "set_supply",
    "set_token_allocations",
    "set_uncapped_phase",
    "set_windows",
    "settle",
    "share",
    "uncapped_for_anyone",
    "uncapped_for_eligible",
  ],
  creation_policy: [
    "add_partner",
    "apply_venue",
    "apply_venue_delay",
    "cancel_venue",
    "cancel_venue_delay",
    "remove_partner",
    "remove_venue",
    "schedule_venue",
    "schedule_venue_delay",
    "set_quote_allowed",
    "unpause",
  ],
  fee_policy: ["apply_fees", "cancel_fees", "schedule_fees"],
};

function classifyPresaleFunction(moduleName, functionName) {
  const key = `${moduleName}::${functionName}`;
  // The initializer's venue is read inside the creation PTB.
  if (key === "blast_presale::venue") return "read";
  // The admission is built in the creation PTB for cetus::prepare.
  if (key === "creation_policy::venue_admission") return "compositional";
  // Called by the generated sale-token package's initializer.
  if (key === "sale_token::new") return "template-builder";
  if (presaleBuilders[moduleName]?.includes(functionName)) return "builder";
  return undefined;
}

/** The consumer SDK builds active trades, maintenance and issuer metadata updates. */
const boostsBuilders = new Set([
  "operations::mint",
  "operations::redeem",
  "operations::rebalance",
  "vault::update_metadata",
]);
const boostsOperatorFunctions = new Set([
  "operations::initialize",
  "operations::add_partner",
  "operations::remove_partner",
  "operations::mint_with_partner",
  "operations::redeem_with_partner",
  "operations::donate",
  "operations::sync_health",
  "operations::unwind",
  "operations::finalize_shutdown",
  "vault::issue",
  "vault::share",
  "vault::begin_shutdown",
  "vault::redeem_shutdown",
  "vault::set_fees",
  "vault::set_nav_cap",
  "vault::set_max_order_notional",
  "vault::withdraw_admin_fees",
]);

function classifyBoostsFunction(moduleName, functionName) {
  const key = `${moduleName}::${functionName}`;
  if (boostsBuilders.has(key)) return "builder";
  if (key === "operations::needs_rebalance" || key === "operations::observe") {
    return "read";
  }
  // Issuance, partner trades, risk administration and shutdown remain operator PTBs.
  if (boostsOperatorFunctions.has(key)) return "intentional-operator-exclusion";
  if (
    moduleName === "package_admin" &&
    functionName === "restrict_to_dependency_only"
  ) {
    return "intentional-upgrade-exclusion";
  }
  return classifyPackageAdmin(moduleName, functionName);
}

/**
 * blast_sui's and boosts' own `package_admin` (frozen before the generic
 * administration): wrapping is publishing, and upgrades are publish tooling.
 */
const upgradeCustodyFunctions = new Set([
  "authorize_upgrade",
  "commit_upgrade",
  "commit_upgrade_and_advance",
  "restrict_to_additive",
  "make_immutable",
]);

function classifyPackageAdmin(moduleName, functionName) {
  if (moduleName !== "package_admin") return undefined;
  if (functionName === "wrap") return "intentional-deployment-exclusion";
  if (upgradeCustodyFunctions.has(functionName)) {
    return "intentional-upgrade-exclusion";
  }
  return undefined;
}

const blastSuiBuilders = new Set([
  "vault::mint_fun_sui",
  "vault::redeem_fun_sui",
  "vault::request_blast_sui",
  "deposit_receipt::keep",
  "vault::claim_blast_sui",
  "deposit_receipt::cancel",
  "vault::donate_sui",
  "vault::redeem_blast_sui",
  "vault::sync",
  "vault::set_redeem_fee",
]);
const blastSuiDeploymentExclusions = new Set([
  "vault::create",
  "package_admin::add_capability",
  "deposit_receipt::create_display",
  "package_admin::new",
  "package_admin::share",
]);

function classifyBlastSuiFunction(moduleName, functionName) {
  const key = `${moduleName}::${functionName}`;
  if (blastSuiBuilders.has(key)) return "builder";
  if (blastSuiDeploymentExclusions.has(key)) {
    return "intentional-deployment-exclusion";
  }
  if (key === "package_admin::has_upgrade_cap") return "move-composition";
  return classifyPackageAdmin(moduleName, functionName);
}

/** Every event the SDK decodes and replays; boosts' operator events are excluded. */
function classifyEvent(packageName, _moduleName, event) {
  if (packageName === "blast_boosts_aftermath") {
    return ["Minted", "Redeemed", "Rebalanced"].includes(event.name)
      ? "decoder"
      : "intentional-operator-exclusion";
  }
  return "decoder-reducer";
}

/** The delayed modules own their events; the SDK decodes all 21. */
const delayedEventModules = new Set([
  "delayed",
  "delayed_action",
  "delayed_map",
  "delayed_set",
]);
const delayedEventName =
  /^(Delayed|Action|Map|Set)(Created|Scheduled|Cancelled|Applied|Destroyed)$|^MemberRemoved$/;
const partnersEventNames = new Set([
  "PartnerUpdated",
  "PartnerPaid",
  "PartnerAdded",
  "PartnerRemoved",
  "PartnerListDestroyed",
]);
const blastSuiEventNames = new Set([
  "PackageCapabilityAdded",
  "VaultCreated",
  "FunSuiMinted",
  "FunSuiRedeemed",
  "BlastSuiDepositRequested",
  "BlastSuiDepositClaimed",
  "BlastSuiDepositCancelled",
  "BlastSuiDonated",
  "BlastSuiRedeemed",
  "FunYieldSwept",
  "RedeemFeeChanged",
  "VaultSynced",
  "NativeStakeUnwound",
]);

function isEventStruct(packageName, moduleName, structName) {
  switch (packageName) {
    case "blast_admin":
      return (
        moduleName === "blast_admin_events" ||
        (delayedEventModules.has(moduleName) &&
          delayedEventName.test(structName))
      );
    case "blast_partners":
      return partnersEventNames.has(structName);
    case "blast_core":
      return moduleName === "blast_core_events";
    case "blast_vault":
      return moduleName === "blast_vault_events";
    case "blast_presale":
      // PresaleCreated is defined beside the sale, not in `events`.
      return (
        moduleName === "events" ||
        (moduleName === "blast_presale" && structName === "PresaleCreated")
      );
    case "blast_aftermath_dao_presale":
      return structName === "PoolCreationReserved" || structName === "Migrated";
    case "blast_sui":
      return moduleName === "events" && blastSuiEventNames.has(structName);
    default:
      return moduleName === "events";
  }
}

function runClassificationProbe(argumentIndex) {
  try {
    const [packageName, moduleName, functionName] = process.argv.slice(
      argumentIndex + 1,
      argumentIndex + 4,
    );
    if (!packageName || !moduleName || !functionName) {
      throw new Error(
        "--classify-function requires package, module, and function",
      );
    }
    console.log(classifyFunction(packageName, moduleName, functionName));
  } finally {
    rmSync(temporaryRoot, { recursive: true, force: true });
  }
}

const classificationArgumentIndex = process.argv.indexOf("--classify-function");
if (classificationArgumentIndex === -1) main();
else runClassificationProbe(classificationArgumentIndex);
