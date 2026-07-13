// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

contract EcotrackerRegistry {
    address public owner;

    struct AssetRecord {
        bytes32 documentHash;
        string registryId;
        uint256 totalKg;
        uint256 registeredAt;
        bool exists;
    }

    mapping(bytes32 => AssetRecord) public assets;

    event AssetRegistered(bytes32 indexed assetKey, bytes32 indexed documentHash, string registryId, uint256 totalKg);
    event BatchRegistered(bytes32 indexed assetKey, uint256 indexed internalBatchId, uint256 tokenAmountKg);

    modifier onlyOwner() {
        require(msg.sender == owner, "not owner");
        _;
    }

    constructor() {
        owner = msg.sender;
    }

    function registerAsset(bytes32 assetKey, bytes32 documentHash, string calldata registryId, uint256 totalKg) external onlyOwner {
        require(!assets[assetKey].exists, "asset exists");
        require(totalKg > 0, "invalid volume");
        assets[assetKey] = AssetRecord(documentHash, registryId, totalKg, block.timestamp, true);
        emit AssetRegistered(assetKey, documentHash, registryId, totalKg);
    }

    function registerBatch(bytes32 assetKey, uint256 internalBatchId, uint256 tokenAmountKg) external onlyOwner {
        require(assets[assetKey].exists, "asset missing");
        require(tokenAmountKg > 0, "invalid amount");
        emit BatchRegistered(assetKey, internalBatchId, tokenAmountKg);
    }
}
