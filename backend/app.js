const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const { ethers } = require('ethers');
const multer = require('multer');
const { createHash } = require('crypto');
const axios = require('axios');
const sharp = require('sharp');
const tf = require('@tensorflow/tfjs-node');

// Import fraud detection engine
const { FraudDetectionEngine } = require('../ai-models/fraud_detection');

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(helmet());
app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));

// Rate limiting
const limiter = rateLimit({
    windowMs: 15 * 60 * 1000, // 15 minutes
    max: 100 // limit each IP to 100 requests per windowMs
});
app.use('/api/', limiter);

// File upload configuration
const storage = multer.memoryStorage();
const upload = multer({ 
    storage: storage,
    limits: { fileSize: 10 * 1024 * 1024 }, // 10MB limit
    fileFilter: (req, file, cb) => {
        if (file.mimetype.startsWith('image/')) {
            cb(null, true);
        } else {
            cb(new Error('Only image files are allowed'), false);
        }
    }
});

// Blockchain configuration
const provider = new ethers.providers.JsonRpcProvider(process.env.RPC_URL || 'http://localhost:8545');
const wallet = new ethers.Wallet(process.env.PRIVATE_KEY, provider);

// Contract ABI and address (simplified for demo)
const contractABI = [
    "function registerFarmer(string _aadharHash, string _name, string _location)",
    "function createPolicy(string _cropType, uint256 _areaInHectares, int256 _latitude, int256 _longitude, uint256 _sowingDate, uint256 _coverageAmount, uint256 _policyDuration) payable",
    "function submitClaim(uint256 _policyId, string _damageType, uint256 _claimAmount, string _evidenceHash)",
    "function submitFraudAnalysis(uint256 _claimId, uint256 _fraudScore, string _aiReportHash, string[] _fraudIndicators, bool _requiresInvestigation)",
    "function getFarmerClaimHistory(address _farmer) view returns (uint256[])",
    "function policies(uint256) view returns (tuple)",
    "function claims(uint256) view returns (tuple)",
    "function farmers(address) view returns (tuple)"
];

const contractAddress = process.env.CONTRACT_ADDRESS || '0x...';
const contract = new ethers.Contract(contractAddress, contractABI, wallet);

// Initialize fraud detection engine
const fraudDetector = new FraudDetectionEngine();

// AI Models (would be loaded from saved models)
let diseaseDetectionModel = null;
let yieldPredictionModel = null;

// Load AI models on startup
async function loadAIModels() {
    try {
        // In production, these would load actual trained models
        console.log('Loading AI models...');
        // diseaseDetectionModel = await tf.loadLayersModel('file://./models/disease_detection.json');
        // yieldPredictionModel = await tf.loadLayersModel('file://./models/yield_prediction.json');
        console.log('AI models loaded successfully');
    } catch (error) {
        console.error('Error loading AI models:', error);
    }
}

// Utility functions
const generateHash = (data) => {
    return createHash('sha256').update(JSON.stringify(data)).digest('hex');
};

const uploadToIPFS = async (buffer, filename) => {
    // In production, this would upload to IPFS
    // For demo, we'll just return a mock hash
    return `Qm${generateHash(buffer + filename).substring(0, 44)}`;
};

// API Routes

/**
 * @route POST /api/farmer/register
 * @desc Register a new farmer with KYC verification
 */
app.post('/api/farmer/register', async (req, res) => {
    try {
        const { aadharNumber, name, location, walletAddress } = req.body;
        
        // Hash Aadhar for privacy
        const aadharHash = generateHash(aadharNumber);
        
        // Register farmer on blockchain
        const tx = await contract.registerFarmer(aadharHash, name, location);
        await tx.wait();
        
        // Store additional data in database (mock)
        const farmerData = {
            walletAddress,
            aadharHash,
            name,
            location,
            registrationDate: new Date(),
            kycStatus: 'VERIFIED'
        };
        
        res.json({
            success: true,
            message: 'Farmer registered successfully',
            data: {
                walletAddress,
                transactionHash: tx.hash,
                farmerData
            }
        });
        
    } catch (error) {
        console.error('Farmer registration error:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to register farmer',
            error: error.message
        });
    }
});

/**
 * @route POST /api/policy/create
 * @desc Create a new crop insurance policy
 */
app.post('/api/policy/create', async (req, res) => {
    try {
        const {
            cropType,
            areaInHectares,
            latitude,
            longitude,
            sowingDate,
            coverageAmount,
            policyDuration,
            farmerAddress
        } = req.body;
        
        // Convert coordinates to proper format (multiply by 1e6 for precision)
        const latInt = Math.round(latitude * 1e6);
        const lonInt = Math.round(longitude * 1e6);
        
        // Calculate premium using AI risk assessment
        const riskAssessment = await calculateRiskPremium(req.body);
        
        // Create policy on blockchain
        const premium = ethers.utils.parseEther(riskAssessment.premium.toString());
        const tx = await contract.createPolicy(
            cropType,
            areaInHectares,
            latInt,
            lonInt,
            Math.floor(new Date(sowingDate).getTime() / 1000),
            ethers.utils.parseEther(coverageAmount.toString()),
            policyDuration,
            { value: premium }
        );
        
        await tx.wait();
        
        res.json({
            success: true,
            message: 'Policy created successfully',
            data: {
                transactionHash: tx.hash,
                premium: riskAssessment.premium,
                riskScore: riskAssessment.riskScore,
                coverageAmount
            }
        });
        
    } catch (error) {
        console.error('Policy creation error:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to create policy',
            error: error.message
        });
    }
});

/**
 * @route POST /api/claim/submit
 * @desc Submit a crop damage claim with AI fraud detection
 */
app.post('/api/claim/submit', upload.array('images', 5), async (req, res) => {
    try {
        const {
            policyId,
            damageType,
            claimAmount,
            description,
            farmerAddress
        } = req.body;
        
        // Process uploaded images
        const processedImages = await Promise.all(
            req.files.map(async (file) => {
                const processed = await sharp(file.buffer)
                    .resize(512, 512)
                    .jpeg({ quality: 80 })
                    .toBuffer();
                
                const ipfsHash = await uploadToIPFS(processed, file.originalname);
                return {
                    originalName: file.originalname,
                    ipfsHash,
                    processedSize: processed.length
                };
            })
        );
        
        // Create evidence package
        const evidencePackage = {
            images: processedImages,
            description,
            timestamp: new Date(),
            geoLocation: req.body.geoLocation
        };
        
        const evidenceHash = await uploadToIPFS(
            Buffer.from(JSON.stringify(evidencePackage)), 
            'evidence.json'
        );
        
        // Submit claim to blockchain
        const tx = await contract.submitClaim(
            policyId,
            damageType,
            ethers.utils.parseEther(claimAmount.toString()),
            evidenceHash
        );
        
        await tx.wait();
        
        // Extract claim ID from transaction logs
        const receipt = await provider.getTransactionReceipt(tx.hash);
        const claimId = extractClaimIdFromLogs(receipt.logs);
        
        // Trigger AI fraud analysis
        const fraudAnalysis = await performFraudAnalysis(
            claimId,
            policyId,
            farmerAddress,
            evidencePackage,
            req.body
        );
        
        res.json({
            success: true,
            message: 'Claim submitted successfully',
            data: {
                claimId,
                transactionHash: tx.hash,
                evidenceHash,
                fraudAnalysis: {
                    riskLevel: fraudAnalysis.risk_level,
                    requiresInvestigation: fraudAnalysis.requires_field_verification
                }
            }
        });
        
    } catch (error) {
        console.error('Claim submission error:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to submit claim',
            error: error.message
        });
    }
});

/**
 * @route GET /api/fraud/monitor
 * @desc Get real-time fraud monitoring dashboard data
 */
app.get('/api/fraud/monitor', async (req, res) => {
    try {
        // Get fraud alerts from blockchain
        const fraudAlerts = await contract.getFraudAlerts();
        
        // Compile fraud statistics
        const fraudStats = {
            totalAlerts: fraudAlerts.length,
            highRiskClaims: 0,
            criticalRiskClaims: 0,
            investigationsRequired: 0,
            recentAlerts: []
        };
        
        // Get detailed fraud alert information
        for (let i = Math.max(0, fraudAlerts.length - 10); i < fraudAlerts.length; i++) {
            const alertData = await contract.fraudAlerts(fraudAlerts[i]);
            
            const alert = {
                alertId: fraudAlerts[i],
                farmer: alertData.farmer,
                claimId: alertData.claimId.toString(),
                riskLevel: parseInt(alertData.riskLevel),
                requiresInvestigation: alertData.requiresInvestigation,
                alertDate: new Date(parseInt(alertData.alertDate) * 1000),
                fraudIndicators: alertData.fraudIndicators
            };
            
            fraudStats.recentAlerts.push(alert);
            
            if (alert.riskLevel === 3) fraudStats.highRiskClaims++;
            if (alert.riskLevel === 4) fraudStats.criticalRiskClaims++;
            if (alert.requiresInvestigation) fraudStats.investigationsRequired++;
        }
        
        res.json({
            success: true,
            data: fraudStats
        });
        
    } catch (error) {
        console.error('Fraud monitoring error:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to fetch fraud data',
            error: error.message
        });
    }
});

/**
 * @route GET /api/farmer/:address/profile
 * @desc Get farmer profile with fraud risk assessment
 */
app.get('/api/farmer/:address/profile', async (req, res) => {
    try {
        const { address } = req.params;
        
        // Get farmer data from blockchain
        const farmerData = await contract.farmers(address);
        const claimHistory = await contract.getFarmerClaimHistory(address);
        
        // Get detailed claim information
        const claims = await Promise.all(
            claimHistory.map(async (claimId) => {
                const claim = await contract.claims(claimId);
                return {
                    claimId: claimId.toString(),
                    policyId: claim.policyId.toString(),
                    damageType: claim.damageType,
                    claimAmount: ethers.utils.formatEther(claim.claimAmount),
                    status: getClaimStatusText(claim.status),
                    fraudScore: parseInt(claim.fraudScore),
                    claimDate: new Date(parseInt(claim.claimDate) * 1000)
                };
            })
        );
        
        // Calculate farmer risk profile
        const riskProfile = calculateFarmerRiskProfile(claims);
        
        const profile = {
            address,
            name: farmerData.name,
            location: farmerData.location,
            trustScore: parseInt(farmerData.trustScore),
            isBlacklisted: farmerData.isBlacklisted,
            registrationDate: new Date(parseInt(farmerData.registrationDate) * 1000),
            claimHistory: claims,
            riskProfile
        };
        
        res.json({
            success: true,
            data: profile
        });
        
    } catch (error) {
        console.error('Profile fetch error:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to fetch farmer profile',
            error: error.message
        });
    }
});

/**
 * @route POST /api/weather/verify
 * @desc Verify weather conditions for claim validation
 */
app.post('/api/weather/verify', async (req, res) => {
    try {
        const { latitude, longitude, date, damageType } = req.body;
        
        // Get weather data from API
        const weatherData = await getWeatherData(latitude, longitude, date);
        
        // Verify consistency with claimed damage
        const verification = verifyWeatherConsistency(damageType, weatherData);
        
        res.json({
            success: true,
            data: {
                weatherData,
                verification,
                isConsistent: verification.score > 0.7
            }
        });
        
    } catch (error) {
        console.error('Weather verification error:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to verify weather data',
            error: error.message
        });
    }
});

// Helper Functions

async function calculateRiskPremium(policyData) {
    // AI-based risk assessment
    const riskFactors = {
        cropType: policyData.cropType,
        area: policyData.areaInHectares,
        location: { lat: policyData.latitude, lon: policyData.longitude },
        historicalYield: await getHistoricalYieldData(policyData),
        weatherPatterns: await getWeatherPatterns(policyData.latitude, policyData.longitude)
    };
    
    // Calculate base premium (3% of coverage)
    const basePremium = policyData.coverageAmount * 0.03;
    
    // AI risk multiplier (0.5x to 2.0x)
    const riskMultiplier = calculateAIRiskMultiplier(riskFactors);
    
    return {
        premium: basePremium * riskMultiplier,
        riskScore: riskMultiplier,
        riskFactors
    };
}

async function performFraudAnalysis(claimId, policyId, farmerAddress, evidencePackage, claimData) {
    try {
        // Get farmer historical data
        const claimHistory = await contract.getFarmerClaimHistory(farmerAddress);
        const farmerData = await contract.farmers(farmerAddress);
        const policyData = await contract.policies(policyId);
        
        // Prepare data for fraud detection
        const farmer_data = {
            farmer_id: farmerAddress,
            trust_score: parseInt(farmerData.trustScore),
            registration_date: new Date(parseInt(farmerData.registrationDate) * 1000)
        };
        
        const claim_data = {
            claim_date: new Date().toISOString(),
            crop_type: policyData.cropType,
            sowing_date: new Date(parseInt(policyData.sowingDate) * 1000).toISOString(),
            latitude: parseInt(policyData.latitude) / 1e6,
            longitude: parseInt(policyData.longitude) / 1e6,
            area_hectares: parseInt(policyData.areaInHectares),
            damage_type: claimData.damageType,
            claim_amount: parseFloat(claimData.claimAmount)
        };
        
        const historical_data = await getHistoricalClaimsData(claimHistory);
        
        // Run fraud detection
        const fraudAnalysis = await fraudDetector.detect_claim_fraud(
            farmer_data,
            claim_data,
            historical_data
        );
        
        // Submit analysis to blockchain
        const fraudScore = Math.round(fraudAnalysis.fraud_score * 1000);
        const aiReportHash = await uploadToIPFS(
            Buffer.from(JSON.stringify(fraudAnalysis)),
            'fraud_analysis.json'
        );
        
        const tx = await contract.submitFraudAnalysis(
            claimId,
            fraudScore,
            aiReportHash,
            fraudAnalysis.fraud_indicators,
            fraudAnalysis.requires_field_verification
        );
        
        await tx.wait();
        
        return fraudAnalysis;
        
    } catch (error) {
        console.error('Fraud analysis error:', error);
        throw error;
    }
}

async function getWeatherData(lat, lon, date) {
    // In production, integrate with actual weather APIs
    const mockWeatherData = {
        temperature: 25 + Math.random() * 10,
        humidity: 60 + Math.random() * 30,
        rainfall: Math.random() * 100,
        windSpeed: Math.random() * 20,
        date: date
    };
    
    return mockWeatherData;
}

function verifyWeatherConsistency(damageType, weatherData) {
    const consistencyRules = {
        'drought': weatherData.rainfall < 20,
        'flood': weatherData.rainfall > 100,
        'hail': weatherData.temperature < 15,
        'frost': weatherData.temperature < 5
    };
    
    const isConsistent = consistencyRules[damageType] || false;
    
    return {
        score: isConsistent ? 0.9 : 0.1,
        explanation: isConsistent ? 'Weather consistent with damage type' : 'Weather inconsistent with claimed damage'
    };
}

function calculateFarmerRiskProfile(claims) {
    const totalClaims = claims.length;
    const fraudulentClaims = claims.filter(c => c.fraudScore > 800).length;
    const avgFraudScore = claims.reduce((sum, c) => sum + c.fraudScore, 0) / totalClaims || 0;
    
    return {
        totalClaims,
        fraudulentClaims,
        fraudRate: totalClaims > 0 ? (fraudulentClaims / totalClaims) * 100 : 0,
        avgFraudScore,
        riskLevel: avgFraudScore > 600 ? 'HIGH' : avgFraudScore > 300 ? 'MEDIUM' : 'LOW'
    };
}

function extractClaimIdFromLogs(logs) {
    // Extract claim ID from blockchain transaction logs
    // This would parse the actual event logs
    return Math.floor(Math.random() * 10000); // Mock for demo
}

function getClaimStatusText(status) {
    const statuses = ['SUBMITTED', 'UNDER_REVIEW', 'APPROVED', 'REJECTED', 'PAID', 'FRAUDULENT'];
    return statuses[status] || 'UNKNOWN';
}

async function getHistoricalYieldData(policyData) {
    // Mock historical yield data
    return {
        avgYield: 2.5,
        yieldVariability: 0.3,
        lastThreeYears: [2.3, 2.7, 2.4]
    };
}

async function getWeatherPatterns(lat, lon) {
    // Mock weather pattern data
    return {
        avgRainfall: 800,
        droughtFrequency: 0.2,
        floodRisk: 0.1
    };
}

function calculateAIRiskMultiplier(riskFactors) {
    // Simplified AI risk calculation
    let multiplier = 1.0;
    
    // High-risk crops
    if (['cotton', 'sugarcane'].includes(riskFactors.cropType)) {
        multiplier += 0.3;
    }
    
    // Large area risk
    if (riskFactors.area > 10) {
        multiplier += 0.2;
    }
    
    // Weather risk
    if (riskFactors.weatherPatterns.droughtFrequency > 0.3) {
        multiplier += 0.4;
    }
    
    return Math.min(Math.max(multiplier, 0.5), 2.0);
}

async function getHistoricalClaimsData(claimIds) {
    // Mock historical claims data
    return claimIds.map(id => ({
        date: new Date(Date.now() - Math.random() * 365 * 24 * 60 * 60 * 1000).toISOString(),
        claimed: Math.random() > 0.7,
        damage_type: ['drought', 'flood', 'pest'][Math.floor(Math.random() * 3)],
        claim_amount: Math.random() * 100000,
        policy_amount: 100000
    }));
}

// Error handling middleware
app.use((error, req, res, next) => {
    console.error('API Error:', error);
    res.status(500).json({
        success: false,
        message: 'Internal server error',
        error: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
});

// 404 handler
app.use('*', (req, res) => {
    res.status(404).json({
        success: false,
        message: 'API endpoint not found'
    });
});

// Start server
app.listen(PORT, async () => {
    console.log(`🌾 Crop Insurance API Server running on port ${PORT}`);
    console.log('🛡️ Fraud detection system active');
    console.log('🔗 Blockchain integration ready');
    
    await loadAIModels();
});

module.exports = app;