import { ethers } from "ethers";

const abi = [
  "function registerAsset(bytes32 assetKey, bytes32 documentHash, string registryId, uint256 totalKg)",
  "function registerBatch(bytes32 assetKey, uint256 internalBatchId, uint256 tokenAmountKg)",
];

function getContract(): ethers.Contract | null {
  // BASE_RPC_URL is the production target. POLYGON_RPC_URL remains as a temporary
  // compatibility fallback for environments created before the Base migration.
  const rpc = process.env.BASE_RPC_URL || process.env.POLYGON_RPC_URL;
  const key = process.env.BLOCKCHAIN_PRIVATE_KEY;
  const address = process.env.REGISTRY_CONTRACT_ADDRESS;
  if (!rpc || !key || !address) return null;
  const provider = new ethers.JsonRpcProvider(rpc);
  const wallet = new ethers.Wallet(key, provider);
  return new ethers.Contract(address, abi, wallet);
}

export function makeAssetKey(registry: string, registryId: string): string {
  return ethers.keccak256(ethers.toUtf8Bytes(`${registry}:${registryId}`));
}

export async function registerAssetOnChain(input: {
  registry: string;
  registryId: string;
  documentSha256: string;
  totalKg: number;
}): Promise<string | null> {
  const contract = getContract();
  if (!contract) return null;
  const assetKey = makeAssetKey(input.registry, input.registryId);
  const documentHash = `0x${input.documentSha256}`;
  const transaction = await contract.registerAsset(assetKey, documentHash, input.registryId, input.totalKg);
  const receipt = await transaction.wait();
  return receipt?.hash ?? transaction.hash;
}

export async function registerBatchOnChain(input: {
  registry: string;
  registryId: string;
  batchId: number;
  tokenAmount: number;
}): Promise<string | null> {
  const contract = getContract();
  if (!contract) return null;
  const assetKey = makeAssetKey(input.registry, input.registryId);
  const transaction = await contract.registerBatch(assetKey, input.batchId, input.tokenAmount);
  const receipt = await transaction.wait();
  return receipt?.hash ?? transaction.hash;
}
