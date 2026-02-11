#!/usr/bin/env node

/**
 * Build script for Netlify deployment
 * Generates config.js from environment variables
 */

const fs = require('fs');
const path = require('path');

// Get environment variables (Netlify provides these)
const config = {
    apiKey: process.env.VITE_FIREBASE_API_KEY || process.env.FIREBASE_API_KEY,
    authDomain: process.env.VITE_FIREBASE_AUTH_DOMAIN || process.env.FIREBASE_AUTH_DOMAIN,
    projectId: process.env.VITE_FIREBASE_PROJECT_ID || process.env.FIREBASE_PROJECT_ID,
    storageBucket: process.env.VITE_FIREBASE_STORAGE_BUCKET || process.env.FIREBASE_STORAGE_BUCKET,
    messagingSenderId: process.env.VITE_FIREBASE_MESSAGING_SENDER_ID || process.env.FIREBASE_MESSAGING_SENDER_ID,
    appId: process.env.VITE_FIREBASE_APP_ID || process.env.FIREBASE_APP_ID,
    measurementId: process.env.VITE_FIREBASE_MEASUREMENT_ID || process.env.FIREBASE_MEASUREMENT_ID
};

// Check if all required config values are present
const missing = Object.entries(config)
    .filter(([key, value]) => !value)
    .map(([key]) => key);

if (missing.length > 0) {
    console.warn('Warning: Missing environment variables:', missing.join(', '));
    console.warn('Using default values from config.js if it exists, or fallback values.');
}

// Generate config.js content
const configJsContent = `// Firebase Configuration
// This file is auto-generated during build
// DO NOT commit this file to version control (it's gitignored)

window.firebaseConfig = {
    apiKey: "${config.apiKey || 'AIzaSyCwo-oly7ZSt5Z_4AbCcuIvq8yqEK31hzw'}",
    authDomain: "${config.authDomain || 'simpledolist.firebaseapp.com'}",
    projectId: "${config.projectId || 'simpledolist'}",
    storageBucket: "${config.storageBucket || 'simpledolist.firebasestorage.app'}",
    messagingSenderId: "${config.messagingSenderId || '487829472007'}",
    appId: "${config.appId || '1:487829472007:web:3afd1cae84736f71fe3ba2'}",
    measurementId: "${config.measurementId || 'G-C5Q00G5F5E'}"
};
`;

// Write config.js
const configPath = path.join(__dirname, 'config.js');
fs.writeFileSync(configPath, configJsContent, 'utf8');
console.log('✓ Generated config.js from environment variables');
