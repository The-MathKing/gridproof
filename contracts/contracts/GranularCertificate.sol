// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {ERC1155} from "@openzeppelin/contracts/token/ERC1155/ERC1155.sol";
import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {MessageHashUtils} from "@openzeppelin/contracts/utils/cryptography/MessageHashUtils.sol";
import {DeviceRegistry} from "./DeviceRegistry.sol";
import {ShiftReward} from "./ShiftReward.sol";

/// @title GranularCertificate
/// @notice Hourly clean-energy certificates (EnergyTag-style Granular Certificates).
///
///  - One token ID per (device, hour): tokenId = deviceId << 32 | unixHour.
///    Balances are in watt-hours, so 1 token unit = 1 Wh of clean generation.
///  - A device-hour can be issued at most once (no double issuance).
///  - Every mint needs the device's own signature over the reading, plus the AI
///    integrity check's anomaly score, which is stored with the certificate.
///  - Retiring burns the certificate and credits the beneficiary for that hour
///    only, so evening load can't be covered with midday solar.
contract GranularCertificate is ERC1155, AccessControl {
    using ECDSA for bytes32;
    using MessageHashUtils for bytes32;

    /// The oracle that runs the AI integrity check and relays signed readings.
    bytes32 public constant ORACLE_ROLE = keccak256("ORACLE_ROLE");
    /// Auditors review quarantined readings and can release or reject them.
    bytes32 public constant AUDITOR_ROLE = keccak256("AUDITOR_ROLE");

    /// Anomaly scores are in basis points (0 = normal, 10000 = certainly anomalous).
    /// Readings at or above this score must go through quarantine.
    uint16 public anomalyThresholdBps = 7000;

    enum Status {
        None,
        Issued,
        Quarantined,
        Rejected
    }

    struct Certificate {
        Status status;
        uint32 wh; // amount issued (or claimed, if quarantined)
        uint16 anomalyBps; // integrity model's score at issue time
        uint64 issuedAt;
        uint32 retiredWh;
    }

    DeviceRegistry public immutable registry;
    ShiftReward public immutable reward;

    mapping(uint256 => Certificate) public certificates;

    /// Hourly ledger per buyer: consumption reported by their meter and clean energy retired.
    mapping(address => mapping(uint32 => uint64)) public loadWh;
    mapping(address => mapping(uint32 => uint64)) public matchedWh;

    /// GSHIFT paid per kWh retired in a surplus hour (18 decimals). 0 = not a surplus hour.
    mapping(uint32 => uint256) public surplusBonusPerKWh;

    event Issued(uint256 indexed tokenId, uint64 indexed deviceId, uint32 indexed hour, uint32 wh, uint16 anomalyBps);
    event Quarantined(uint256 indexed tokenId, uint64 indexed deviceId, uint32 indexed hour, uint32 wh, uint16 anomalyBps);
    event QuarantineResolved(uint256 indexed tokenId, bool released, address auditor);
    event Retired(address indexed holder, address indexed beneficiary, uint256 indexed tokenId, uint32 hour, uint64 wh);
    event LoadReported(address indexed consumer, uint32 indexed hour, uint64 wh);
    event SurplusHourSet(uint32 indexed hour, uint256 bonusPerKWh);
    event AnomalyThresholdSet(uint16 thresholdBps);

    error DeviceInactive(uint64 deviceId);
    error AlreadyRecorded(uint256 tokenId);
    error ExceedsCapacity(uint32 wh, uint32 capacityW);
    error BadDeviceSignature();
    error FutureHour(uint32 hour);
    error AboveThreshold(uint16 anomalyBps);
    error NotQuarantined(uint256 tokenId);
    error ZeroAmount();
    error LengthMismatch();

    constructor(address admin, DeviceRegistry registry_, ShiftReward reward_) ERC1155("") {
        registry = registry_;
        reward = reward_;
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
    }

    // ---------------------------------------------------------------- ids

    function tokenIdFor(uint64 deviceId, uint32 hour) public pure returns (uint256) {
        return (uint256(deviceId) << 32) | hour;
    }

    function decode(uint256 tokenId) public pure returns (uint64 deviceId, uint32 hour) {
        return (uint64(tokenId >> 32), uint32(tokenId));
    }

    /// The digest the device's meter signs. Binds chain and contract so a
    /// signature can't be replayed on another deployment.
    function readingDigest(uint64 deviceId, uint32 hour, uint32 wh) public view returns (bytes32) {
        return keccak256(abi.encode(block.chainid, address(this), deviceId, hour, wh));
    }

    // ---------------------------------------------------------------- issue

    /// Issue certificates for a signed reading that passed the AI integrity check.
    function issue(uint64 deviceId, uint32 hour, uint32 wh, uint16 anomalyBps, bytes calldata deviceSig)
        external
        onlyRole(ORACLE_ROLE)
        returns (uint256 tokenId)
    {
        if (anomalyBps >= anomalyThresholdBps) revert AboveThreshold(anomalyBps);
        return _issue(deviceId, hour, wh, anomalyBps, deviceSig);
    }

    function _issue(uint64 deviceId, uint32 hour, uint32 wh, uint16 anomalyBps, bytes calldata deviceSig)
        private
        returns (uint256 tokenId)
    {
        DeviceRegistry.Device memory d;
        (tokenId, d) = _checkReading(deviceId, hour, wh, deviceSig);
        certificates[tokenId] = Certificate(Status.Issued, wh, anomalyBps, uint64(block.timestamp), 0);
        _mint(d.owner, tokenId, wh, "");
        emit Issued(tokenId, deviceId, hour, wh, anomalyBps);
    }

    /// Record a signed reading the AI flagged. It holds the device-hour so it
    /// can't be re-submitted with different numbers, and waits for an auditor.
    function quarantine(uint64 deviceId, uint32 hour, uint32 wh, uint16 anomalyBps, bytes calldata deviceSig)
        external
        onlyRole(ORACLE_ROLE)
        returns (uint256 tokenId)
    {
        return _quarantine(deviceId, hour, wh, anomalyBps, deviceSig);
    }

    function _quarantine(uint64 deviceId, uint32 hour, uint32 wh, uint16 anomalyBps, bytes calldata deviceSig)
        private
        returns (uint256 tokenId)
    {
        (tokenId,) = _checkReading(deviceId, hour, wh, deviceSig);
        certificates[tokenId] = Certificate(Status.Quarantined, wh, anomalyBps, uint64(block.timestamp), 0);
        emit Quarantined(tokenId, deviceId, hour, wh, anomalyBps);
    }

    struct Reading {
        uint64 deviceId;
        uint32 hour;
        uint32 wh;
        uint16 anomalyBps;
        bytes deviceSig;
    }

    /// Submit many signed readings in one transaction. Each is issued or quarantined
    /// by its anomaly score. Device-hours already recorded are skipped, so a run that
    /// stopped half way can safely be sent again; any other bad reading reverts the batch.
    function submitReadings(Reading[] calldata readings)
        external
        onlyRole(ORACLE_ROLE)
        returns (uint256 issued, uint256 quarantined, uint256 skipped)
    {
        for (uint256 i = 0; i < readings.length; i++) {
            Reading calldata r = readings[i];
            if (certificates[tokenIdFor(r.deviceId, r.hour)].status != Status.None) {
                skipped++;
            } else if (r.anomalyBps >= anomalyThresholdBps) {
                _quarantine(r.deviceId, r.hour, r.wh, r.anomalyBps, r.deviceSig);
                quarantined++;
            } else {
                _issue(r.deviceId, r.hour, r.wh, r.anomalyBps, r.deviceSig);
                issued++;
            }
        }
    }

    /// Status of many certificates at once (0 none, 1 issued, 2 quarantined, 3 rejected).
    function statusesOf(uint256[] calldata tokenIds) external view returns (Status[] memory out) {
        out = new Status[](tokenIds.length);
        for (uint256 i = 0; i < tokenIds.length; i++) {
            out[i] = certificates[tokenIds[i]].status;
        }
    }

    /// Auditor decision on a quarantined reading: release mints it, otherwise it is rejected for good.
    function resolveQuarantine(uint256 tokenId, bool release) external onlyRole(AUDITOR_ROLE) {
        Certificate storage c = certificates[tokenId];
        if (c.status != Status.Quarantined) revert NotQuarantined(tokenId);
        emit QuarantineResolved(tokenId, release, msg.sender);
        if (!release) {
            c.status = Status.Rejected;
            return;
        }
        c.status = Status.Issued;
        c.issuedAt = uint64(block.timestamp);
        (uint64 deviceId, uint32 hour) = decode(tokenId);
        _mint(registry.getDevice(deviceId).owner, tokenId, c.wh, "");
        emit Issued(tokenId, deviceId, hour, c.wh, c.anomalyBps);
    }

    function _checkReading(uint64 deviceId, uint32 hour, uint32 wh, bytes calldata deviceSig)
        private
        view
        returns (uint256 tokenId, DeviceRegistry.Device memory d)
    {
        if (wh == 0) revert ZeroAmount();
        // An hour can only be certified once it has finished.
        if (uint256(hour) + 1 > block.timestamp / 3600) revert FutureHour(hour);
        d = registry.getDevice(deviceId);
        if (!d.active) revert DeviceInactive(deviceId);
        // A device can't physically produce more than its capacity for one hour.
        if (wh > d.capacityW) revert ExceedsCapacity(wh, d.capacityW);
        tokenId = tokenIdFor(deviceId, hour);
        if (certificates[tokenId].status != Status.None) revert AlreadyRecorded(tokenId);
        address signer = readingDigest(deviceId, hour, wh).toEthSignedMessageHash().recover(deviceSig);
        if (signer != d.signer) revert BadDeviceSignature();
    }

    // ---------------------------------------------------------------- consume

    /// The buyer's meter reading for one hour, relayed by the oracle.
    function reportLoad(address consumer, uint32 hour, uint64 wh) external onlyRole(ORACLE_ROLE) {
        loadWh[consumer][hour] = wh;
        emit LoadReported(consumer, hour, wh);
    }

    /// Consecutive hourly readings for one buyer, starting at `fromHour`.
    function reportLoads(address consumer, uint32 fromHour, uint64[] calldata whs) external onlyRole(ORACLE_ROLE) {
        for (uint256 i = 0; i < whs.length; i++) {
            uint32 hour = fromHour + uint32(i);
            loadWh[consumer][hour] = whs[i];
            emit LoadReported(consumer, hour, whs[i]);
        }
    }

    /// Burn certificates to claim clean energy for `beneficiary`, in the
    /// certificate's own hour. Retiring more than the hour's load is allowed
    /// but the extra doesn't raise the hourly match above 100%.
    function retire(uint256 tokenId, uint64 wh, address beneficiary) public {
        _retire(tokenId, wh, beneficiary);
    }

    /// Many retirements in one transaction, for a supplier retiring on behalf of its customers.
    function retireBatch(uint256[] calldata tokenIds, uint64[] calldata whs, address[] calldata beneficiaries) external {
        if (tokenIds.length != whs.length || tokenIds.length != beneficiaries.length) revert LengthMismatch();
        for (uint256 i = 0; i < tokenIds.length; i++) {
            _retire(tokenIds[i], whs[i], beneficiaries[i]);
        }
    }

    function _retire(uint256 tokenId, uint64 wh, address beneficiary) private {
        if (wh == 0) revert ZeroAmount();
        _burn(msg.sender, tokenId, wh);
        (, uint32 hour) = decode(tokenId);
        certificates[tokenId].retiredWh += uint32(wh);
        matchedWh[beneficiary][hour] += wh;
        emit Retired(msg.sender, beneficiary, tokenId, hour, wh);

        uint256 bonus = surplusBonusPerKWh[hour];
        if (bonus > 0) reward.mint(beneficiary, (bonus * wh) / 1000);
    }

    /// Hourly carbon-free match for one buyer, in basis points (10000 = 100%).
    function hourlyMatchBps(address consumer, uint32 hour) public view returns (uint16) {
        uint64 load = loadWh[consumer][hour];
        if (load == 0) return 0;
        uint64 matched = matchedWh[consumer][hour];
        return matched >= load ? 10000 : uint16((uint256(matched) * 10000) / load);
    }

    /// Total load and the part of it that was matched hour-by-hour (capped at each hour's load).
    function periodMatch(address consumer, uint32 fromHour, uint32 toHour)
        external
        view
        returns (uint64 totalLoadWh, uint64 matchedCappedWh)
    {
        for (uint32 h = fromHour; h < toHour; h++) {
            uint64 load = loadWh[consumer][h];
            uint64 m = matchedWh[consumer][h];
            totalLoadWh += load;
            matchedCappedWh += m < load ? m : load;
        }
    }

    // ---------------------------------------------------------------- admin

    function setSurplusHour(uint32 hour, uint256 bonusPerKWh) external onlyRole(ORACLE_ROLE) {
        surplusBonusPerKWh[hour] = bonusPerKWh;
        emit SurplusHourSet(hour, bonusPerKWh);
    }

    function setSurplusHours(uint32[] calldata hours_, uint256 bonusPerKWh) external onlyRole(ORACLE_ROLE) {
        for (uint256 i = 0; i < hours_.length; i++) {
            surplusBonusPerKWh[hours_[i]] = bonusPerKWh;
            emit SurplusHourSet(hours_[i], bonusPerKWh);
        }
    }

    function setAnomalyThreshold(uint16 thresholdBps) external onlyRole(DEFAULT_ADMIN_ROLE) {
        anomalyThresholdBps = thresholdBps;
        emit AnomalyThresholdSet(thresholdBps);
    }

    function supportsInterface(bytes4 interfaceId) public view override(ERC1155, AccessControl) returns (bool) {
        return super.supportsInterface(interfaceId);
    }
}
