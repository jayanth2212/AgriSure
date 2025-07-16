import numpy as np
import pandas as pd
from sklearn.ensemble import IsolationForest, RandomForestClassifier
from sklearn.preprocessing import StandardScaler
from sklearn.model_selection import train_test_split
import joblib
import logging
from datetime import datetime, timedelta
import json
import cv2
from tensorflow.keras.models import load_model
import requests

class FraudDetectionEngine:
    """
    Advanced AI-powered fraud detection system for crop insurance
    Detects intentional crop damage, false claims, and suspicious patterns
    """
    
    def __init__(self):
        self.isolation_forest = None
        self.random_forest = None
        self.scaler = StandardScaler()
        self.setup_logging()
        
    def setup_logging(self):
        """Setup logging for fraud detection activities"""
        logging.basicConfig(
            level=logging.INFO,
            format='%(asctime)s - %(levelname)s - %(message)s',
            handlers=[
                logging.FileHandler('fraud_detection.log'),
                logging.StreamHandler()
            ]
        )
        self.logger = logging.getLogger(__name__)

    def detect_claim_fraud(self, farmer_data, claim_data, historical_data):
        """
        Main fraud detection function that analyzes multiple factors
        
        Args:
            farmer_data: Dict containing farmer profile information
            claim_data: Dict containing current claim details
            historical_data: List of historical claims and patterns
            
        Returns:
            Dict with fraud score, risk level, and specific fraud indicators
        """
        fraud_indicators = []
        fraud_score = 0.0
        
        # 1. Temporal Pattern Analysis
        temporal_score = self._analyze_temporal_patterns(farmer_data, claim_data, historical_data)
        fraud_score += temporal_score * 0.25
        
        # 2. Geospatial Verification
        geo_score = self._verify_geospatial_data(claim_data)
        fraud_score += geo_score * 0.25
        
        # 3. Weather Data Cross-verification
        weather_score = self._verify_weather_consistency(claim_data)
        fraud_score += weather_score * 0.20
        
        # 4. Satellite Image Analysis
        satellite_score = self._analyze_satellite_images(claim_data)
        fraud_score += satellite_score * 0.20
        
        # 5. Behavioral Pattern Analysis
        behavioral_score = self._analyze_farmer_behavior(farmer_data, historical_data)
        fraud_score += behavioral_score * 0.10
        
        # Determine risk level
        risk_level = self._calculate_risk_level(fraud_score)
        
        # Generate specific fraud indicators
        fraud_indicators = self._generate_fraud_indicators(
            temporal_score, geo_score, weather_score, satellite_score, behavioral_score
        )
        
        self.logger.info(f"Fraud analysis completed for farmer {farmer_data.get('farmer_id')} - Risk: {risk_level}")
        
        return {
            'fraud_score': round(fraud_score, 2),
            'risk_level': risk_level,
            'fraud_indicators': fraud_indicators,
            'requires_field_verification': fraud_score > 0.6,
            'auto_reject': fraud_score > 0.85,
            'timestamp': datetime.now().isoformat()
        }

    def _analyze_temporal_patterns(self, farmer_data, claim_data, historical_data):
        """Detect suspicious timing patterns"""
        score = 0.0
        claim_date = datetime.fromisoformat(claim_data['claim_date'])
        
        # Check for multiple claims in short time
        recent_claims = [claim for claim in historical_data 
                        if (claim_date - datetime.fromisoformat(claim['date'])).days < 90]
        
        if len(recent_claims) > 2:
            score += 0.3  # Multiple claims in 3 months is suspicious
            
        # Check claim timing vs crop cycle
        crop_type = claim_data['crop_type']
        sowing_date = datetime.fromisoformat(claim_data['sowing_date'])
        days_since_sowing = (claim_date - sowing_date).days
        
        # Suspicious if claim is too early or too late in crop cycle
        expected_ranges = {
            'wheat': (60, 180),
            'rice': (90, 150),
            'cotton': (90, 200),
            'sugarcane': (180, 365)
        }
        
        if crop_type in expected_ranges:
            min_days, max_days = expected_ranges[crop_type]
            if days_since_sowing < min_days or days_since_sowing > max_days:
                score += 0.2
                
        # Check for claims just before harvest (suspicious timing)
        if crop_type in ['wheat', 'rice'] and days_since_sowing > 120:
            score += 0.3
            
        return min(score, 1.0)

    def _verify_geospatial_data(self, claim_data):
        """Verify geo-coordinates and field boundaries"""
        score = 0.0
        
        lat = claim_data.get('latitude')
        lon = claim_data.get('longitude')
        reported_area = claim_data.get('area_hectares')
        
        # Check if coordinates are valid
        if not lat or not lon or abs(lat) > 90 or abs(lon) > 180:
            score += 0.5
            
        # Verify field area using satellite data (simulated)
        estimated_area = self._estimate_field_area_from_satellite(lat, lon)
        
        if estimated_area and abs(estimated_area - reported_area) / reported_area > 0.3:
            score += 0.4  # Area mismatch > 30% is suspicious
            
        # Check for duplicate coordinates in other claims
        # This would typically query a database
        if self._check_duplicate_coordinates(lat, lon):
            score += 0.6
            
        return min(score, 1.0)

    def _verify_weather_consistency(self, claim_data):
        """Cross-verify claimed damage with actual weather data"""
        score = 0.0
        
        lat = claim_data.get('latitude')
        lon = claim_data.get('longitude')
        damage_type = claim_data.get('damage_type')
        claim_date = claim_data.get('claim_date')
        
        # Get actual weather data for the location and time
        weather_data = self._get_weather_data(lat, lon, claim_date)
        
        if not weather_data:
            return 0.2  # Unable to verify is slightly suspicious
            
        # Check consistency between claimed damage and weather
        inconsistencies = {
            'drought': weather_data.get('rainfall_7days', 0) > 20,  # Rain during drought claim
            'flood': weather_data.get('rainfall_7days', 0) < 50,    # No heavy rain during flood claim
            'hail': not weather_data.get('hail_detected', False),   # No hail detected
            'frost': weather_data.get('min_temp', 20) > 5,          # Temp too high for frost
        }
        
        if damage_type in inconsistencies and inconsistencies[damage_type]:
            score += 0.7
            
        return min(score, 1.0)

    def _analyze_satellite_images(self, claim_data):
        """Analyze satellite images for crop health and damage patterns"""
        score = 0.0
        
        lat = claim_data.get('latitude')
        lon = claim_data.get('longitude')
        claim_date = claim_data.get('claim_date')
        
        # Get NDVI data for the field
        ndvi_current = self._get_ndvi_data(lat, lon, claim_date)
        ndvi_historical = self._get_ndvi_data(lat, lon, claim_date, days_back=30)
        
        if ndvi_current and ndvi_historical:
            # Sudden NDVI drop might indicate intentional damage
            ndvi_drop = ndvi_historical - ndvi_current
            
            if ndvi_drop > 0.3:  # Significant drop
                # Check if drop pattern is consistent with natural damage
                damage_pattern = self._analyze_damage_pattern(lat, lon, claim_date)
                
                if damage_pattern == 'artificial':
                    score += 0.6
                    
        # Check for signs of intentional crop cutting or burning
        if self._detect_artificial_damage_signs(lat, lon, claim_date):
            score += 0.8
            
        return min(score, 1.0)

    def _analyze_farmer_behavior(self, farmer_data, historical_data):
        """Analyze farmer's historical behavior patterns"""
        score = 0.0
        
        farmer_id = farmer_data.get('farmer_id')
        
        # Calculate claim frequency
        total_policies = len(historical_data)
        total_claims = len([d for d in historical_data if d.get('claimed')])
        
        if total_policies > 0:
            claim_ratio = total_claims / total_policies
            
            if claim_ratio > 0.7:  # Claims in >70% of policies
                score += 0.5
                
        # Check for consistent damage types (might indicate knowledge of system)
        damage_types = [d.get('damage_type') for d in historical_data if d.get('claimed')]
        if len(set(damage_types)) == 1 and len(damage_types) > 2:
            score += 0.3
            
        # Check claim amounts vs policy amounts
        large_claims = len([d for d in historical_data 
                          if d.get('claim_amount', 0) > d.get('policy_amount', 0) * 0.8])
        
        if large_claims > total_claims * 0.5:  # >50% claims are for large amounts
            score += 0.4
            
        return min(score, 1.0)

    def _calculate_risk_level(self, fraud_score):
        """Calculate risk level based on fraud score"""
        if fraud_score < 0.3:
            return 'LOW'
        elif fraud_score < 0.6:
            return 'MEDIUM'
        elif fraud_score < 0.8:
            return 'HIGH'
        else:
            return 'CRITICAL'

    def _generate_fraud_indicators(self, temporal, geo, weather, satellite, behavioral):
        """Generate specific fraud indicators based on scores"""
        indicators = []
        
        if temporal > 0.5:
            indicators.append("Suspicious timing pattern detected")
        if geo > 0.5:
            indicators.append("Geospatial data inconsistency")
        if weather > 0.5:
            indicators.append("Weather data mismatch with claimed damage")
        if satellite > 0.5:
            indicators.append("Satellite imagery suggests artificial damage")
        if behavioral > 0.5:
            indicators.append("Unusual behavioral pattern in claim history")
            
        return indicators

    # Helper methods (would be implemented with actual APIs)
    def _estimate_field_area_from_satellite(self, lat, lon):
        """Estimate field area from satellite imagery"""
        # This would integrate with satellite imagery APIs
        # For demo, returning a random value
        return np.random.uniform(0.5, 2.0)

    def _check_duplicate_coordinates(self, lat, lon):
        """Check if coordinates are used in other claims"""
        # This would query the database for duplicate coordinates
        return False

    def _get_weather_data(self, lat, lon, date):
        """Get weather data for specific location and date"""
        # This would integrate with weather APIs like OpenWeather
        return {
            'rainfall_7days': np.random.uniform(0, 100),
            'min_temp': np.random.uniform(-5, 25),
            'hail_detected': False
        }

    def _get_ndvi_data(self, lat, lon, date, days_back=0):
        """Get NDVI data from satellite"""
        # This would integrate with satellite APIs like Sentinel-2
        return np.random.uniform(0.2, 0.8)

    def _analyze_damage_pattern(self, lat, lon, date):
        """Analyze if damage pattern looks natural or artificial"""
        # This would use computer vision on satellite images
        return 'natural'  # or 'artificial'

    def _detect_artificial_damage_signs(self, lat, lon, date):
        """Detect signs of intentional crop damage"""
        # This would analyze satellite images for signs of cutting, burning, etc.
        return False

    def train_model(self, training_data):
        """Train the fraud detection models with historical data"""
        df = pd.DataFrame(training_data)
        
        # Prepare features
        features = [
            'claim_frequency', 'claim_amount_ratio', 'timing_score',
            'weather_consistency', 'area_accuracy', 'ndvi_drop'
        ]
        
        X = df[features]
        y = df['is_fraud']
        
        # Split data
        X_train, X_test, y_train, y_test = train_test_split(X, y, test_size=0.2, random_state=42)
        
        # Scale features
        X_train_scaled = self.scaler.fit_transform(X_train)
        X_test_scaled = self.scaler.transform(X_test)
        
        # Train models
        self.isolation_forest = IsolationForest(contamination=0.1, random_state=42)
        self.isolation_forest.fit(X_train_scaled)
        
        self.random_forest = RandomForestClassifier(n_estimators=100, random_state=42)
        self.random_forest.fit(X_train_scaled, y_train)
        
        # Save models
        joblib.dump(self.isolation_forest, 'models/isolation_forest.pkl')
        joblib.dump(self.random_forest, 'models/random_forest.pkl')
        joblib.dump(self.scaler, 'models/scaler.pkl')
        
        self.logger.info("Fraud detection models trained and saved successfully")

    def save_fraud_report(self, farmer_id, fraud_analysis, blockchain_hash):
        """Save fraud analysis report to blockchain and database"""
        report = {
            'farmer_id': farmer_id,
            'analysis_timestamp': datetime.now().isoformat(),
            'fraud_score': fraud_analysis['fraud_score'],
            'risk_level': fraud_analysis['risk_level'],
            'fraud_indicators': fraud_analysis['fraud_indicators'],
            'blockchain_hash': blockchain_hash,
            'requires_investigation': fraud_analysis['requires_field_verification']
        }
        
        # Save to blockchain (would implement actual blockchain integration)
        # Save to database (would implement actual database save)
        
        self.logger.info(f"Fraud report saved for farmer {farmer_id} with risk level {fraud_analysis['risk_level']}")
        
        return report