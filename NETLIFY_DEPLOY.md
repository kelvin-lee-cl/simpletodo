# Netlify Deployment Guide

This guide will help you deploy the SimpleTodo app to Netlify.

## Prerequisites

- A Netlify account (sign up at https://netlify.com)
- Your Firebase project credentials

## Deployment Steps

### Option 1: Deploy via Netlify Dashboard (Recommended)

1. **Push your code to GitHub**
   - Make sure your code is pushed to your GitHub repository

2. **Connect to Netlify**
   - Go to https://app.netlify.com
   - Click "Add new site" > "Import an existing project"
   - Connect to GitHub and select your `simpletodo` repository

3. **Configure Build Settings**
   - Build command: `node build.js`
   - Publish directory: `.` (current directory)

4. **Set Environment Variables**
   - Go to Site settings > Environment variables
   - Add the following variables:
     ```
     VITE_FIREBASE_API_KEY=AIzaSyCwo-oly7ZSt5Z_4AbCcuIvq8yqEK31hzw
     VITE_FIREBASE_AUTH_DOMAIN=simpledolist.firebaseapp.com
     VITE_FIREBASE_PROJECT_ID=simpledolist
     VITE_FIREBASE_STORAGE_BUCKET=simpledolist.firebasestorage.app
     VITE_FIREBASE_MESSAGING_SENDER_ID=487829472007
     VITE_FIREBASE_APP_ID=1:487829472007:web:3afd1cae84736f71fe3ba2
     VITE_FIREBASE_MEASUREMENT_ID=G-C5Q00G5F5E
     ```

5. **Deploy**
   - Click "Deploy site"
   - Netlify will run the build command and deploy your site

### Option 2: Deploy via Netlify CLI

1. **Install Netlify CLI**
   ```bash
   npm install -g netlify-cli
   ```

2. **Login to Netlify**
   ```bash
   netlify login
   ```

3. **Initialize Netlify**
   ```bash
   netlify init
   ```
   - Follow the prompts to connect to your site

4. **Set Environment Variables**
   ```bash
   netlify env:set VITE_FIREBASE_API_KEY "AIzaSyCwo-oly7ZSt5Z_4AbCcuIvq8yqEK31hzw"
   netlify env:set VITE_FIREBASE_AUTH_DOMAIN "simpledolist.firebaseapp.com"
   netlify env:set VITE_FIREBASE_PROJECT_ID "simpledolist"
   netlify env:set VITE_FIREBASE_STORAGE_BUCKET "simpledolist.firebasestorage.app"
   netlify env:set VITE_FIREBASE_MESSAGING_SENDER_ID "487829472007"
   netlify env:set VITE_FIREBASE_APP_ID "1:487829472007:web:3afd1cae84736f71fe3ba2"
   netlify env:set VITE_FIREBASE_MEASUREMENT_ID "G-C5Q00G5F5E"
   ```

5. **Deploy**
   ```bash
   netlify deploy --prod
   ```

## How It Works

- The `build.js` script runs during Netlify's build process
- It reads environment variables and generates `config.js`
- The generated `config.js` is used by `index.html` to initialize Firebase
- `config.js` is gitignored, so it's generated fresh on each deployment

## Troubleshooting

### "Failed to connect to database" Error

1. **Check Environment Variables**: Ensure all Firebase environment variables are set in Netlify
2. **Check Build Logs**: Go to Deploys > [Your deploy] > Build logs to see if build.js ran successfully
3. **Check Browser Console**: Open browser DevTools to see specific Firebase errors

### Build Fails

- Make sure Node.js version is 14+ (check Netlify build settings)
- Verify `build.js` has execute permissions
- Check that all environment variables are set

### Firebase Connection Issues

- Verify Firebase project is active
- Check Firebase Firestore rules allow read/write operations
- Ensure Firebase project billing is enabled (if required)

## Local Development

For local development, create a `config.js` file (copy from `config.example.js`) with your Firebase credentials. The app will use this file when running locally.
