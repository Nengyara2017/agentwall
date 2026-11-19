// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/// @title AgentWall — the guestbook only Agent IDs can sign
/// @notice A public on-chain guestbook for the Binance Agent ID Hackathon.
///         Only holders of an Agent ID (SPACE ID Agent ID, ERC-721, name.ai)
///         can sign the guestbook or be tipped by name.
/// @dev Minimal and auditable: no proxy, no external dependencies except a
///      read-only balanceOf call on the Agent ID contract. Agent ID is
///      non-transferable, so holding one is a stable identity signal.
///
/// OWNER PERMISSION (disclosed): the contract owner — set once at
/// construction to the deployer — is the ONLY address that can call
/// withdrawTips(). That function sends the contract's entire BNB balance
/// (the voluntary tips attached to guestbook signatures) to the owner.
/// The owner can hand ownership to another address with
/// transferOwnership() (only the current owner can call it).
/// There is no other owner-only function, no pause, no mint, no upgrade,
/// no way to change the Agent ID contract address, and no way to move
/// funds except through withdrawTips() or the explicit tipAgent() flow
/// (which forwards the sender's BNB straight to the recipient they named).
/// The owner can never touch a user's wallet or move funds that a user
/// did not already send to this contract.
interface IAgentID {
    /// @notice Returns how many Agent IDs `owner` holds. > 0 means holder.
    function balanceOf(address owner) external view returns (uint256);
}

contract AgentWall {
    /// @notice The SPACE ID Agent ID contract on BNB Smart Chain:
    ///         0x60b9262456de011f7d15a54cdd8c48baaa8b022f (ERC-721, "AI").
    IAgentID public immutable agentId;

    /// @notice Deployer. Only this address can call withdrawTips().
    address public owner;

    /// @notice One guestbook entry.
    struct Signature {
        address author; // signer, must hold an Agent ID
        string message; // 1..280 chars
        uint256 tip; // BNB attached to the signature (voluntary)
        uint256 timestamp; // block timestamp of the signature
    }

    Signature[] private _signatures;

    /// @notice A new guestbook signature.
    event GuestbookSigned(
        address indexed author,
        string message,
        uint256 tip,
        uint256 timestamp
    );

    /// @notice A tip sent from one Agent ID holder to another.
    event AgentTipped(
        address indexed from,
        address indexed to,
        uint256 amount,
        string note
    );

    /// @notice Ownership handed to a new address.
    event OwnershipTransferred(
        address indexed previousOwner,
        address indexed newOwner
    );

    /// @param agentIdAddress The Agent ID ERC-721 contract to check against.
    constructor(address agentIdAddress) {
        require(agentIdAddress != address(0), "agent id address is zero");
        agentId = IAgentID(agentIdAddress);
        owner = msg.sender;
    }

    /// @notice Sign the guestbook. Only Agent ID holders can sign.
    /// @param message The message to store permanently (1..280 chars).
    /// @dev Any BNB sent with the call is a voluntary tip to the guestbook,
    ///      held in this contract until the owner withdraws it (see
    ///      withdrawTips). The signer confirms the amount themselves.
    function signGuestbook(string calldata message) external payable {
        require(
            agentId.balanceOf(msg.sender) > 0,
            "must hold an Agent ID"
        );
        uint256 len = bytes(message).length;
        require(len >= 1, "message is empty");
        require(len <= 280, "message too long");

        _signatures.push(
            Signature({
                author: msg.sender,
                message: message,
                tip: msg.value,
                timestamp: block.timestamp
            })
        );

        emit GuestbookSigned(msg.sender, message, msg.value, block.timestamp);
    }

    /// @notice Tip an Agent ID holder. The recipient must hold an Agent ID.
    /// @param recipient The address to tip (must hold an Agent ID).
    /// @param note A short note attached to the tip (max 140 chars).
    /// @dev The full msg.value is forwarded to `recipient` in the same
    ///      call. Nothing is kept by the contract. The sender confirms
    ///      the recipient and amount themselves before signing.
    function tipAgent(address recipient, string calldata note) external payable {
        require(msg.value > 0, "tip must be greater than zero");
        require(recipient != address(0), "recipient is zero address");
        require(
            agentId.balanceOf(recipient) > 0,
            "recipient must hold an Agent ID"
        );
        require(bytes(note).length <= 140, "note too long");

        (bool ok, ) = payable(recipient).call{value: msg.value}("");
        require(ok, "tip transfer failed");

        emit AgentTipped(msg.sender, recipient, msg.value, note);
    }

    /// @notice Total number of guestbook signatures.
    function signatureCount() external view returns (uint256) {
        return _signatures.length;
    }

    /// @notice A slice of signatures, newest last. Use for pagination.
    /// @param start Index of the first signature to return.
    /// @param count Maximum number of signatures to return.
    /// @return An array of at most `count` signatures starting at `start`.
    ///         Returns an empty array when `start` is past the end.
    function getSignatures(
        uint256 start,
        uint256 count
    ) external view returns (Signature[] memory) {
        uint256 total = _signatures.length;
        if (start >= total || count == 0) {
            return new Signature[](0);
        }
        // Cap the slice at what remains; computed without addition so a
        // huge `count` can never overflow.
        uint256 remaining = total - start;
        uint256 size = count > remaining ? remaining : count;
        Signature[] memory out = new Signature[](size);
        for (uint256 i = 0; i < size; i++) {
            out[i] = _signatures[start + i];
        }
        return out;
    }

    /// @notice Hand contract ownership to a new address. ONLY the owner
    ///         can call this. Used once at deploy time so the project
    ///         owner (not the deployer) holds the withdraw permission.
    /// @param newOwner The address that becomes the new owner.
    function transferOwnership(address newOwner) external {
        require(msg.sender == owner, "only owner");
        require(newOwner != address(0), "new owner is zero");
        address oldOwner = owner;
        owner = newOwner;
        emit OwnershipTransferred(oldOwner, newOwner);
    }

    /// @notice Send the contract's entire BNB balance (accumulated
    ///         guestbook tips) to the owner. ONLY the owner can call this.
    /// @dev See the owner-permission note at the top of this file.
    function withdrawTips() external {
        require(msg.sender == owner, "only owner");
        uint256 balance = address(this).balance;
        require(balance > 0, "nothing to withdraw");
        (bool ok, ) = payable(owner).call{value: balance}("");
        require(ok, "withdraw failed");
    }
}
