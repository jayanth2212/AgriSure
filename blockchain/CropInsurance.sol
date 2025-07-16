// SPDX-License-Identifier: MIT
pragma solidity ^0.8.19;

import "@openzeppelin/contracts/security/ReentrancyGuard.sol";
import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/security/Pausable.sol";

/**
 * @title CropInsuranceContract
 * @dev Smart contract for tamper-proof crop insurance with AI fraud detection
 * Prevents farmer fraud through immutable records and automated verification
 */
contract CropInsuranceContract is ReentrancyGuard, Ownable, Pausable {
    
    struct Farmer {
        address walletAddress;
        string aadharHash;      // Hashed Aadhar for privacy
        string name;
        string location;
        uint256 trustScore;     // 0-1000, based on claim history
        bool isRegistered;
        bool isBlacklisted;
        uint256 registrationDate;
    }
    
    struct Policy {
        uint256 policyId;
        address farmer;
        string cropType;
        uint256 areaInHectares;
        int256 latitude;        // Multiplied by 1e6 for precision
        int256 longitude;       // Multiplied by 1e6 for precision
        uint256 sowingDate;
        uint256 coverageAmount;
        uint256 premiumPaid;
        uint256 policyStartDate;
        uint256 policyEndDate;
        PolicyStatus status;
        string geoHash;         // For fraud detection
    }
    
    struct Claim {
        uint256 claimId;
        uint256 policyId;
        address farmer;
        string damageType;      // drought, flood, pest, disease, etc.
        uint256 claimDate;
        uint256 claimAmount;
        string evidenceHash;    // IPFS hash of images/documents
        string aiReportHash;    // Hash of AI fraud analysis report
        uint256 fraudScore;     // 0-1000, from AI analysis
        ClaimStatus status;
        uint256 investigationDate;
        address investigator;
        string investigationReport;
        uint256 payoutAmount;
        uint256 payoutDate;
    }
    
    struct FraudAlert {
        address farmer;
        uint256 policyId;
        uint256 claimId;
        string[] fraudIndicators;
        uint256 riskLevel;      // 1=Low, 2=Medium, 3=High, 4=Critical
        bool requiresInvestigation;
        uint256 alertDate;
    }
    
    enum PolicyStatus { ACTIVE, CLAIMED, EXPIRED, CANCELLED }
    enum ClaimStatus { SUBMITTED, UNDER_REVIEW, APPROVED, REJECTED, PAID, FRAUDULENT }
    
    // State variables
    mapping(address => Farmer) public farmers;
    mapping(uint256 => Policy) public policies;
    mapping(uint256 => Claim) public claims;
    mapping(uint256 => FraudAlert) public fraudAlerts;
    mapping(string => bool) public usedGeoHashes;  // Prevent duplicate field claims
    
    uint256 public nextPolicyId = 1;
    uint256 public nextClaimId = 1;
    uint256 public nextFraudAlertId = 1;
    
    address public aiOracleAddress;
    address public investigatorPool;
    uint256 public minimumTrustScore = 500;
    
    // Events for transparency
    event FarmerRegistered(address indexed farmer, string name);
    event PolicyCreated(uint256 indexed policyId, address indexed farmer, string cropType);
    event ClaimSubmitted(uint256 indexed claimId, uint256 indexed policyId, address indexed farmer);
    event FraudDetected(uint256 indexed claimId, address indexed farmer, uint256 riskLevel);
    event ClaimApproved(uint256 indexed claimId, uint256 payoutAmount);
    event ClaimRejected(uint256 indexed claimId, string reason);
    event PayoutExecuted(uint256 indexed claimId, address indexed farmer, uint256 amount);
    event FarmerBlacklisted(address indexed farmer, string reason);
    
    modifier onlyRegisteredFarmer() {
        require(farmers[msg.sender].isRegistered, "Farmer not registered");
        require(!farmers[msg.sender].isBlacklisted, "Farmer is blacklisted");
        _;
    }
    
    modifier onlyAIOracle() {
        require(msg.sender == aiOracleAddress, "Only AI Oracle can call this");
        _;
    }
    
    modifier onlyInvestigator() {
        require(msg.sender == investigatorPool, "Only authorized investigator");
        _;
    }
    
    constructor(address _aiOracleAddress, address _investigatorPool) {
        aiOracleAddress = _aiOracleAddress;
        investigatorPool = _investigatorPool;
    }
    
    /**
     * @dev Register a new farmer with KYC verification
     * Prevents multiple registrations and maintains farmer integrity
     */
    function registerFarmer(
        string memory _aadharHash,
        string memory _name,
        string memory _location
    ) external {
        require(!farmers[msg.sender].isRegistered, "Farmer already registered");
        require(bytes(_aadharHash).length > 0, "Invalid Aadhar hash");
        
        farmers[msg.sender] = Farmer({
            walletAddress: msg.sender,
            aadharHash: _aadharHash,
            name: _name,
            location: _location,
            trustScore: 700,  // Start with medium trust score
            isRegistered: true,
            isBlacklisted: false,
            registrationDate: block.timestamp
        });
        
        emit FarmerRegistered(msg.sender, _name);
    }
    
    /**
     * @dev Create a new crop insurance policy
     * Includes geo-verification to prevent duplicate field insurance
     */
    function createPolicy(
        string memory _cropType,
        uint256 _areaInHectares,
        int256 _latitude,
        int256 _longitude,
        uint256 _sowingDate,
        uint256 _coverageAmount,
        uint256 _policyDuration
    ) external payable onlyRegisteredFarmer {
        require(_coverageAmount > 0, "Coverage amount must be positive");
        require(_areaInHectares > 0, "Area must be positive");
        require(_policyDuration > 0, "Policy duration must be positive");
        
        // Generate geo-hash for fraud prevention
        string memory geoHash = generateGeoHash(_latitude, _longitude, _areaInHectares);
        require(!usedGeoHashes[geoHash], "Field already insured by another policy");
        
        // Calculate premium (simplified - in reality would use complex AI models)
        uint256 premium = calculatePremium(_coverageAmount, _cropType, farmers[msg.sender].trustScore);
        require(msg.value >= premium, "Insufficient premium payment");
        
        policies[nextPolicyId] = Policy({
            policyId: nextPolicyId,
            farmer: msg.sender,
            cropType: _cropType,
            areaInHectares: _areaInHectares,
            latitude: _latitude,
            longitude: _longitude,
            sowingDate: _sowingDate,
            coverageAmount: _coverageAmount,
            premiumPaid: msg.value,
            policyStartDate: block.timestamp,
            policyEndDate: block.timestamp + (_policyDuration * 1 days),
            status: PolicyStatus.ACTIVE,
            geoHash: geoHash
        });
        
        usedGeoHashes[geoHash] = true;
        
        emit PolicyCreated(nextPolicyId, msg.sender, _cropType);
        nextPolicyId++;
    }
    
    /**
     * @dev Submit a claim for crop damage
     * Automatically triggers AI fraud detection
     */
    function submitClaim(
        uint256 _policyId,
        string memory _damageType,
        uint256 _claimAmount,
        string memory _evidenceHash
    ) external onlyRegisteredFarmer {
        require(policies[_policyId].farmer == msg.sender, "Not your policy");
        require(policies[_policyId].status == PolicyStatus.ACTIVE, "Policy not active");
        require(block.timestamp <= policies[_policyId].policyEndDate, "Policy expired");
        require(_claimAmount <= policies[_policyId].coverageAmount, "Claim exceeds coverage");
        
        claims[nextClaimId] = Claim({
            claimId: nextClaimId,
            policyId: _policyId,
            farmer: msg.sender,
            damageType: _damageType,
            claimDate: block.timestamp,
            claimAmount: _claimAmount,
            evidenceHash: _evidenceHash,
            aiReportHash: "",
            fraudScore: 0,
            status: ClaimStatus.SUBMITTED,
            investigationDate: 0,
            investigator: address(0),
            investigationReport: "",
            payoutAmount: 0,
            payoutDate: 0
        });
        
        policies[_policyId].status = PolicyStatus.CLAIMED;
        
        emit ClaimSubmitted(nextClaimId, _policyId, msg.sender);
        nextClaimId++;
    }
    
    /**
     * @dev AI Oracle submits fraud analysis report
     * This is called by the AI system after analyzing the claim
     */
    function submitFraudAnalysis(
        uint256 _claimId,
        uint256 _fraudScore,
        string memory _aiReportHash,
        string[] memory _fraudIndicators,
        bool _requiresInvestigation
    ) external onlyAIOracle {
        require(claims[_claimId].status == ClaimStatus.SUBMITTED, "Claim not in submitted state");
        
        claims[_claimId].fraudScore = _fraudScore;
        claims[_claimId].aiReportHash = _aiReportHash;
        claims[_claimId].status = ClaimStatus.UNDER_REVIEW;
        
        // Determine risk level based on fraud score
        uint256 riskLevel = 1;  // Low
        if (_fraudScore > 600) riskLevel = 2;  // Medium
        if (_fraudScore > 800) riskLevel = 3;  // High
        if (_fraudScore > 850) riskLevel = 4;  // Critical
        
        // Create fraud alert if suspicious
        if (_fraudScore > 500 || _requiresInvestigation) {
            fraudAlerts[nextFraudAlertId] = FraudAlert({
                farmer: claims[_claimId].farmer,
                policyId: claims[_claimId].policyId,
                claimId: _claimId,
                fraudIndicators: _fraudIndicators,
                riskLevel: riskLevel,
                requiresInvestigation: _requiresInvestigation,
                alertDate: block.timestamp
            });
            
            emit FraudDetected(_claimId, claims[_claimId].farmer, riskLevel);
            nextFraudAlertId++;
        }
        
        // Auto-approve low-risk claims
        if (_fraudScore < 300 && !_requiresInvestigation) {
            _approveClaim(_claimId, claims[_claimId].claimAmount);
        }
    }
    
    /**
     * @dev Investigator submits field verification report
     */
    function submitInvestigationReport(
        uint256 _claimId,
        bool _approved,
        uint256 _approvedAmount,
        string memory _investigationReport
    ) external onlyInvestigator {
        require(claims[_claimId].status == ClaimStatus.UNDER_REVIEW, "Claim not under review");
        
        claims[_claimId].investigationDate = block.timestamp;
        claims[_claimId].investigator = msg.sender;
        claims[_claimId].investigationReport = _investigationReport;
        
        if (_approved && _approvedAmount > 0) {
            _approveClaim(_claimId, _approvedAmount);
        } else {
            _rejectClaim(_claimId, "Investigation found insufficient evidence");
        }
    }
    
    /**
     * @dev Internal function to approve a claim
     */
    function _approveClaim(uint256 _claimId, uint256 _approvedAmount) internal {
        claims[_claimId].status = ClaimStatus.APPROVED;
        claims[_claimId].payoutAmount = _approvedAmount;
        
        emit ClaimApproved(_claimId, _approvedAmount);
        
        // Execute payout immediately
        _executePayout(_claimId);
    }
    
    /**
     * @dev Internal function to reject a claim
     */
    function _rejectClaim(uint256 _claimId, string memory _reason) internal {
        claims[_claimId].status = ClaimStatus.REJECTED;
        
        // If fraud score was very high, mark as fraudulent and reduce trust score
        if (claims[_claimId].fraudScore > 800) {
            claims[_claimId].status = ClaimStatus.FRAUDULENT;
            _reduceTrustScore(claims[_claimId].farmer, 100);
            
            // Blacklist farmer if trust score becomes too low
            if (farmers[claims[_claimId].farmer].trustScore < minimumTrustScore) {
                farmers[claims[_claimId].farmer].isBlacklisted = true;
                emit FarmerBlacklisted(claims[_claimId].farmer, "Multiple fraudulent claims");
            }
        }
        
        emit ClaimRejected(_claimId, _reason);
    }
    
    /**
     * @dev Execute payout to farmer
     */
    function _executePayout(uint256 _claimId) internal nonReentrant {
        require(claims[_claimId].status == ClaimStatus.APPROVED, "Claim not approved");
        require(claims[_claimId].payoutAmount > 0, "No payout amount set");
        
        address farmer = claims[_claimId].farmer;
        uint256 amount = claims[_claimId].payoutAmount;
        
        claims[_claimId].status = ClaimStatus.PAID;
        claims[_claimId].payoutDate = block.timestamp;
        
        // Increase trust score for successful legitimate claim
        if (claims[_claimId].fraudScore < 200) {
            _increaseTrustScore(farmer, 20);
        }
        
        // Transfer funds
        (bool success, ) = payable(farmer).call{value: amount}("");
        require(success, "Payout transfer failed");
        
        emit PayoutExecuted(_claimId, farmer, amount);
    }
    
    /**
     * @dev Calculate premium based on coverage, crop type, and farmer trust score
     */
    function calculatePremium(
        uint256 _coverageAmount,
        string memory _cropType,
        uint256 _trustScore
    ) public pure returns (uint256) {
        // Base premium rate (3% of coverage)
        uint256 basePremium = (_coverageAmount * 3) / 100;
        
        // Adjust based on trust score (higher trust = lower premium)
        uint256 trustAdjustment = (1000 - _trustScore) / 10;  // 0-50% adjustment
        uint256 adjustedPremium = basePremium + (basePremium * trustAdjustment) / 100;
        
        return adjustedPremium;
    }
    
    /**
     * @dev Generate geo-hash for fraud prevention
     */
    function generateGeoHash(
        int256 _latitude,
        int256 _longitude,
        uint256 _area
    ) public pure returns (string memory) {
        return string(abi.encodePacked(
            toString(_latitude),
            "-",
            toString(_longitude),
            "-",
            toString(_area)
        ));
    }
    
    /**
     * @dev Reduce farmer's trust score
     */
    function _reduceTrustScore(address _farmer, uint256 _reduction) internal {
        if (farmers[_farmer].trustScore > _reduction) {
            farmers[_farmer].trustScore -= _reduction;
        } else {
            farmers[_farmer].trustScore = 0;
        }
    }
    
    /**
     * @dev Increase farmer's trust score
     */
    function _increaseTrustScore(address _farmer, uint256 _increase) internal {
        farmers[_farmer].trustScore += _increase;
        if (farmers[_farmer].trustScore > 1000) {
            farmers[_farmer].trustScore = 1000;
        }
    }
    
    /**
     * @dev Get claim history for a farmer (for fraud analysis)
     */
    function getFarmerClaimHistory(address _farmer) external view returns (uint256[] memory) {
        uint256[] memory farmerClaims = new uint256[](nextClaimId - 1);
        uint256 count = 0;
        
        for (uint256 i = 1; i < nextClaimId; i++) {
            if (claims[i].farmer == _farmer) {
                farmerClaims[count] = i;
                count++;
            }
        }
        
        // Resize array to actual count
        uint256[] memory result = new uint256[](count);
        for (uint256 i = 0; i < count; i++) {
            result[i] = farmerClaims[i];
        }
        
        return result;
    }
    
    /**
     * @dev Get all fraud alerts (for admin monitoring)
     */
    function getFraudAlerts() external view returns (uint256[] memory) {
        uint256[] memory alerts = new uint256[](nextFraudAlertId - 1);
        for (uint256 i = 1; i < nextFraudAlertId; i++) {
            alerts[i-1] = i;
        }
        return alerts;
    }
    
    /**
     * @dev Emergency functions for admin
     */
    function pauseContract() external onlyOwner {
        _pause();
    }
    
    function unpauseContract() external onlyOwner {
        _unpause();
    }
    
    function updateAIOracle(address _newAIOracle) external onlyOwner {
        aiOracleAddress = _newAIOracle;
    }
    
    function withdrawFunds() external onlyOwner {
        payable(owner()).transfer(address(this).balance);
    }
    
    /**
     * @dev Utility function to convert int to string
     */
    function toString(int256 value) internal pure returns (string memory) {
        if (value == 0) {
            return "0";
        }
        
        bool negative = value < 0;
        uint256 absValue = uint256(negative ? -value : value);
        
        uint256 temp = absValue;
        uint256 digits;
        while (temp != 0) {
            digits++;
            temp /= 10;
        }
        
        bytes memory buffer = new bytes(negative ? digits + 1 : digits);
        
        if (negative) {
            buffer[0] = "-";
        }
        
        while (absValue != 0) {
            digits -= 1;
            buffer[negative ? digits + 1 : digits] = bytes1(uint8(48 + uint256(absValue % 10)));
            absValue /= 10;
        }
        
        return string(buffer);
    }
    
    /**
     * @dev Utility function to convert uint to string
     */
    function toString(uint256 value) internal pure returns (string memory) {
        if (value == 0) {
            return "0";
        }
        uint256 temp = value;
        uint256 digits;
        while (temp != 0) {
            digits++;
            temp /= 10;
        }
        bytes memory buffer = new bytes(digits);
        while (value != 0) {
            digits -= 1;
            buffer[digits] = bytes1(uint8(48 + uint256(value % 10)));
            value /= 10;
        }
        return string(buffer);
    }
}