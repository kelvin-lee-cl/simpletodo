# Netlify Deployment Fix

## Issue
Netlify couldn't deploy because the `netlify.toml` was in the wrong location.

## Solution
Created `netlify.toml` at the **root level** of the repository with correct paths.

## Configuration

**Root `netlify.toml`:**
- Build command: `cd simpletodo && node build.js`
- Publish directory: `simpletodo`

## Next Steps

### Option 1: Automatic Deployment (Recommended)
1. Go to Netlify Dashboard: https://app.netlify.com
2. Connect your GitHub repository: `kelvin-lee-cl/simpletodo`
3. Netlify will automatically detect the `netlify.toml` file
4. Set environment variables (see below)
5. Deploy!

### Option 2: Manual Deployment via Netlify Dashboard
1. Go to Netlify Dashboard: https://app.netlify.com
2. Create new site → Deploy manually
3. Drag and drop the `simpletodo` folder
4. Set environment variables

### Required Environment Variables

In Netlify Dashboard → Site Settings → Environment Variables:

```
VITE_FIREBASE_API_KEY=AIzaSyDGsCT7vbnZUW1ftP0aWlUUE0EBX5yAlG4
VITE_FIREBASE_AUTH_DOMAIN=simpletodo-d088e.firebaseapp.com
VITE_FIREBASE_PROJECT_ID=simpletodo-d088e
VITE_FIREBASE_STORAGE_BUCKET=simpletodo-d088e.firebasestorage.app
VITE_FIREBASE_MESSAGING_SENDER_ID=1090404696953
VITE_FIREBASE_APP_ID=1:1090404696953:web:77944ee04e4e58e21f65a8
VITE_FIREBASE_MEASUREMENT_ID=G-JCTWN23GGQ
```

### Important: Enable Google Sign-In

1. Go to Firebase Console: https://console.firebase.google.com/project/simpletodo-d088e/authentication
2. Enable "Google" sign-in method
3. Add your Netlify domain to authorized domains

### Set Firestore Security Rules

1. Go to: https://console.firebase.google.com/project/simpletodo-d088e/firestore/rules
2. Copy rules from `FIRESTORE_SECURITY_RULES.md`
3. Publish

## Build Process

When Netlify builds:
1. Runs `cd simpletodo && node build.js`
2. This generates `config.js` from environment variables
3. Publishes the `simpletodo` directory
4. Your app is live!

## Troubleshooting

If deployment fails:
- Check build logs in Netlify dashboard
- Verify environment variables are set
- Ensure `build.js` has execute permissions
- Check that Node.js version is 18+ in Netlify settings
