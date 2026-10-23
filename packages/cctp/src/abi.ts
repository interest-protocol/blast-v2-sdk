import { parseAbi } from "viem";

/** blast-cctp b670f07ee290aace73b62b91694a9de0f7068f49, ForwarderFactory.sol. */
export const cctpForwarderFactoryAbi = parseAbi([
  "function usdc() view returns (address)",
  "function rescuer() view returns (address)",
  "function initCode(bytes32 recipient, uint8 mode, uint32 index) pure returns (bytes)",
  "function addressOf(bytes32 recipient, uint8 mode, uint32 index) view returns (address)",
  "function deploy(bytes32 recipient, uint8 mode, uint32 index) returns (address forwarder)",
  "function forward(bytes32 recipient, uint8 mode, uint32 index) returns (address forwarder, uint256 amount, uint256 maxFee)",
  "event ForwarderDeployed(bytes32 indexed recipient, uint8 mode, uint32 index, address indexed forwarder)",
  "error LocalDomainIsSui()",
  "error SuiNotRegistered()",
  "error MinterNotWired(address minter)",
  "error NoLocalUsdc()",
  "error BurnLimitZero()",
  "error ZeroRecipient()",
  "error InvalidMode(uint8 mode)",
]);

/** blast-cctp b670f07ee290aace73b62b91694a9de0f7068f49, Forwarder.sol. */
export const cctpForwarderAbi = parseAbi([
  "function MODE_STANDARD() view returns (uint8)",
  "function MODE_FAST() view returns (uint8)",
  "function FEE_CEILING_BPS() view returns (uint256)",
  "function MESSENGER() view returns (address)",
  "function usdc() view returns (address)",
  "function recipient() view returns (bytes32)",
  "function minFinalityThreshold() view returns (uint32)",
  "function index() view returns (uint32)",
  "function rescuer() view returns (address)",
  "function forward() returns (uint256 amount, uint256 maxFee)",
  "function rescueToken(address token, address to, uint256 amount)",
  "function rescueNative(address to)",
  "event Forwarded(bytes32 indexed recipient, uint256 amount, uint256 maxFee, uint32 minFinalityThreshold)",
  "event Rescued(address indexed token, address indexed to, uint256 amount)",
  "error InvalidMode(uint8 mode)",
  "error ZeroRecipient()",
  "error NothingToForward()",
  "error BurnLimitZero()",
  "error FeeAboveCeiling(uint256 fee, uint256 ceiling)",
  "error ApproveFailed()",
  "error NotRescuer()",
  "error CannotRescueUsdc()",
  "error RescueFailed()",
  "error TransferFailed()",
  "error ETHTransferFailed()",
]);
