// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";

/// @title DeviceRegistry
/// @notice The list of generating devices (solar arrays, wind turbines) allowed to
///         earn certificates. Each device has its own signing key: the certificate
///         contract only mints readings that this key signed.
contract DeviceRegistry is AccessControl {
    /// Role for the issuing body that checks a device exists before listing it.
    bytes32 public constant REGISTRAR_ROLE = keccak256("REGISTRAR_ROLE");

    enum Kind {
        Solar,
        Wind
    }

    struct Device {
        address owner; // receives the certificates
        address signer; // key inside the meter that signs readings
        uint32 capacityW; // nameplate capacity in watts
        Kind kind;
        int32 latE4; // latitude * 1e4, used by the weather check
        int32 lonE4; // longitude * 1e4
        bool active;
        string name;
    }

    uint64 public deviceCount;
    mapping(uint64 => Device) private _devices;

    event DeviceRegistered(uint64 indexed deviceId, address indexed owner, address signer, Kind kind, uint32 capacityW);
    event DeviceStatusChanged(uint64 indexed deviceId, bool active);
    event SignerRotated(uint64 indexed deviceId, address oldSigner, address newSigner);

    error UnknownDevice(uint64 deviceId);
    error ZeroAddress();
    error ZeroCapacity();

    constructor(address admin) {
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        _grantRole(REGISTRAR_ROLE, admin);
    }

    function registerDevice(
        address owner,
        address signer,
        uint32 capacityW,
        Kind kind,
        int32 latE4,
        int32 lonE4,
        string calldata name
    ) external onlyRole(REGISTRAR_ROLE) returns (uint64 deviceId) {
        if (owner == address(0) || signer == address(0)) revert ZeroAddress();
        if (capacityW == 0) revert ZeroCapacity();
        deviceId = ++deviceCount;
        _devices[deviceId] = Device(owner, signer, capacityW, kind, latE4, lonE4, true, name);
        emit DeviceRegistered(deviceId, owner, signer, kind, capacityW);
    }

    /// Switch off a device, for example after tampering is found.
    function setActive(uint64 deviceId, bool active) external onlyRole(REGISTRAR_ROLE) {
        _get(deviceId).active = active;
        emit DeviceStatusChanged(deviceId, active);
    }

    /// Replace a meter's key after the meter is serviced or the key leaks.
    function rotateSigner(uint64 deviceId, address newSigner) external onlyRole(REGISTRAR_ROLE) {
        if (newSigner == address(0)) revert ZeroAddress();
        Device storage d = _get(deviceId);
        emit SignerRotated(deviceId, d.signer, newSigner);
        d.signer = newSigner;
    }

    function getDevice(uint64 deviceId) external view returns (Device memory) {
        return _get(deviceId);
    }

    function _get(uint64 deviceId) private view returns (Device storage d) {
        d = _devices[deviceId];
        if (d.owner == address(0)) revert UnknownDevice(deviceId);
    }
}
