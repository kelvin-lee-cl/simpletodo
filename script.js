// Task management and time tracking application

class TodoApp {
    constructor() {
        this.tasks = [];
        this.remark = null;
        this.totalFocusTime = 0;
        this.totalIdlingTime = 0;
        this.lastActivityTime = Date.now();
        this.currentTrackingTaskId = null;
        this.trackingStartTime = null;
        this.idlingStartTime = Date.now();
        this.lastResetTime = null;
        this.db = null;
        this.auth = null;
        this.userId = null;
        this.statsDocRef = null;
        this.tasksCollectionRef = null;
        this.remarkDocRef = null;
        this.isInitialized = false;
        this.quotaExceeded = false;
        this.pendingIdlingTime = 0; // Accumulate idling time locally before saving
        this.idlingSaveInterval = null; // Separate interval for saving to Firebase
        this.firebaseListeners = {
            tasks: null,
            stats: null,
            remark: null
        }; // Store listener unsubscribe functions
        this.updateDebounceTimers = {}; // Debounce timers for task updates
        this.selectedCodingTaskId = null; // Which coding task's checklist is shown inline under the task
        this.checklistPage = {}; // Track current page for each task's checklist
        this.checklistPageSize = 3; // Show 3 sub-tasks per page
        this.checklistKeyboardHandler = null; // Keyboard event handler for checklist navigation

        // Wait for auth to be available before initializing
        this.waitForAuth();
    }

    // Helper function for user-specific localStorage keys
    getUserStorageKey(key) {
        return this.userId ? `${key}_${this.userId}` : key;
    }

    async waitForAuth() {
        // Wait for Firebase auth to be available
        let retries = 0;
        const maxRetries = 50; // 5 seconds max wait
        while (!window.auth && retries < maxRetries) {
            await new Promise(resolve => setTimeout(resolve, 100));
            retries++;
        }

        if (!window.auth) {
            console.warn('Firebase auth not initialized - app will wait for user authentication');
            return;
        }

        this.auth = window.auth;
        
        // Check if user is already authenticated
        const { onAuthStateChanged } = await import("https://www.gstatic.com/firebasejs/10.7.1/firebase-auth.js");
        onAuthStateChanged(this.auth, (user) => {
            if (user) {
                this.userId = user.uid;
                console.log('✅ User authenticated:', user.email);
                if (!this.isInitialized) {
                    this.initFirebase();
                }
            } else {
                this.userId = null;
                this.isInitialized = false;
                // Stop all Firebase operations when user signs out
                this.stopAllFirebaseOperations();
            }
        });
    }

    async initFirebase() {
        // Check if user is authenticated
        if (!this.userId) {
            console.warn('Cannot initialize Firebase - user not authenticated');
            return;
        }

        // Wait for Firebase to be available
        let retries = 0;
        const maxRetries = 50; // 5 seconds max wait
        while (!window.db && retries < maxRetries) {
            await new Promise(resolve => setTimeout(resolve, 100));
            retries++;
        }

        if (!window.db) {
            console.error('Firebase database not initialized after timeout');
            alert('Failed to connect to database. Please refresh the page.');
            return;
        }

        // Import Firestore functions
        const { collection, doc, getDoc, setDoc, addDoc, updateDoc, deleteDoc, onSnapshot, query, orderBy } = await import("https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js");

        this.db = window.db;
        if (!this.db) {
            console.error('Firebase database instance is null');
            alert('Database connection failed. Please check your Firebase configuration.');
            return;
        }

        this.collection = collection;
        this.doc = doc;
        this.getDoc = getDoc;
        this.setDoc = setDoc;
        this.addDoc = addDoc;
        this.updateDoc = updateDoc;
        this.deleteDoc = deleteDoc;
        this.onSnapshot = onSnapshot;
        this.query = query;
        this.orderBy = orderBy;

        // Set up Firestore references - USER-SPECIFIC paths
        // Each user has their own stats, tasks collection, and remark
        this.statsDocRef = doc(this.db, 'users', this.userId, 'stats', 'userStats');
        this.tasksCollectionRef = collection(this.db, 'users', this.userId, 'tasks');
        this.remarkDocRef = doc(this.db, 'users', this.userId, 'remark', 'userRemark');

        if (!this.statsDocRef || !this.tasksCollectionRef || !this.remarkDocRef) {
            console.error('Failed to create Firestore references');
            alert('Failed to initialize database references. Please check your Firebase configuration.');
            return;
        }

        // Load initial data
        await this.loadStats();
        await this.loadTasks();
        await this.loadRemark();

        // Only set up listeners if quota not exceeded
        if (!this.quotaExceeded) {
            this.setupRealtimeListeners();
        } else {
            console.warn('⚠️ Quota exceeded - skipping Firebase listeners setup');
            this.loadFromLocalStorage();
        }

        this.isInitialized = true;
        this.init();

        // Only run write test when recovering from quota (saves 1 write + 1 delete per page load)
        if (this.quotaExceeded) {
            this.testFirebaseWrite();
        }

        // Check if quota was already exceeded (from previous session or error)
        // If so, stop any running intervals
        if (this.quotaExceeded && this.idlingSaveInterval) {
            clearInterval(this.idlingSaveInterval);
            this.idlingSaveInterval = null;
            console.log('✅ Stopped idling save interval on init - quota exceeded');
        }
    }

    async testFirebaseWrite() {
        // Test if we can write to Firebase
        try {
            const testDocRef = this.doc(this.db, 'test', 'write-permission');
            await this.setDoc(testDocRef, {
                timestamp: Date.now(),
                test: true
            }, { merge: true });
            console.log('✅ Firebase write test successful - writes are allowed');
            // If quota was exceeded before, reset the flag and resume operations
            if (this.quotaExceeded) {
                console.log('✅ Quota recovered - resuming Firebase operations');
                this.quotaExceeded = false;
                
                // Restart Firebase listeners if they were stopped
                if (!this.firebaseListeners.tasks) {
                    console.log('🔄 Restarting Firebase listeners...');
                    this.setupRealtimeListeners();
                }
                
                // Restart idling timer save interval if needed
                if (!this.idlingSaveInterval && !this.currentTrackingTaskId) {
                    this.startIdlingTimer();
                }
                
                // Clear the session warning flag
                sessionStorage.removeItem('quotaWarningShown');
            }
            // Clean up test document
            setTimeout(async () => {
                try {
                    await this.deleteDoc(testDocRef);
                } catch (e) {
                    // Ignore cleanup errors
                }
            }, 1000);
        } catch (error) {
            console.error('❌ Firebase write test failed:', error);
            if (error.code === 'resource-exhausted' || error.message?.toLowerCase().includes('quota')) {
                console.error('⚠️ Firebase quota exceeded - stopping all Firebase operations');
                // Only stop operations if not already stopped
                if (!this.quotaExceeded) {
                    this.stopAllFirebaseOperations();
                }
            } else {
                console.error('This likely means Firestore security rules are blocking writes.');
                console.error('Please check your Firestore security rules at: https://console.firebase.google.com/project/simpletodo-d088e/firestore/rules');
                // Don't set quotaExceeded for non-quota errors (like permission errors)
            }
        }
    }

    async testFirebaseConnection(event) {
        // Get button element
        let button;
        if (event && event.target) {
            button = event.target;
        } else {
            button = document.querySelector('.btn-test-firebase');
        }

        if (!button) {
            console.error('Test Firebase button not found');
            return;
        }

        const originalText = button.textContent;

        // Disable button and show loading state
        button.disabled = true;
        button.textContent = 'Testing...';
        button.classList.add('testing');

        let testResults = {
            initialized: false,
            read: false,
            write: false,
            error: null,
            quotaExceeded: false
        };

        try {
            // Test 1: Check if Firebase is initialized
            if (!this.isInitialized) {
                throw new Error('Firebase is not initialized yet. Please wait for the app to finish loading.');
            }

            if (!this.db) {
                throw new Error('Database connection is not available.');
            }

            testResults.initialized = true;
            console.log('✅ Firebase is initialized');

            // Test 2: Test read access (skip if quota exceeded)
            try {
                const testReadRef = this.doc(this.db, 'test', 'connection-test');
                await this.getDoc(testReadRef);
                testResults.read = true;
                console.log('✅ Firebase read test successful');
            } catch (readError) {
                if (readError.code === 'resource-exhausted') {
                    testResults.quotaExceeded = true;
                    console.warn('⚠️ Firebase quota exceeded - skipping read test');
                } else {
                    console.warn('⚠️ Firebase read test failed:', readError);
                }
                testResults.read = false;
            }

            // Test 3: Test write access (skip if quota exceeded)
            if (!testResults.quotaExceeded) {
                try {
                    const testWriteRef = this.doc(this.db, 'test', 'connection-test');
                    await this.setDoc(testWriteRef, {
                        timestamp: Date.now(),
                        test: true,
                        message: 'Connection test'
                    }, { merge: true });
                    testResults.write = true;
                    console.log('✅ Firebase write test successful');

                    // Clean up test document after a delay
                    setTimeout(async () => {
                        try {
                            await this.deleteDoc(testWriteRef);
                            console.log('✅ Test document cleaned up');
                        } catch (e) {
                            console.warn('Could not clean up test document:', e);
                        }
                    }, 2000);
                } catch (writeError) {
                    if (writeError.code === 'resource-exhausted') {
                        testResults.quotaExceeded = true;
                        console.error('❌ Firebase quota exceeded');
                    } else {
                        console.error('❌ Firebase write test failed:', writeError);
                        testResults.error = writeError;
                    }
                    testResults.write = false;
                }
            }

            // Show results
            let message = 'Firebase Connection Test Results:\n\n';
            message += `Initialized: ${testResults.initialized ? '✅ Yes' : '❌ No'}\n`;

            if (testResults.quotaExceeded) {
                message += `Read Access: ⚠️ Skipped (Quota Exceeded)\n`;
                message += `Write Access: ⚠️ Skipped (Quota Exceeded)\n\n`;
                message += '❌ Firebase Quota Exceeded!\n\n';
                message += 'Your Firebase project has reached its quota limit.\n';
                message += 'This usually happens with the free tier when:\n';
                message += '- Too many read/write operations\n';
                message += '- Too many real-time listeners\n';
                message += '- Too many document updates\n\n';
                message += 'Solutions:\n';
                message += '1. Wait a few minutes and try again\n';
                message += '2. Upgrade your Firebase plan\n';
                message += '3. Reduce the number of operations\n';
                message += '4. Check Firebase console for quota details\n\n';
                message += 'Firebase Console: https://console.firebase.google.com/project/simpletodo-d088e/usage';
                button.classList.remove('testing');
                button.classList.add('error');
                setTimeout(() => {
                    button.classList.remove('error');
                }, 5000);
            } else {
                message += `Read Access: ${testResults.read ? '✅ Yes' : '❌ No'}\n`;
                message += `Write Access: ${testResults.write ? '✅ Yes' : '❌ No'}\n\n`;

                if (testResults.write && testResults.read) {
                    message += '✅ All tests passed! Firebase is working correctly.';
                    // If quota was exceeded before, reset the flag and resume saves
                    if (this.quotaExceeded) {
                        this.quotaExceeded = false;
                        message += '\n\n✅ Quota recovered - resuming Firebase saves.';
                        // Restart idling timer save interval if needed
                        if (!this.idlingSaveInterval && !this.currentTrackingTaskId) {
                            this.startIdlingTimer();
                        }
                    }
                    button.classList.remove('testing');
                    button.classList.add('success');
                    setTimeout(() => {
                        button.classList.remove('success');
                    }, 3000);
                } else if (!testResults.write) {
                    message += '⚠️ Write access failed. This is likely a Firestore security rules issue.\n\n';
                    message += 'Please check your Firestore security rules at:\n';
                    message += 'https://console.firebase.google.com/project/simpletodo-d088e/firestore/rules\n\n';
                    message += 'See README.md for the required security rules.';
                    if (testResults.error) {
                        message += `\n\nError: ${testResults.error.message || testResults.error}`;
                        if (testResults.error.code) {
                            message += `\nError Code: ${testResults.error.code}`;
                        }
                    }
                    button.classList.remove('testing');
                    button.classList.add('error');
                    setTimeout(() => {
                        button.classList.remove('error');
                    }, 3000);
                } else {
                    message += '⚠️ Some tests failed. Check the browser console for details.';
                    button.classList.remove('testing');
                }
            }

            alert(message);

        } catch (error) {
            console.error('❌ Firebase connection test failed:', error);
            let errorMessage = `❌ Firebase Connection Test Failed:\n\n${error.message || error}`;
            if (error.code === 'resource-exhausted') {
                errorMessage += '\n\n⚠️ Firebase Quota Exceeded!\n';
                errorMessage += 'Your Firebase project has reached its quota limit.\n';
                errorMessage += 'Please wait a few minutes and try again, or upgrade your Firebase plan.';
            } else {
                errorMessage += '\n\nPlease check:\n1. Firebase is properly configured\n2. Internet connection is working\n3. Browser console for more details';
            }
            alert(errorMessage);
            button.classList.remove('testing');
            button.classList.add('error');
            setTimeout(() => {
                button.classList.remove('error');
            }, 3000);
        } finally {
            // Re-enable button
            button.disabled = false;
            button.textContent = originalText;
        }
    }

    async loadStats() {
        // OPTIMIZATION: Load stats once, no real-time listener
        // This reduces Firebase reads significantly
        try {
            // Only load if quota not exceeded
            if (this.quotaExceeded) {
                // Load from localStorage only (user-specific)
                if (this.userId) {
                    this.totalFocusTime = parseInt(localStorage.getItem(this.getUserStorageKey('totalFocusTime'))) || 0;
                    this.totalIdlingTime = parseInt(localStorage.getItem(this.getUserStorageKey('totalIdlingTime'))) || 0;
                    this.pendingIdlingTime = parseInt(localStorage.getItem(this.getUserStorageKey('pendingIdlingTime'))) || 0;
                    const savedResetTime = localStorage.getItem(this.getUserStorageKey('lastResetTime'));
                    this.lastResetTime = savedResetTime ? parseInt(savedResetTime) : null;
                }
                this.updateLastResetTimeDisplay();
                return;
            }

            const statsSnap = await this.getDoc(this.statsDocRef);
            if (statsSnap.exists()) {
                const data = statsSnap.data();
                this.totalFocusTime = data.totalFocusTime || 0;
                this.totalIdlingTime = data.totalIdlingTime || 0;
                // Load last reset time (could be timestamp or number)
                const resetTime = data.lastResetTime;
                if (resetTime) {
                    this.lastResetTime = resetTime?.toMillis?.() || resetTime || null;
                }
            } else {
                // Create initial stats document (only if quota not exceeded)
                if (!this.quotaExceeded) {
                    await this.setDoc(this.statsDocRef, {
                        totalFocusTime: 0,
                        totalIdlingTime: 0,
                        lastResetTime: null
                    });
                }
            }

            // Check for pending idling time in localStorage and add it (user-specific)
            const pendingIdling = this.userId ? parseInt(localStorage.getItem(this.getUserStorageKey('pendingIdlingTime'))) || 0 : 0;
            if (pendingIdling > 0 && !this.quotaExceeded) {
                this.totalIdlingTime += pendingIdling;
                this.pendingIdlingTime = pendingIdling;
                // Try to save the pending time
                await this.saveIdlingTime();
            }
        } catch (error) {
            console.error('Error loading stats:', error);
            if (error.code === 'resource-exhausted' || error.message?.toLowerCase().includes('quota')) {
                console.warn('⚠️ Quota exceeded during stats load - stopping all Firebase operations');
                this.stopAllFirebaseOperations();
            }
            // Fallback to localStorage if Firebase fails (user-specific)
            if (this.userId) {
                this.totalFocusTime = parseInt(localStorage.getItem(`totalFocusTime_${this.userId}`)) || 0;
                this.totalIdlingTime = parseInt(localStorage.getItem(`totalIdlingTime_${this.userId}`)) || 0;
                this.pendingIdlingTime = parseInt(localStorage.getItem(`pendingIdlingTime_${this.userId}`)) || 0;
                const savedResetTime = localStorage.getItem(`lastResetTime_${this.userId}`);
                this.lastResetTime = savedResetTime ? parseInt(savedResetTime) : null;
            }
        }
        this.updateLastResetTimeDisplay();
    }

    async loadTasks() {
        try {
            // Tasks will be loaded via real-time listener
            // This is just a placeholder for any initial setup needed
        } catch (error) {
            console.error('Error loading tasks:', error);
            // Fallback to localStorage (user-specific)
            if (this.userId) {
                this.tasks = JSON.parse(localStorage.getItem(this.getUserStorageKey('tasks'))) || [];
            }
        }
    }

    async loadRemark() {
        // OPTIMIZATION: Load remark once, no real-time listener
        // This reduces Firebase reads significantly
        try {
            // Only load if quota not exceeded
            if (this.quotaExceeded) {
                // Load from localStorage only (user-specific)
                if (this.userId) {
                    const savedRemark = localStorage.getItem(this.getUserStorageKey('remark'));
                    this.remark = savedRemark ? { content: savedRemark } : null;
                }
                return;
            }

            // Load remark once from Firebase (no real-time listener)
            const remarkSnap = await this.getDoc(this.remarkDocRef);
            if (remarkSnap.exists()) {
                const data = remarkSnap.data();
                this.remark = {
                    id: remarkSnap.id,
                    content: data.content || '',
                    updatedAt: data.updatedAt?.toMillis?.() || data.updatedAt || Date.now()
                };
            } else {
                this.remark = null;
            }
        } catch (error) {
            console.error('Error loading remark:', error);
            if (error.code === 'resource-exhausted' || error.message?.toLowerCase().includes('quota')) {
                console.warn('⚠️ Quota exceeded during remark load');
                // Don't stop all operations for remark load failure
            }
            // Fallback to localStorage (user-specific)
            if (this.userId) {
                const savedRemark = localStorage.getItem(this.getUserStorageKey('remark'));
                this.remark = savedRemark ? { content: savedRemark } : null;
            }
        }
    }

    loadFromLocalStorage() {
        if (!this.userId) {
            console.warn('Cannot load from localStorage - user not authenticated');
            return;
        }
        
        // Load tasks from localStorage (user-specific)
        try {
            const savedTasks = localStorage.getItem(this.getUserStorageKey('tasks'));
            if (savedTasks) {
                this.tasks = JSON.parse(savedTasks);
                this.renderTasks();
            }
        } catch (e) {
            console.warn('Could not load tasks from localStorage:', e);
        }
        
        // Load remark from localStorage (user-specific)
        const savedRemark = localStorage.getItem(this.getUserStorageKey('remark'));
        if (savedRemark) {
            this.remark = { content: savedRemark };
            this.renderRemark();
        }
    }

    stopAllFirebaseOperations() {
        // Prevent multiple calls
        if (this.quotaExceeded) {
            return;
        }

        console.log('🛑 Stopping all Firebase operations due to quota exceeded');
        this.quotaExceeded = true;

        // Stop all real-time listeners
        if (this.firebaseListeners.tasks) {
            try {
                this.firebaseListeners.tasks();
            } catch (e) {
                console.warn('Error stopping tasks listener:', e);
            }
            this.firebaseListeners.tasks = null;
            console.log('✅ Stopped tasks listener');
        }
        if (this.firebaseListeners.stats) {
            try {
                this.firebaseListeners.stats();
            } catch (e) {
                console.warn('Error stopping stats listener:', e);
            }
            this.firebaseListeners.stats = null;
            console.log('✅ Stopped stats listener');
        }
        if (this.firebaseListeners.remark) {
            try {
                this.firebaseListeners.remark();
            } catch (e) {
                console.warn('Error stopping remark listener:', e);
            }
            this.firebaseListeners.remark = null;
            console.log('✅ Stopped remark listener');
        }

        // Stop idling timer save interval
        if (this.idlingSaveInterval) {
            clearInterval(this.idlingSaveInterval);
            this.idlingSaveInterval = null;
            console.log('✅ Stopped idling save interval');
        }

        // Remove checklist keyboard navigation
        this.removeChecklistKeyboardNavigation();

        // Save current state to localStorage (user-specific)
        if (!this.userId) return;
        
        try {
            localStorage.setItem(this.getUserStorageKey('totalIdlingTime'), this.totalIdlingTime.toString());
            localStorage.setItem(this.getUserStorageKey('pendingIdlingTime'), this.pendingIdlingTime.toString());
            localStorage.setItem(this.getUserStorageKey('tasks'), JSON.stringify(this.tasks));
            if (this.remark) {
                localStorage.setItem(this.getUserStorageKey('remark'), this.remark.content || '');
            }
            console.log('✅ Saved state to localStorage');
        } catch (e) {
            console.warn('Error saving to localStorage:', e);
        }

        // Show user-friendly message (only once per session)
        if (!sessionStorage.getItem('quotaWarningShown')) {
            setTimeout(() => {
                alert('⚠️ Firebase Quota Exceeded\n\nAll Firebase operations have been stopped to prevent further quota errors.\n\nThe app will now run in offline mode using localStorage.\n\nPlease wait a few minutes or upgrade your Firebase plan.\n\nCheck quota: https://console.firebase.google.com/project/simpletodo-d088e/usage');
                sessionStorage.setItem('quotaWarningShown', 'true');
            }, 1000);
        }

        console.log('✅ All Firebase operations stopped. App running in offline mode.');
    }

    setupRealtimeListeners() {
        // Don't set up listeners if quota is already exceeded
        if (this.quotaExceeded) {
            console.warn('⚠️ Skipping Firebase listeners - quota exceeded');
            // Load from localStorage instead
            this.loadFromLocalStorage();
            return;
        }
        
        // Unsubscribe from existing listeners first to avoid duplicates
        if (this.firebaseListeners.tasks) {
            try {
                this.firebaseListeners.tasks();
            } catch (e) {
                console.warn('Error unsubscribing from tasks listener:', e);
            }
            this.firebaseListeners.tasks = null;
        }
        if (this.firebaseListeners.stats) {
            try {
                this.firebaseListeners.stats();
            } catch (e) {
                console.warn('Error unsubscribing from stats listener:', e);
            }
            this.firebaseListeners.stats = null;
        }
        if (this.firebaseListeners.remark) {
            try {
                this.firebaseListeners.remark();
            } catch (e) {
                console.warn('Error unsubscribing from remark listener:', e);
            }
            this.firebaseListeners.remark = null;
        }

        // Listen for tasks changes
        this.firebaseListeners.tasks = this.onSnapshot(this.tasksCollectionRef, (snapshot) => {
            this.tasks = [];
            snapshot.forEach((doc) => {
                const data = doc.data();
                const task = {
                    id: doc.id,
                    ...data,
                    // Ensure elapsedTime is a number
                    elapsedTime: typeof data.elapsedTime === 'number' ? data.elapsedTime : 0,
                    // Convert trackingStartTime if it's a Firestore timestamp
                    trackingStartTime: data.trackingStartTime?.toMillis?.() || data.trackingStartTime || null
                };
                this.tasks.push(task);
            });

            // Sort by order (then by creation time for tasks without order)
            this.tasks.sort((a, b) => {
                const aOrder = typeof a.order === 'number' ? a.order : 999999;
                const bOrder = typeof b.order === 'number' ? b.order : 999999;
                if (aOrder !== bOrder) return aOrder - bOrder;
                const aTime = a.createdAt?.toMillis?.() || a.createdAt?.getTime?.() || new Date(a.createdAt)?.getTime() || 0;
                const bTime = b.createdAt?.toMillis?.() || b.createdAt?.getTime?.() || new Date(b.createdAt)?.getTime() || 0;
                return bTime - aTime;
            });

            // Update current tracking task if it exists
            const trackingTask = this.tasks.find(t => t.isTracking);
            if (trackingTask && trackingTask.trackingStartTime) {
                this.currentTrackingTaskId = trackingTask.id;
                this.trackingStartTime = trackingTask.trackingStartTime;
            } else if (!trackingTask && this.currentTrackingTaskId) {
                // Task was stopped elsewhere, clear local tracking
                this.currentTrackingTaskId = null;
                this.trackingStartTime = null;
            }

            if (this.isInitialized) {
                this.renderTasks();
                this.updateDashboard();
            }
        }, (error) => {
            console.error('Error listening to tasks:', error);
            if (error.code === 'resource-exhausted') {
                console.error('⚠️ Firebase Quota Exceeded! Stopping all Firebase operations.');
                this.stopAllFirebaseOperations();
                if (!sessionStorage.getItem('quotaWarningShown')) {
                    setTimeout(() => {
                        alert('⚠️ Firebase Quota Exceeded!\n\nAll Firebase operations have been stopped to prevent further quota errors.\n\nThe app will now run in offline mode using localStorage.\n\nPlease wait a few minutes or upgrade your Firebase plan.\n\nCheck quota: https://console.firebase.google.com/project/simpletodo-d088e/usage');
                        sessionStorage.setItem('quotaWarningShown', 'true');
                    }, 1000);
                }
            }
        });

        // OPTIMIZATION: Removed stats and remark real-time listeners
        // These don't need real-time updates - using localStorage + periodic sync instead
        // This reduces Firebase reads by ~30-40%
        // Stats and remark are loaded once on init and updated via writes only

        // Stats and remark will be:
        // - Loaded once on initialization
        // - Updated via writes (not real-time reads)
        // - Synced from localStorage when needed
        console.log('✅ Using optimized listener setup: Only tasks listener active (stats/remark use localStorage)');
    }

    init() {
        this.renderTasks();
        this.renderRemark();
        this.updateDashboard();
        this.setupEventListeners();
        this.setupChecklistColumnResponsive();
        this.startIdlingTimer();
        this.loadSectionStates();
        this.startDeadlineColorUpdate();
    }

    /**
     * Checklist is always shown inline under the selected coding task. Remove the right column from DOM
     * so the task list is full width and there is no empty side panel.
     */
    setupChecklistColumnResponsive() {
        const column = document.getElementById('codingChecklistColumn');
        if (column && column.parentNode) {
            column.remove();
        }
    }

    setupEventListeners() {
        const form = document.getElementById('taskForm');
        form.addEventListener('submit', (e) => {
            e.preventDefault();
            this.addTask();
        });

        // Set default date to today
        const dateInput = document.getElementById('deadlineDate');
        const today = new Date().toISOString().split('T')[0];
        dateInput.value = today;
        dateInput.min = today;

        this.fillTimeSelects();
        this.loadAddTaskSectionState();

        // Add Coding Task modal
        const addCodingBtn = document.getElementById('add-coding-task-btn');
        const codingModal = document.getElementById('coding-task-modal');
        const codingModalClose = document.getElementById('coding-modal-close');
        const codingModalCancel = document.getElementById('coding-modal-cancel');
        const codingTaskForm = document.getElementById('codingTaskForm');

        if (addCodingBtn) {
            addCodingBtn.addEventListener('click', () => this.openCodingTaskModal());
        }
        if (codingModalClose) {
            codingModalClose.addEventListener('click', () => this.closeCodingTaskModal());
        }
        if (codingModalCancel) {
            codingModalCancel.addEventListener('click', () => this.closeCodingTaskModal());
        }
        if (codingModal) {
            codingModal.addEventListener('click', (e) => { if (e.target === codingModal) this.closeCodingTaskModal(); });
        }
        if (codingTaskForm) {
            codingTaskForm.addEventListener('submit', (e) => {
                e.preventDefault();
                this.addCodingTask();
            });
        }

        this.fillCodingTimeSelects();
        const codingDateInput = document.getElementById('codingDeadlineDate');
        if (codingDateInput) {
            const today = new Date().toISOString().split('T')[0];
            codingDateInput.value = today;
            codingDateInput.min = today;
        }

        this.setupCodingChecklistFinishDelegation();
        this.setupCodingChecklistInlineDelegation();
        const hideChecklistBtn = document.getElementById('hideChecklistBtn');
        if (hideChecklistBtn) {
            hideChecklistBtn.addEventListener('click', () => this.selectCodingTask(null));
        }
    }

    fillTimeSelects() {
        const hourSelect = document.getElementById('deadlineTimeHour');
        const minSelect = document.getElementById('deadlineTimeMin');
        if (!hourSelect || !minSelect) return;
        hourSelect.innerHTML = '';
        for (let h = 0; h < 24; h++) {
            const opt = document.createElement('option');
            opt.value = String(h).padStart(2, '0');
            opt.textContent = String(h).padStart(2, '0');
            hourSelect.appendChild(opt);
        }
        minSelect.innerHTML = '';
        ['00', '15', '30', '45'].forEach(m => {
            const opt = document.createElement('option');
            opt.value = m;
            opt.textContent = m;
            minSelect.appendChild(opt);
        });
        const now = new Date();
        hourSelect.value = String(now.getHours()).padStart(2, '0');
        const min = now.getMinutes();
        minSelect.value = ['00', '15', '30', '45'][Math.min(3, Math.floor(min / 15))];
    }

    fillCodingTimeSelects() {
        const hourSelect = document.getElementById('codingDeadlineTimeHour');
        const minSelect = document.getElementById('codingDeadlineTimeMin');
        if (!hourSelect || !minSelect) return;
        hourSelect.innerHTML = '';
        for (let h = 0; h < 24; h++) {
            const opt = document.createElement('option');
            opt.value = String(h).padStart(2, '0');
            opt.textContent = String(h).padStart(2, '0');
            hourSelect.appendChild(opt);
        }
        minSelect.innerHTML = '';
        ['00', '15', '30', '45'].forEach(m => {
            const opt = document.createElement('option');
            opt.value = m;
            opt.textContent = m;
            minSelect.appendChild(opt);
        });
        const now = new Date();
        hourSelect.value = String(now.getHours()).padStart(2, '0');
        const min = now.getMinutes();
        minSelect.value = ['00', '15', '30', '45'][Math.min(3, Math.floor(min / 15))];
    }

    openCodingTaskModal() {
        const modal = document.getElementById('coding-task-modal');
        if (!modal) return;
        const today = new Date().toISOString().split('T')[0];
        const dateInput = document.getElementById('codingDeadlineDate');
        if (dateInput) {
            dateInput.value = today;
            dateInput.min = today;
        }
        this.fillCodingTimeSelects();
        document.getElementById('codingTaskTitle').value = '';
        document.getElementById('codingCsvPaste').value = '';
        const hyperlinkInput = document.getElementById('codingTaskHyperlink');
        if (hyperlinkInput) hyperlinkInput.value = '';
        modal.style.display = 'flex';
        modal.setAttribute('aria-hidden', 'false');
    }

    closeCodingTaskModal() {
        const modal = document.getElementById('coding-task-modal');
        if (modal) {
            modal.style.display = 'none';
            modal.setAttribute('aria-hidden', 'true');
        }
    }

    /**
     * Parse CSV text with quoted fields. Returns { headers: string[], rows: string[][] }.
     * First row = headers, rest = data rows.
     */
    parseCSV(csvText) {
        const lines = csvText.trim().split(/\r?\n/).filter(line => line.trim());
        if (lines.length === 0) return { headers: [], rows: [] };

        const parseLine = (line) => {
            const out = [];
            let i = 0;
            while (i < line.length) {
                if (line[i] === '"') {
                    i++;
                    let field = '';
                    while (i < line.length && line[i] !== '"') {
                        if (line[i] === '\\') {
                            i++;
                            if (i < line.length) field += line[i++];
                        } else {
                            field += line[i++];
                        }
                    }
                    if (line[i] === '"') i++;
                    out.push(field.trim());
                } else {
                    let field = '';
                    while (i < line.length && line[i] !== ',') {
                        field += line[i++];
                    }
                    out.push(field.trim());
                    if (i < line.length) i++;
                }
            }
            return out;
        };

        const headers = parseLine(lines[0]);
        const rows = lines.slice(1).map(parseLine);
        return { headers, rows };
    }

    /**
     * Build subTasks array from CSV rows. Expects headers: Task_ID, Week, Cursor_Prompt, Expected_Outcome, Rationale (case-insensitive).
     */
    buildSubTasksFromCSV(csvText) {
        const { headers, rows } = this.parseCSV(csvText);
        const lower = headers.map(h => (h || '').toLowerCase().trim());
        const idx = (name) => {
            const n = name.toLowerCase();
            const i = lower.indexOf(n);
            if (i >= 0) return i;
            const alt = name.replace(/_/g, ' ');
            return lower.indexOf(alt) >= 0 ? lower.indexOf(alt) : -1;
        };
        const taskIdIdx = idx('Task_ID') >= 0 ? idx('Task_ID') : 0;
        const weekIdx = idx('Week') >= 0 ? idx('Week') : 1;
        const promptIdx = idx('Cursor_Prompt') >= 0 ? idx('Cursor_Prompt') : 2;
        const outcomeIdx = idx('Expected_Outcome') >= 0 ? idx('Expected_Outcome') : 3;
        const rationaleIdx = idx('Rationale') >= 0 ? idx('Rationale') : 4;

        return rows.map(row => ({
            taskId: (row[taskIdIdx] || '').trim(),
            week: (row[weekIdx] || '').trim(),
            cursorPrompt: (row[promptIdx] || '').trim(),
            expectedOutcome: (row[outcomeIdx] || '').trim(),
            rationale: (row[rationaleIdx] || '').trim(),
            completed: false
        })).filter(st => st.cursorPrompt || st.taskId || st.expectedOutcome);
    }

    async addCodingTask() {
        if (!this.isInitialized) {
            alert('Please wait for Firebase to initialize...');
            return;
        }
        if (this.quotaExceeded) {
            alert('⚠️ Firebase Quota Exceeded\n\nCannot add task. Please wait a few minutes or upgrade your Firebase plan.');
            return;
        }

        const titleInput = document.getElementById('codingTaskTitle');
        const dateInput = document.getElementById('codingDeadlineDate');
        const hourSelect = document.getElementById('codingDeadlineTimeHour');
        const minSelect = document.getElementById('codingDeadlineTimeMin');
        const csvTextarea = document.getElementById('codingCsvPaste');
        const hyperlinkInput = document.getElementById('codingTaskHyperlink');

        const title = (titleInput && titleInput.value || '').trim();
        if (!title) {
            alert('Please enter a task title.');
            return;
        }

        const subTasks = this.buildSubTasksFromCSV(csvTextarea && csvTextarea.value || '');
        if (subTasks.length === 0) {
            alert('Please paste CSV with at least one data row (headers + at least one sub-task).');
            return;
        }

        const deadline = `${dateInput.value}T${hourSelect.value}:${minSelect.value}`;
        const hyperlink = (hyperlinkInput && hyperlinkInput.value || '').trim();

        try {
            const { Timestamp } = await import("https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js");
            const maxOrder = this.tasks.length === 0 ? 0 : Math.max(...this.tasks.map(t => typeof t.order === 'number' ? t.order : 0), -1) + 1;
            const taskData = {
                description: title,
                deadline,
                completed: false,
                elapsedTime: 0,
                isTracking: false,
                order: maxOrder,
                createdAt: Timestamp.now(),
                isCodingTask: true,
                subTasks,
                hyperlink: hyperlink || null
            };
            await this.addDoc(this.tasksCollectionRef, taskData);
            this.closeCodingTaskModal();
            this.selectedCodingTaskId = null;
            this.removeChecklistKeyboardNavigation();
            this.renderCodingChecklist();
        } catch (error) {
            console.error('Error adding coding task:', error);
            if (error.code === 'resource-exhausted' || error.message?.toLowerCase().includes('quota')) {
                this.stopAllFirebaseOperations();
            } else {
                alert('Failed to add coding task. Please try again.');
            }
        }
    }

    async toggleSubTaskComplete(taskId, subIndex) {
        if (!this.isInitialized || this.quotaExceeded) return;
        const task = this.tasks.find(t => String(t.id) === String(taskId));
        if (!task || !task.isCodingTask || !Array.isArray(task.subTasks) || subIndex < 0 || subIndex >= task.subTasks.length) return;

        // Toggle completed for the sub-task at subIndex (Finish ↔ Done)
        const updatedSubTasks = task.subTasks.map((st, i) =>
            i === subIndex ? { ...st, completed: !st.completed } : st
        );
        const allCompleted = updatedSubTasks.every(st => st.completed);

        try {
            const taskDocRef = this.doc(this.db, 'users', this.userId, 'tasks', String(taskId));
            const update = { subTasks: updatedSubTasks };
            update.completed = allCompleted; // true only when all sub-tasks are done
            await this.updateDoc(taskDocRef, update);
        } catch (error) {
            console.error('Error updating sub-task:', error);
            if (error.code === 'resource-exhausted' || error.message?.toLowerCase().includes('quota')) {
                this.stopAllFirebaseOperations();
            } else {
                alert('Failed to update sub-task.');
            }
        }
    }

    selectCodingTask(taskId) {
        this.selectedCodingTaskId = taskId ? String(taskId) : null;
        const column = document.getElementById('codingChecklistColumn');
        if (column) {
            if (this.selectedCodingTaskId) {
                column.classList.remove('coding-checklist-column-hidden');
                // Restore saved page number for this task (use string format)
                this.restoreChecklistPage(this.selectedCodingTaskId);
                // Setup keyboard navigation
                this.setupChecklistKeyboardNavigation();
            } else {
                column.classList.add('coding-checklist-column-hidden');
                // Remove keyboard navigation when checklist is hidden
                this.removeChecklistKeyboardNavigation();
            }
        }
        // Render after restoring page to ensure correct page is shown
        this.renderCodingChecklist();
    }

    getChecklistPageKey(taskId) {
        return this.getUserStorageKey(`checklist_page_${taskId}`);
    }

    saveChecklistPage(taskId, page) {
        if (!taskId) return;
        const key = this.getChecklistPageKey(taskId);
        try {
            localStorage.setItem(key, String(page));
        } catch (e) {
            console.warn('Failed to save checklist page:', e);
        }
    }

    restoreChecklistPage(taskId) {
        if (!taskId) return;
        const key = this.getChecklistPageKey(taskId);
        try {
            const savedPage = localStorage.getItem(key);
            if (savedPage !== null) {
                this.checklistPage[taskId] = parseInt(savedPage, 10) || 0;
            } else {
                this.checklistPage[taskId] = 0;
            }
        } catch (e) {
            console.warn('Failed to restore checklist page:', e);
            this.checklistPage[taskId] = 0;
        }
    }

    setupChecklistKeyboardNavigation() {
        // Remove existing handler if any
        this.removeChecklistKeyboardNavigation();
        
        this.checklistKeyboardHandler = (e) => {
            // Only handle arrow keys when checklist is visible
            if (!this.selectedCodingTaskId) return;
            
            const taskId = this.selectedCodingTaskId;
            const task = this.tasks.find(t => String(t.id) === String(taskId));
            if (!task || !task.isCodingTask || !Array.isArray(task.subTasks)) return;
            
            const totalPages = Math.ceil(task.subTasks.length / this.checklistPageSize);
            if (totalPages === 0) return;
            
            let currentPage = this.checklistPage[taskId] || 0;
            let newPage = currentPage;
            
            // Handle arrow keys (only left and right)
            if (e.key === 'ArrowRight') {
                // Next page
                e.preventDefault();
                newPage = Math.min(currentPage + 1, totalPages - 1);
            } else if (e.key === 'ArrowLeft') {
                // Previous page
                e.preventDefault();
                newPage = Math.max(currentPage - 1, 0);
            } else {
                return; // Not a left/right arrow key, ignore
            }
            
            if (newPage !== currentPage) {
                this.checklistPage[taskId] = newPage;
                this.saveChecklistPage(taskId, newPage);
                this.renderCodingChecklist();
            }
        };
        
        document.addEventListener('keydown', this.checklistKeyboardHandler);
    }

    removeChecklistKeyboardNavigation() {
        if (this.checklistKeyboardHandler) {
            document.removeEventListener('keydown', this.checklistKeyboardHandler);
            this.checklistKeyboardHandler = null;
        }
    }

    renderCodingChecklist() {
        const taskId = this.selectedCodingTaskId;
        const task = taskId ? this.tasks.find(t => String(t.id) === String(taskId)) : null;

        if (!task || !task.isCodingTask || !Array.isArray(task.subTasks)) {
            const placeholder = document.getElementById('codingChecklistPlaceholder');
            const listEl = document.getElementById('codingChecklistList');
            if (placeholder && listEl) {
                placeholder.style.display = 'block';
                listEl.style.display = 'none';
                listEl.innerHTML = '';
            }
            // Remove hyperlink button when no task is selected
            const checklistHeader = document.querySelector('.coding-checklist-panel-header');
            if (checklistHeader) {
                const existingHyperlinkBtn = checklistHeader.querySelector('.btn-open-hyperlink');
                if (existingHyperlinkBtn) {
                    existingHyperlinkBtn.remove();
                }
            }
            this.renderCodingChecklistInline(null, null, null);
            return;
        }

        const taskIdStr = String(task.id);
        // Ensure taskIdStr matches the key used in checklistPage
        const pageKey = taskIdStr;
        
        // Make sure page is initialized if not already set
        if (this.checklistPage[pageKey] === undefined) {
            this.restoreChecklistPage(pageKey);
        }
        
        const totalSubTasks = task.subTasks.length;
        const totalPages = Math.ceil(totalSubTasks / this.checklistPageSize);
        const currentPage = this.checklistPage[pageKey] || 0;
        const safePage = Math.max(0, Math.min(currentPage, totalPages - 1));
        
        // Ensure page is valid and update if needed
        if (safePage !== currentPage) {
            this.checklistPage[pageKey] = safePage;
            this.saveChecklistPage(pageKey, safePage);
        } else if (this.checklistPage[pageKey] !== safePage) {
            // Update the stored page if it changed
            this.checklistPage[pageKey] = safePage;
            this.saveChecklistPage(pageKey, safePage);
        }

        // Get sub-tasks for current page
        const startIndex = safePage * this.checklistPageSize;
        const endIndex = Math.min(startIndex + this.checklistPageSize, totalSubTasks);
        const pageSubTasks = task.subTasks.slice(startIndex, endIndex);

        const checklistHtml = pageSubTasks.map((st, i) => {
            const actualIndex = startIndex + i; // Actual index in the full subTasks array
            const prompt = this.escapeHtml(st.cursorPrompt);
            const outcome = this.escapeHtml(st.expectedOutcome);
            const rationale = this.escapeHtml(st.rationale);
            const rowId = this.escapeHtml(st.taskId);
            const completed = st.completed;
            return `
                <div class="coding-subtask-row ${completed ? 'completed' : ''}" data-task-id="${this.escapeHtml(taskIdStr)}" data-sub-index="${actualIndex}">
                    <div class="coding-subtask-header">
                        <span class="coding-subtask-id">${rowId || `#${actualIndex + 1}`}</span>
                        <button type="button" class="btn-finish-subtask">${completed ? '✓ Done' : 'Finish'}</button>
                    </div>
                    <div class="coding-subtask-prompt">${prompt || '—'}</div>
                    ${outcome ? `<div class="coding-subtask-meta coding-subtask-outcome"><strong>Expected:</strong> ${outcome}</div>` : ''}
                    ${rationale ? `<div class="coding-subtask-meta coding-subtask-rationale">${rationale}</div>` : ''}
                </div>
            `;
        }).join('');

        // Create pagination controls
        const paginationHtml = totalPages > 1 ? `
            <div class="checklist-pagination">
                <button type="button" class="btn-pagination btn-pagination-prev" ${safePage === 0 ? 'disabled' : ''} 
                    onclick="app.changeChecklistPage('${pageKey}', ${safePage - 1})" 
                    title="Previous page (←)">
                    ← Prev
                </button>
                <span class="checklist-page-info">Page ${safePage + 1} of ${totalPages}</span>
                <button type="button" class="btn-pagination btn-pagination-next" ${safePage >= totalPages - 1 ? 'disabled' : ''} 
                    onclick="app.changeChecklistPage('${pageKey}', ${safePage + 1})" 
                    title="Next page (→)">
                    Next →
                </button>
            </div>
        ` : '';

        // Update checklist header with hyperlink button if task has hyperlink
        const checklistHeader = document.querySelector('.coding-checklist-panel-header');
        if (checklistHeader) {
            const hideBtn = checklistHeader.querySelector('#hideChecklistBtn');
            const existingHyperlinkBtn = checklistHeader.querySelector('.btn-open-hyperlink');
            if (existingHyperlinkBtn) {
                existingHyperlinkBtn.remove();
            }
            if (task.hyperlink) {
                const hyperlinkBtn = document.createElement('button');
                hyperlinkBtn.type = 'button';
                hyperlinkBtn.className = 'btn-open-hyperlink';
                hyperlinkBtn.textContent = '🔗 Open Link';
                hyperlinkBtn.title = 'Open hyperlink in new tab';
                hyperlinkBtn.addEventListener('click', () => {
                    window.open(task.hyperlink, '_blank', 'noopener,noreferrer');
                });
                if (hideBtn) {
                    hideBtn.before(hyperlinkBtn);
                } else {
                    checklistHeader.appendChild(hyperlinkBtn);
                }
            }
        }

        // Update right column only if it exists (e.g. viewport >= 1000px)
        const placeholder = document.getElementById('codingChecklistPlaceholder');
        const listEl = document.getElementById('codingChecklistList');
        if (placeholder && listEl) {
            placeholder.style.display = 'none';
            listEl.style.display = 'flex';
            listEl.innerHTML = checklistHtml + paginationHtml;
            
            // Add event listeners for pagination buttons in right column
            if (paginationHtml) {
                const prevBtn = listEl.querySelector('.btn-pagination-prev');
                const nextBtn = listEl.querySelector('.btn-pagination-next');
                if (prevBtn) {
                    prevBtn.addEventListener('click', () => {
                        this.changeChecklistPage(pageKey, safePage - 1);
                    });
                }
                if (nextBtn) {
                    nextBtn.addEventListener('click', () => {
                        this.changeChecklistPage(pageKey, safePage + 1);
                    });
                }
            }
        }

        // Always show checklist inline under the selected coding task
        this.renderCodingChecklistInline(checklistHtml, paginationHtml, { taskId: pageKey, currentPage: safePage, totalPages });
    }

    changeChecklistPage(taskId, newPage) {
        if (!taskId) return;
        const task = this.tasks.find(t => String(t.id) === String(taskId));
        if (!task || !task.isCodingTask || !Array.isArray(task.subTasks)) return;
        
        const totalPages = Math.ceil(task.subTasks.length / this.checklistPageSize);
        const safePage = Math.max(0, Math.min(newPage, totalPages - 1));
        
        this.checklistPage[taskId] = safePage;
        this.saveChecklistPage(taskId, safePage);
        this.renderCodingChecklist();
    }

    renderCodingChecklistInline(checklistHtml, paginationHtml, paginationInfo) {
        const taskList = document.getElementById('taskList');
        if (!taskList) return;
        const taskId = this.selectedCodingTaskId;

        // Remove any existing inline checklist
        const existing = taskList.querySelector('.coding-checklist-inline');
        if (existing) existing.remove();

        if (!taskId || !checklistHtml) return;

        const selectedItem = taskList.querySelector(`.task-item.coding-task[data-task-id="${this.escapeHtml(taskId)}"]`);
        if (!selectedItem) return;

        const task = this.tasks.find(t => String(t.id) === String(taskId));
        const hyperlinkBtnHtml = task && task.hyperlink 
            ? `<button type="button" class="btn-open-hyperlink-inline" title="Open hyperlink in new tab">🔗 Open Link</button>`
            : '';

        const wrap = document.createElement('div');
        wrap.className = 'coding-checklist-inline';
        wrap.innerHTML = `
            <div class="coding-checklist-inline-header">
                <span class="coding-checklist-inline-title">Checklist</span>
                <div class="coding-checklist-inline-actions">
                    ${hyperlinkBtnHtml}
                    <button type="button" class="btn-hide-checklist-inline">Hide</button>
                </div>
            </div>
            <div class="coding-checklist-list">${checklistHtml}</div>
            ${paginationHtml || ''}
        `;
        wrap.querySelector('.btn-hide-checklist-inline').addEventListener('click', () => this.selectCodingTask(null));
        
        const hyperlinkBtn = wrap.querySelector('.btn-open-hyperlink-inline');
        if (hyperlinkBtn && task && task.hyperlink) {
            hyperlinkBtn.addEventListener('click', () => {
                window.open(task.hyperlink, '_blank', 'noopener,noreferrer');
            });
        }
        
        // Add click handlers for pagination buttons in inline view
        if (paginationInfo) {
            const prevBtn = wrap.querySelector('.btn-pagination-prev');
            const nextBtn = wrap.querySelector('.btn-pagination-next');
            if (prevBtn) {
                prevBtn.addEventListener('click', () => {
                    this.changeChecklistPage(paginationInfo.taskId, paginationInfo.currentPage - 1);
                });
            }
            if (nextBtn) {
                nextBtn.addEventListener('click', () => {
                    this.changeChecklistPage(paginationInfo.taskId, paginationInfo.currentPage + 1);
                });
            }
        }
        
        selectedItem.after(wrap);
    }

    setupCodingChecklistFinishDelegation() {
        const listEl = document.getElementById('codingChecklistList');
        if (!listEl || this.codingChecklistFinishBound) return;
        this.codingChecklistFinishBound = (e) => {
            const btn = e.target.closest('.btn-finish-subtask');
            if (!btn) return;
            const row = btn.closest('.coding-subtask-row');
            if (!row) return;
            const taskId = row.getAttribute('data-task-id');
            const subIndex = row.getAttribute('data-sub-index');
            if (taskId != null && subIndex != null) {
                this.toggleSubTaskComplete(taskId, parseInt(subIndex, 10));
            }
        };
        listEl.addEventListener('click', this.codingChecklistFinishBound);
    }

    setupCodingChecklistInlineDelegation() {
        const taskList = document.getElementById('taskList');
        if (!taskList || this.codingChecklistInlineFinishBound) return;
        this.codingChecklistInlineFinishBound = (e) => {
            const btn = e.target.closest('.btn-finish-subtask');
            if (!btn) return;
            const row = btn.closest('.coding-subtask-row');
            if (!row) return;
            const taskId = row.getAttribute('data-task-id');
            const subIndex = row.getAttribute('data-sub-index');
            if (taskId != null && subIndex != null) {
                this.toggleSubTaskComplete(taskId, parseInt(subIndex, 10));
            }
        };
        taskList.addEventListener('click', this.codingChecklistInlineFinishBound);
    }

    async addTask() {
        if (!this.isInitialized) {
            alert('Please wait for Firebase to initialize...');
            return;
        }

        // Check if quota exceeded
        if (this.quotaExceeded) {
            alert('⚠️ Firebase Quota Exceeded\n\nCannot add task. Please wait a few minutes or upgrade your Firebase plan.\n\nCheck quota: https://console.firebase.google.com/project/simpletodo-d088e/usage');
            return;
        }

        const taskInput = document.getElementById('taskInput');
        const deadlineDate = document.getElementById('deadlineDate');
        const deadlineTimeHour = document.getElementById('deadlineTimeHour');
        const deadlineTimeMin = document.getElementById('deadlineTimeMin');

        try {
            const { Timestamp } = await import("https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js");

            const timeStr = `${deadlineTimeHour.value}:${deadlineTimeMin.value}`;
            const maxOrder = this.tasks.length === 0 ? 0 : Math.max(...this.tasks.map(t => typeof t.order === 'number' ? t.order : 0), -1) + 1;
            const taskData = {
                description: taskInput.value.trim(),
                deadline: `${deadlineDate.value}T${timeStr}`,
                completed: false,
                elapsedTime: 0,
                isTracking: false,
                order: maxOrder,
                createdAt: Timestamp.now()
            };

            await this.addDoc(this.tasksCollectionRef, taskData);
            // Reset form
            taskInput.value = '';
            this.fillTimeSelects();
        } catch (error) {
            console.error('Error adding task:', error);

            // Check if quota exceeded
            if (error.code === 'resource-exhausted' || error.message?.toLowerCase().includes('quota')) {
                this.stopAllFirebaseOperations();
            } else {
                alert('Failed to add task. Please try again.');
            }
        }
    }

    async deleteTask(id) {
        console.log('deleteTask called with id:', id);
        if (!this.isInitialized) {
            console.warn('Firebase not initialized yet');
            return;
        }

        // Check if quota exceeded
        if (this.quotaExceeded) {
            console.warn('Cannot delete task - Firebase quota exceeded');
            alert('⚠️ Firebase Quota Exceeded\n\nCannot delete task. Please wait a few minutes or upgrade your Firebase plan.\n\nCheck quota: https://console.firebase.google.com/project/simpletodo-d088e/usage');
            return;
        }

        // Ensure id is a string for comparison
        const taskId = String(id);
        const task = this.tasks.find(t => String(t.id) === taskId);
        console.log('Found task to delete:', task);
        if (task && task.isTracking) {
            await this.stopTracking(taskId);
        }

        try {
            // Use user-specific path
            const taskDocRef = this.doc(this.db, 'users', this.userId, 'tasks', taskId);
            if (!taskDocRef) {
                throw new Error('Task document reference is null');
            }
            await this.deleteDoc(taskDocRef);
        } catch (error) {
            console.error('Error deleting task:', error);

            // Check if quota exceeded
            if (error.code === 'resource-exhausted' || error.message?.toLowerCase().includes('quota')) {
                this.stopAllFirebaseOperations();
            } else {
                alert(`Failed to delete task: ${error.message || error}`);
            }
        }
    }

    async toggleComplete(id) {
        console.log('toggleComplete called with id:', id);
        if (!this.isInitialized) {
            console.warn('Firebase not initialized yet');
            return;
        }

        // Check if quota exceeded
        if (this.quotaExceeded) {
            console.warn('Cannot toggle task - Firebase quota exceeded');
            alert('⚠️ Firebase Quota Exceeded\n\nCannot update task. Please wait a few minutes or upgrade your Firebase plan.\n\nCheck quota: https://console.firebase.google.com/project/simpletodo-d088e/usage');
            return;
        }

        // Ensure id is a string for comparison
        const taskId = String(id);
        const task = this.tasks.find(t => String(t.id) === taskId);
        console.log('Found task to toggle:', task);
        if (task) {
            if (task.isTracking) {
                await this.stopTracking(taskId);
            }

            try {
                const taskDocRef = this.doc(this.db, 'users', this.userId, 'tasks', taskId);
                if (!taskDocRef) {
                    throw new Error('Task document reference is null');
                }
                await this.updateDoc(taskDocRef, {
                    completed: !task.completed
                });
            } catch (error) {
                console.error('Error updating task:', error);

                // Check if quota exceeded
                if (error.code === 'resource-exhausted' || error.message?.toLowerCase().includes('quota')) {
                    this.stopAllFirebaseOperations();
                } else {
                    alert(`Failed to update task: ${error.message || error}`);
                }
            }
        }
    }

    async updateTaskDescription(id, newDescription) {
        const taskId = String(id);
        const trimmed = (newDescription || '').trim();
        if (!trimmed) return;
        if (!this.isInitialized) {
            console.error('Firebase not initialized yet');
            alert('Please wait for the app to finish loading...');
            return;
        }

        // Check if quota exceeded
        if (this.quotaExceeded) {
            // Update local state only
            const task = this.tasks.find(t => String(t.id) === String(taskId));
            if (task) {
                task.description = trimmed;
                this.renderTasks();
                // Save to localStorage (user-specific)
                if (this.userId) {
                    localStorage.setItem(this.getUserStorageKey('tasks'), JSON.stringify(this.tasks));
                }
            }
            return;
        }

        if (!this.db) {
            console.error('Database not available');
            alert('Database connection failed. Please refresh the page.');
            return;
        }

        console.log('Updating task description:', taskId, trimmed);

        // Update local state immediately for instant UI feedback
        const task = this.tasks.find(t => String(t.id) === String(taskId));
        const originalDescription = task ? task.description : null;

        if (task) {
            task.description = trimmed;
            this.renderTasks();
        }

        // Debounce Firebase updates to reduce write operations
        // Clear existing timer for this task
        if (this.updateDebounceTimers[taskId]) {
            clearTimeout(this.updateDebounceTimers[taskId]);
        }

        // Set new timer - save after 2 seconds of no changes (debouncing)
        this.updateDebounceTimers[taskId] = setTimeout(async () => {
            // Check quota again before saving
            if (this.quotaExceeded) {
                delete this.updateDebounceTimers[taskId];
                return;
            }

            try {
                const taskDocRef = this.doc(this.db, 'users', this.userId, 'tasks', taskId);
                if (!taskDocRef) {
                    throw new Error('Task document reference is null');
                }

                console.log('Saving to Firebase (debounced):', taskDocRef.path);
                await this.updateDoc(taskDocRef, { description: trimmed });
                console.log('Successfully updated task description in Firebase');
                delete this.updateDebounceTimers[taskId];
            } catch (error) {
                console.error('Error updating task description (debounced):', error);
                delete this.updateDebounceTimers[taskId];

                // Check if quota exceeded
                if (error.code === 'resource-exhausted' || error.message?.toLowerCase().includes('quota')) {
                    this.stopAllFirebaseOperations();
                } else {
                    // Revert local state on error
                    const currentTask = this.tasks.find(t => String(t.id) === String(taskId));
                    if (currentTask && originalDescription) {
                        currentTask.description = originalDescription;
                        this.renderTasks();
                    }
                }
            }
        }, 2000); // Wait 2 seconds before saving (debouncing reduces writes)
    }

    async updateTaskDeadline(id, newDeadline) {
        const taskId = String(id);
        if (!newDeadline || !this.isInitialized) {
            console.error('Cannot update deadline: not initialized or invalid deadline');
            return;
        }

        // Check if quota exceeded
        if (this.quotaExceeded) {
            // Update local state only
            const task = this.tasks.find(t => String(t.id) === String(taskId));
            if (task) {
                task.deadline = newDeadline;
                this.renderTasks();
                // Save to localStorage (user-specific)
                if (this.userId) {
                    localStorage.setItem(this.getUserStorageKey('tasks'), JSON.stringify(this.tasks));
                }
            }
            return;
        }

        if (!this.db) {
            console.error('Database not available');
            alert('Database connection failed. Please refresh the page.');
            return;
        }

        console.log('Updating task deadline:', taskId, newDeadline);

        // Update local state immediately for instant UI feedback
        const task = this.tasks.find(t => String(t.id) === String(taskId));
        const originalDeadline = task ? task.deadline : null;

        if (task) {
            task.deadline = newDeadline;
            this.renderTasks();
        }

        // Debounce Firebase updates to reduce write operations
        const deadlineKey = `${taskId}_deadline`;
        if (this.updateDebounceTimers[deadlineKey]) {
            clearTimeout(this.updateDebounceTimers[deadlineKey]);
        }

        // Set new timer - save after 2 seconds of no changes
        this.updateDebounceTimers[deadlineKey] = setTimeout(async () => {
            // Check quota again before saving
            if (this.quotaExceeded) {
                delete this.updateDebounceTimers[deadlineKey];
                return;
            }

            try {
                const taskDocRef = this.doc(this.db, 'users', this.userId, 'tasks', taskId);
                if (!taskDocRef) {
                    throw new Error('Task document reference is null');
                }

                console.log('Saving deadline to Firebase (debounced):', taskDocRef.path);
                await this.updateDoc(taskDocRef, { deadline: newDeadline });
                console.log('Successfully updated task deadline in Firebase');
                delete this.updateDebounceTimers[deadlineKey];
            } catch (error) {
                console.error('Error updating task deadline (debounced):', error);
                delete this.updateDebounceTimers[deadlineKey];

                // Check if quota exceeded
                if (error.code === 'resource-exhausted' || error.message?.toLowerCase().includes('quota')) {
                    this.stopAllFirebaseOperations();
                } else {
                    // Revert local state on error
                    const currentTask = this.tasks.find(t => String(t.id) === String(taskId));
                    if (currentTask && originalDeadline) {
                        currentTask.deadline = originalDeadline;
                        this.renderTasks();
                    }
                    alert(`Failed to update deadline: ${error.message || error}`);
                }
            }
        }, 2000); // Wait 2 seconds before saving (debouncing reduces writes)
    }

    roundMinutesToQuarter(min) {
        const m = Number(min);
        if (m <= 7) return '00';
        if (m <= 22) return '15';
        if (m <= 37) return '30';
        return '45';
    }

    startEditDeadline(taskId) {
        const task = this.tasks.find(t => String(t.id) === String(taskId));
        if (!task || !task.deadline) return;
        const taskItem = document.querySelector(`.task-item[data-task-id="${taskId}"]`);
        if (!taskItem) return;
        const deadlineEl = taskItem.querySelector('.task-deadline');
        if (!deadlineEl || deadlineEl.querySelector('.deadline-editor')) return;

        const parsed = task.deadline.match(/^(\d{4}-\d{2}-\d{2})T(\d{1,2}):(\d{2})/);
        const dateVal = parsed ? parsed[1] : new Date().toISOString().split('T')[0];
        let hour = parsed ? String(parseInt(parsed[2], 10)).padStart(2, '0') : '12';
        let min = parsed ? this.roundMinutesToQuarter(parsed[3]) : '00';

        const wrap = document.createElement('div');
        wrap.className = 'deadline-editor';
        const dateInput = document.createElement('input');
        dateInput.type = 'date';
        dateInput.value = dateVal;
        dateInput.className = 'deadline-date-input';
        const hourSelect = document.createElement('select');
        hourSelect.className = 'deadline-time-hour';
        for (let h = 0; h < 24; h++) {
            const o = document.createElement('option');
            o.value = String(h).padStart(2, '0');
            o.textContent = o.value;
            if (o.value === hour) o.selected = true;
            hourSelect.appendChild(o);
        }
        const minSelect = document.createElement('select');
        minSelect.className = 'deadline-time-min';
        ['00', '15', '30', '45'].forEach(m => {
            const o = document.createElement('option');
            o.value = m;
            o.textContent = m;
            if (m === min) o.selected = true;
            minSelect.appendChild(o);
        });
        const saveBtn = document.createElement('button');
        saveBtn.type = 'button';
        saveBtn.className = 'btn-deadline-save';
        saveBtn.textContent = 'Save';

        wrap.appendChild(dateInput);
        wrap.appendChild(hourSelect);
        wrap.appendChild(document.createTextNode(':'));
        wrap.appendChild(minSelect);
        wrap.appendChild(saveBtn);

        const finish = (save) => {
            if (save) {
                const h = hourSelect.value;
                const m = minSelect.value;
                const newDeadline = `${dateInput.value}T${h}:${m}`;
                this.updateTaskDeadline(taskId, newDeadline).then(() => this.renderTasks());
            } else {
                this.renderTasks();
            }
        };

        saveBtn.addEventListener('click', () => finish(true));
        dateInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); finish(true); } });
        hourSelect.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); finish(true); } });
        minSelect.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); finish(true); } });

        deadlineEl.textContent = '';
        deadlineEl.appendChild(wrap);
        dateInput.focus();
    }

    startEditDescription(taskId) {
        const taskItem = document.querySelector(`.task-item[data-task-id="${taskId}"]`);
        if (!taskItem) return;
        const descEl = taskItem.querySelector('.task-description');
        if (!descEl || descEl.querySelector('input')) return;
        const current = (descEl.textContent || '').trim();
        const input = document.createElement('input');
        input.type = 'text';
        input.className = 'task-description-input';
        input.value = current;
        input.setAttribute('data-task-id', taskId);
        const finish = () => {
            const value = input.value.trim();
            input.remove();
            descEl.textContent = value || current;
            descEl.style.display = '';
            if (value && value !== current) {
                this.updateTaskDescription(taskId, value).then(() => this.renderTasks());
            } else {
                descEl.textContent = current;
            }
        };
        input.addEventListener('blur', finish);
        input.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') {
                e.preventDefault();
                input.blur();
            }
            if (e.key === 'Escape') {
                input.value = current;
                input.blur();
            }
        });
        descEl.textContent = '';
        descEl.style.display = 'block';
        descEl.appendChild(input);
        input.focus();
        input.select();
    }

    async toggleTracking(id) {
        console.log('toggleTracking called with id:', id);
        if (!this.isInitialized) {
            console.warn('Firebase not initialized yet');
            return;
        }

        // Ensure id is a string for comparison
        const taskId = String(id);
        const task = this.tasks.find(t => String(t.id) === taskId);
        console.log('Found task:', task);
        if (!task || task.completed) {
            console.log('Task not found or completed');
            return;
        }

        // Stop any currently tracking task
        if (this.currentTrackingTaskId && String(this.currentTrackingTaskId) !== String(taskId)) {
            await this.stopTracking(this.currentTrackingTaskId);
        }

        if (task.isTracking) {
            await this.stopTracking(taskId);
        } else {
            await this.startTracking(taskId);
        }
    }

    async startTracking(id) {
        if (!this.isInitialized) return;

        // Check if quota exceeded
        if (this.quotaExceeded) {
            console.warn('Cannot start tracking - Firebase quota exceeded');
            alert('⚠️ Firebase Quota Exceeded\n\nCannot start tracking. Please wait a few minutes or upgrade your Firebase plan.\n\nCheck quota: https://console.firebase.google.com/project/simpletodo-d088e/usage');
            return;
        }

        // Ensure id is a string for comparison
        const taskId = String(id);
        const task = this.tasks.find(t => String(t.id) === taskId);
        if (!task) return;

        // Stop idling timer
        this.stopIdlingTimer();

        // Stop any other tracking task
        if (this.currentTrackingTaskId) {
            await this.stopTracking(this.currentTrackingTaskId);
        }

        this.currentTrackingTaskId = taskId;
        this.trackingStartTime = Date.now();

        try {
            const taskDocRef = this.doc(this.db, 'users', this.userId, 'tasks', taskId);
            if (!taskDocRef) {
                throw new Error('Task document reference is null');
            }
            await this.updateDoc(taskDocRef, {
                isTracking: true,
                trackingStartTime: this.trackingStartTime // Store as number for easier calculation
            });
        } catch (error) {
            console.error('Error starting tracking:', error);

            // Check if quota exceeded
            if (error.code === 'resource-exhausted' || error.message?.toLowerCase().includes('quota')) {
                this.stopAllFirebaseOperations();
            } else {
                alert(`Failed to start tracking: ${error.message || error}`);
            }

            // Revert local state on error
            this.currentTrackingTaskId = null;
            this.trackingStartTime = null;
        }
    }

    async stopTracking(id) {
        if (!this.isInitialized) return;

        // Ensure id is a string for comparison
        const taskId = String(id);
        const task = this.tasks.find(t => String(t.id) === taskId);
        if (!task || !task.isTracking) return;

        const trackingStart = task.trackingStartTime || this.trackingStartTime || Date.now();
        const elapsed = Date.now() - trackingStart;
        const newElapsedTime = (task.elapsedTime || 0) + elapsed;
        const newTotalFocusTime = this.totalFocusTime + elapsed;

        this.currentTrackingTaskId = null;
        this.trackingStartTime = null;

        // Start idling timer
        this.startIdlingTimer();

        try {
            // Update task
            const taskDocRef = this.doc(this.db, 'users', this.userId, 'tasks', taskId);
            if (!taskDocRef) {
                throw new Error('Task document reference is null');
            }
            await this.updateDoc(taskDocRef, {
                isTracking: false,
                elapsedTime: newElapsedTime,
                trackingStartTime: null
            });

            // Update stats
            if (!this.statsDocRef) {
                throw new Error('Stats document reference is null');
            }
            await this.updateDoc(this.statsDocRef, {
                totalFocusTime: newTotalFocusTime
            });

            this.totalFocusTime = newTotalFocusTime;
        } catch (error) {
            console.error('Error stopping tracking:', error);

            // Check if quota exceeded
            if (error.code === 'resource-exhausted' || error.message?.toLowerCase().includes('quota')) {
                this.stopAllFirebaseOperations();
            } else {
                alert(`Failed to update database: ${error.message || error}`);
            }

            // Revert local state on error
            this.currentTrackingTaskId = taskId;
            this.trackingStartTime = trackingStart;
        }
    }

    startIdlingTimer() {
        this.idlingStartTime = Date.now();
        if (this.idlingInterval) {
            clearInterval(this.idlingInterval);
        }
        // Update UI every second for display
        this.idlingInterval = setInterval(() => {
            if (!this.currentTrackingTaskId && this.isInitialized) {
                this.updateDashboard();
            }
        }, 1000);

        // Save to Firebase much less frequently (every 5 minutes) to minimize quota usage
        // This reduces writes from 120/hour to 12/hour (90% reduction)
        if (this.idlingSaveInterval) {
            clearInterval(this.idlingSaveInterval);
        }
        // Only start save interval if quota is not exceeded
        if (!this.quotaExceeded) {
            // Clear any existing interval first
            if (this.idlingSaveInterval) {
                clearInterval(this.idlingSaveInterval);
                this.idlingSaveInterval = null;
            }

            this.idlingSaveInterval = setInterval(async () => {
                // Triple-check quota status before attempting save
                if (this.quotaExceeded) {
                    // Stop interval immediately if quota exceeded
                    if (this.idlingSaveInterval) {
                        clearInterval(this.idlingSaveInterval);
                        this.idlingSaveInterval = null;
                        console.log('✅ Stopped idling save interval - quota exceeded detected');
                    }
                    return;
                }

                if (!this.currentTrackingTaskId && this.isInitialized && !this.quotaExceeded) {
                    const idlingElapsed = Date.now() - this.idlingStartTime;
                    // Only save if there's meaningful time accumulated (at least 30 seconds)
                    if (idlingElapsed >= 30000) {
                        this.totalIdlingTime += idlingElapsed;
                        this.pendingIdlingTime += idlingElapsed;
                        this.idlingStartTime = Date.now();

                        // Check quota one more time before calling save
                        if (!this.quotaExceeded) {
                            await this.saveIdlingTime();
                        }
                    }
                }
            }, 900000); // Save every 15 minutes (900000ms) - reduces stats writes vs 5 min
        } else {
            console.log('⚠️ Skipping idling save interval - quota already exceeded');
        }
    }

    async stopIdlingTimer() {
        if (this.idlingInterval) {
            clearInterval(this.idlingInterval);
        }
        if (this.idlingSaveInterval) {
            clearInterval(this.idlingSaveInterval);
        }
        if (this.idlingStartTime && this.isInitialized) {
            const idlingElapsed = Date.now() - this.idlingStartTime;
            this.totalIdlingTime += idlingElapsed;
            this.pendingIdlingTime += idlingElapsed;
            this.idlingStartTime = null;
            if (!this.quotaExceeded) {
                await this.saveIdlingTime();
            } else {
                // Save to localStorage if quota exceeded (user-specific)
                if (this.userId) {
                    localStorage.setItem(this.getUserStorageKey('totalIdlingTime'), this.totalIdlingTime.toString());
                    localStorage.setItem(this.getUserStorageKey('pendingIdlingTime'), this.pendingIdlingTime.toString());
                }
            }
            this.updateDashboard();
        }
    }

    escapeHtml(text) {
        const div = document.createElement('div');
        div.textContent = text;
        return div.innerHTML;
    }

    formatTime(ms) {
        const totalSeconds = Math.floor(ms / 1000);
        const hours = Math.floor(totalSeconds / 3600);
        const minutes = Math.floor((totalSeconds % 3600) / 60);
        const seconds = totalSeconds % 60;
        return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
    }

    formatDeadline(deadlineString) {
        const deadline = new Date(deadlineString);
        const now = new Date();
        const isOverdue = deadline < now && !deadline.toDateString().includes('Invalid');
        
        // Calculate time difference in hours
        const timeDiffMs = deadline - now;
        const timeDiffHours = timeDiffMs / (1000 * 60 * 60);

        // Check if mobile/small screen
        const isSmallScreen = window.innerWidth <= 480;

        if (isSmallScreen) {
            // Compact format for small screens: "MM/DD HH:MM"
            const month = String(deadline.getMonth() + 1).padStart(2, '0');
            const day = String(deadline.getDate()).padStart(2, '0');
            const hours = String(deadline.getHours()).padStart(2, '0');
            const minutes = String(deadline.getMinutes()).padStart(2, '0');
            return {
                formatted: `${month}/${day} ${hours}:${minutes}`,
                isOverdue: isOverdue,
                timeDiffHours: timeDiffHours
            };
        } else {
            // Standard format for larger screens
            const dateStr = deadline.toLocaleDateString('en-US', {
                month: 'short',
                day: 'numeric',
                year: 'numeric'
            });
            const timeStr = deadline.toLocaleTimeString('en-US', {
                hour: '2-digit',
                minute: '2-digit'
            });
            return {
                formatted: `${dateStr} at ${timeStr}`,
                isOverdue: isOverdue,
                timeDiffHours: timeDiffHours
            };
        }
    }

    getDeadlineColorClass(deadlineInfo, isCodingTask) {
        // If task is completed, return empty string (will use completed styles)
        // This function will be called before checking completion status
        
        // For coding tasks: purple (unless past deadline, then red)
        if (isCodingTask) {
            if (deadlineInfo.isOverdue) {
                return 'deadline-red';
            }
            return 'deadline-purple';
        }
        
        // For regular tasks: based on time until deadline
        if (deadlineInfo.isOverdue) {
            return 'deadline-red';
        } else if (deadlineInfo.timeDiffHours <= 3 && deadlineInfo.timeDiffHours >= 0) {
            return 'deadline-green';
        } else {
            return 'deadline-blue';
        }
    }

    renderTasks() {
        const taskList = document.getElementById('taskList');
        if (!taskList) return;

        if (this.tasks.length === 0) {
            taskList.innerHTML = '<div class="empty-state">No tasks yet. Add one above to get started!</div>';
            return;
        }

        taskList.innerHTML = this.tasks.map(task => {
            const deadline = this.formatDeadline(task.deadline);
            const taskElapsedTime = task.elapsedTime || 0;
            const trackingStart = task.trackingStartTime || this.trackingStartTime;
            const currentElapsed = task.isTracking && trackingStart && String(this.currentTrackingTaskId) === String(task.id)
                ? taskElapsedTime + (Date.now() - trackingStart)
                : taskElapsedTime;
            const timerDisplay = this.formatTime(currentElapsed);

            const taskIdStr = String(task.id);
            const taskId = JSON.stringify(taskIdStr);
            const description = this.escapeHtml(task.description);

            const isCoding = task.isCodingTask && Array.isArray(task.subTasks);
            const codingProgress = isCoding
                ? (() => {
                    const done = task.subTasks.filter(st => st.completed).length;
                    const total = task.subTasks.length;
                    return total > 0 ? (done === total ? 'Completed' : `${done}/${total} completed`) : '';
                })()
                : '';

            // Get deadline color class (only apply if not completed)
            const deadlineColorClass = task.completed ? '' : this.getDeadlineColorClass(deadline, isCoding);

            return `
                <div class="task-item ${task.completed ? 'completed' : ''} ${isCoding ? 'coding-task' : ''} ${deadlineColorClass}" data-task-id="${task.id}" data-coding-task="${isCoding ? '1' : '0'}" draggable="true">
                    <div class="task-content-wrapper">
                        <div class="task-description" data-task-id="${task.id}" title="${isCoding ? 'Click to view checklist' : 'Click to edit'}">${description}</div>
                        ${codingProgress ? `<div class="task-progress">${codingProgress}</div>` : ''}
                        <div class="task-timer">
                            <span class="timer-display">${timerDisplay}</span>
                            <button class="btn-play ${task.isTracking ? 'playing' : ''}" 
                                    onclick="app.toggleTracking(${taskId})"
                                    ${task.completed ? 'disabled' : ''}
                                    type="button">
                                ${task.isTracking ? '⏸️' : '▶️'}
                            </button>
                            <span class="task-deadline ${deadline.isOverdue ? 'overdue' : ''}" data-task-id="${task.id}" title="Click to edit">${this.escapeHtml(deadline.formatted)}</span>
                        </div>
                    </div>
                    ${isCoding ? `<button type="button" class="btn-show-checklist">Show checklist</button>` : ''}
                    <button class="btn-complete ${task.completed ? 'completed' : ''}" 
                            onclick="app.toggleComplete(${taskId})"
                            type="button">
                        ${task.completed ? '✓ Completed' : 'Complete'}
                    </button>
                    <button class="btn-delete" 
                            onclick="app.deleteTask(${taskId})"
                            type="button">Delete</button>
                </div>
            `;
        }).join('');

        // Update timers in real-time
        if (this.currentTrackingTaskId) {
            this.startTimerUpdate();
        }

        // Set up event delegation for buttons (backup method)
        this.setupButtonEventListeners();
        this.setupDragAndDrop();
        this.setupCodingTaskSelect();
        this.renderCodingChecklist();
    }

    startDeadlineColorUpdate() {
        // Clear existing interval if any
        if (this.deadlineColorUpdateInterval) {
            clearInterval(this.deadlineColorUpdateInterval);
        }
        
        // Update colors every minute to ensure they stay current as deadlines approach
        this.deadlineColorUpdateInterval = setInterval(() => {
            // Only re-render if we have tasks and they're not currently being dragged
            if (this.tasks.length > 0 && !document.querySelector('.task-item.dragging')) {
                // Force a re-render to update colors based on current time
                const taskList = document.getElementById('taskList');
                if (taskList) {
                    // Re-render tasks to update colors
                    this.renderTasks();
                }
            }
        }, 60000); // Update every minute
    }

    setupDragAndDrop() {
        const taskList = document.getElementById('taskList');
        if (!taskList) return;

        if (this.dragStartBound) {
            taskList.removeEventListener('dragstart', this.dragStartBound);
            taskList.removeEventListener('dragover', this.dragOverBound);
            taskList.removeEventListener('drop', this.dropBound);
            taskList.removeEventListener('dragleave', this.dragLeaveBound);
            taskList.removeEventListener('dragend', this.dragEndBound);
        }

        this.dragStartBound = (e) => {
            const item = e.target.closest('.task-item');
            if (!item) return;
            const taskId = item.getAttribute('data-task-id');
            if (!taskId) return;
            e.dataTransfer.setData('text/plain', taskId);
            e.dataTransfer.effectAllowed = 'move';
            item.classList.add('dragging');
        };

        this.dragOverBound = (e) => {
            e.preventDefault();
            e.dataTransfer.dropEffect = 'move';
            const item = e.target.closest('.task-item');
            if (item && !item.classList.contains('dragging')) {
                item.classList.add('drag-over');
            }
        };

        this.dragLeaveBound = (e) => {
            const item = e.target.closest('.task-item');
            if (item) item.classList.remove('drag-over');
        };

        this.dragEndBound = (e) => {
            const item = e.target.closest('.task-item');
            if (item) item.classList.remove('dragging');
            taskList.querySelectorAll('.task-item').forEach(el => el.classList.remove('drag-over'));
        };

        this.dropBound = (e) => {
            e.preventDefault();
            const targetItem = e.target.closest('.task-item');
            if (!targetItem) return;
            targetItem.classList.remove('drag-over');
            const draggedId = e.dataTransfer.getData('text/plain');
            const targetId = targetItem.getAttribute('data-task-id');
            if (!draggedId || !targetId || draggedId === targetId) return;
            this.reorderTasks(draggedId, targetId);
        };

        taskList.addEventListener('dragstart', this.dragStartBound);
        taskList.addEventListener('dragover', this.dragOverBound);
        taskList.addEventListener('dragleave', this.dragLeaveBound);
        taskList.addEventListener('dragend', this.dragEndBound);
        taskList.addEventListener('drop', this.dropBound);
    }

    async reorderTasks(draggedId, targetId) {
        const fromIndex = this.tasks.findIndex(t => String(t.id) === String(draggedId));
        const toIndex = this.tasks.findIndex(t => String(t.id) === String(targetId));
        if (fromIndex === -1 || toIndex === -1) return;
        const [moved] = this.tasks.splice(fromIndex, 1);
        this.tasks.splice(toIndex, 0, moved);
        // Only write tasks whose order actually changed (minimizes Firestore writes)
        const updates = this.tasks
            .map((task, index) => ({ id: task.id, order: index, currentOrder: typeof task.order === 'number' ? task.order : 999999 }))
            .filter(({ order, currentOrder }) => order !== currentOrder);
        try {
            for (const { id, order } of updates) {
                const taskDocRef = this.doc(this.db, 'users', this.userId, 'tasks', id);
                if (!taskDocRef) continue;
                await this.updateDoc(taskDocRef, { order });
            }
        } catch (error) {
            console.error('Error reordering tasks:', error);
            alert(`Failed to reorder tasks: ${error.message || error}`);
        }
    }

    setupButtonEventListeners() {
        // Use event delegation to handle button clicks
        const taskList = document.getElementById('taskList');
        if (!taskList) return;

        // Remove old listeners if any
        if (this.handleButtonClickBound) {
            taskList.removeEventListener('click', this.handleButtonClickBound);
        }

        // Bind the handler and store reference - this will handle all button clicks
        this.handleButtonClickBound = (e) => {
            const button = e.target.closest('button');
            if (!button) return;

            // Don't intercept the deadline editor Save button - let it handle its own click
            if (button.classList.contains('btn-deadline-save')) return;

            const taskItem = button.closest('.task-item');
            if (!taskItem) return;

            const taskId = taskItem.getAttribute('data-task-id');
            if (!taskId) {
                console.warn('No task ID found for button click');
                return;
            }

            // Prevent default and stop propagation only for task action buttons
            e.preventDefault();
            e.stopPropagation();

            if (button.classList.contains('btn-play')) {
                console.log('Button click: toggleTracking', taskId);
                this.toggleTracking(taskId).catch(err => console.error('Error in toggleTracking:', err));
            } else if (button.classList.contains('btn-show-checklist')) {
                this.selectCodingTask(taskId);
            } else if (button.classList.contains('btn-complete')) {
                console.log('Button click: toggleComplete', taskId);
                this.toggleComplete(taskId).catch(err => console.error('Error in toggleComplete:', err));
            } else if (button.classList.contains('btn-delete')) {
                console.log('Button click: deleteTask', taskId);
                this.deleteTask(taskId).catch(err => console.error('Error in deleteTask:', err));
            }
        };

        taskList.addEventListener('click', this.handleButtonClickBound, true);

        if (this.handleDescriptionClickBound) {
            taskList.removeEventListener('click', this.handleDescriptionClickBound, true);
        }
        if (this.handleDeadlineClickBound) {
            taskList.removeEventListener('click', this.handleDeadlineClickBound, true);
        }
        this.handleDescriptionClickBound = (e) => {
            const desc = e.target.closest('.task-description');
            if (!desc || desc.querySelector('input')) return;
            const taskId = desc.getAttribute('data-task-id');
            if (taskId) {
                e.preventDefault();
                e.stopPropagation();
                this.startEditDescription(taskId);
            }
        };
        taskList.addEventListener('click', this.handleDescriptionClickBound, true);

        this.handleDeadlineClickBound = (e) => {
            const deadlineEl = e.target.closest('.task-deadline');
            if (!deadlineEl || deadlineEl.querySelector('.deadline-editor')) return;
            const taskId = deadlineEl.getAttribute('data-task-id');
            if (taskId) {
                e.preventDefault();
                e.stopPropagation();
                this.startEditDeadline(taskId);
            }
        };
        taskList.addEventListener('click', this.handleDeadlineClickBound, true);
    }

    setupCodingTaskSelect() {
        const taskList = document.getElementById('taskList');
        if (!taskList) return;
        if (this.handleCodingTaskSelectBound) {
            taskList.removeEventListener('click', this.handleCodingTaskSelectBound);
        }
        this.handleCodingTaskSelectBound = (e) => {
            const card = e.target.closest('.task-item.coding-task');
            if (!card) return;
            if (e.target.closest('button') || e.target.closest('input') || e.target.closest('.deadline-editor')) return;
            const taskId = card.getAttribute('data-task-id');
            if (taskId) this.selectCodingTask(taskId);
        };
        taskList.addEventListener('click', this.handleCodingTaskSelectBound);
    }

    toggleAddTaskSection() {
        const section = document.querySelector('.add-task-collapsible');
        if (!section) return;
        section.classList.toggle('collapsed');
        const collapsed = section.classList.contains('collapsed');
        localStorage.setItem('addTaskCollapsed', collapsed ? '1' : '0');
    }

    loadAddTaskSectionState() {
        if (localStorage.getItem('addTaskCollapsed') === '1') {
            const section = document.querySelector('.add-task-collapsible');
            if (section) section.classList.add('collapsed');
        }
    }


    formatHyperlink(text) {
        // Regular expression to match URLs
        const urlRegex = /(https?:\/\/[^\s]+)/g;
        const parts = [];
        let lastIndex = 0;
        let match;

        while ((match = urlRegex.exec(text)) !== null) {
            // Add text before the URL
            if (match.index > lastIndex) {
                parts.push({ type: 'text', content: text.substring(lastIndex, match.index) });
            }

            // Extract domain from URL for display
            try {
                const url = new URL(match[0]);
                const domain = url.hostname.replace('www.', '');
                const displayText = domain.length > 30 ? domain.substring(0, 27) + '...' : domain;

                parts.push({
                    type: 'link',
                    url: match[0],
                    display: displayText
                });
            } catch (e) {
                // If URL parsing fails, just show the URL as-is
                parts.push({
                    type: 'link',
                    url: match[0],
                    display: match[0].length > 30 ? match[0].substring(0, 27) + '...' : match[0]
                });
            }

            lastIndex = match.index + match[0].length;
        }

        // Add remaining text after the last URL
        if (lastIndex < text.length) {
            parts.push({ type: 'text', content: text.substring(lastIndex) });
        }

        // If no URLs found, return the original text
        if (parts.length === 0) {
            return [{ type: 'text', content: text }];
        }

        return parts;
    }

    async saveRemark(content) {
        if (!this.isInitialized) {
            alert('Please wait for Firebase to initialize...');
            return;
        }

        const remarkText = (content || '').trim();

        // Always save to localStorage first (instant feedback, user-specific)
        if (this.userId) {
            localStorage.setItem(this.getUserStorageKey('remark'), remarkText);
        }
        this.remark = { content: remarkText };
        this.renderRemark();

        // Check if quota exceeded
        if (this.quotaExceeded) {
            console.log('Remark saved to localStorage only (quota exceeded)');
            return;
        }

        try {
            const { Timestamp } = await import("https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js");

            const remarkData = {
                content: remarkText,
                updatedAt: Timestamp.now()
            };

            if (!this.remarkDocRef) {
                throw new Error('Remark document reference is null');
            }

            // Save to Firebase (no real-time listener, so this is the only sync)
            await this.setDoc(this.remarkDocRef, remarkData, { merge: true });
            console.log('✅ Remark saved to Firebase');
        } catch (error) {
            console.error('Error saving remark:', error);

            // Check if quota exceeded
            if (error.code === 'resource-exhausted' || error.message?.toLowerCase().includes('quota')) {
                this.stopAllFirebaseOperations();
            } else {
                console.warn('Remark saved to localStorage, Firebase sync failed');
            }
        }
    }

    startEditRemark() {
        const remarkBox = document.getElementById('remarkBox');
        if (!remarkBox) return;

        // Check if already editing
        if (remarkBox.querySelector('textarea')) return;

        const current = this.remark?.content || '';
        const textarea = document.createElement('textarea');
        textarea.className = 'remark-content-input';
        textarea.value = current;
        textarea.placeholder = 'Enter your remark or paste a hyperlink...';

        const finish = (save) => {
            const value = textarea.value.trim();
            textarea.remove();
            if (save) {
                this.saveRemark(value).then(() => {
                    // Remark will be updated via real-time listener
                });
            } else {
                this.renderRemark();
            }
        };

        textarea.addEventListener('blur', () => finish(true));
        textarea.addEventListener('keydown', (e) => {
            if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
                e.preventDefault();
                finish(true);
            }
            if (e.key === 'Escape') {
                textarea.value = current;
                finish(false);
            }
        });

        remarkBox.innerHTML = '';
        remarkBox.appendChild(textarea);
        textarea.focus();
        textarea.select();
    }

    renderRemark() {
        const remarkBox = document.getElementById('remarkBox');
        if (!remarkBox) return;

        // Check if currently editing
        if (remarkBox.querySelector('textarea')) return;

        const content = this.remark?.content || '';

        if (!content) {
            remarkBox.innerHTML = `
                <div class="remark-placeholder" onclick="app.startEditRemark()" title="Click to add remark">
                    Click here to add a remark...
                </div>
            `;
            return;
        }

        const formattedParts = this.formatHyperlink(content);

        // Convert line breaks to <br> tags for display
        const contentHtml = formattedParts.map(part => {
            if (part.type === 'link') {
                return `<a href="${this.escapeHtml(part.url)}" target="_blank" rel="noopener noreferrer" class="remark-link">${this.escapeHtml(part.display)}</a>`;
            } else {
                // Replace line breaks with <br> tags
                return this.escapeHtml(part.content).replace(/\n/g, '<br>');
            }
        }).join('');

        remarkBox.innerHTML = `
            <div class="remark-content-display" onclick="app.startEditRemark()" title="Click to edit">
                ${contentHtml}
            </div>
        `;
    }

    startTimerUpdate() {
        if (this.timerUpdateInterval) {
            clearInterval(this.timerUpdateInterval);
        }
        this.timerUpdateInterval = setInterval(() => {
            if (this.currentTrackingTaskId) {
                this.renderTasks();
            } else {
                clearInterval(this.timerUpdateInterval);
            }
        }, 1000);
    }

    updateDashboard() {
        const completedCount = this.tasks.filter(t => t.completed).length;
        const outstandingCount = this.tasks.filter(t => !t.completed).length;

        document.getElementById('totalFocusTime').textContent = this.formatTime(this.totalFocusTime);
        document.getElementById('completedTasks').textContent = completedCount;
        document.getElementById('outstandingTasks').textContent = outstandingCount;

        // Calculate current idling time if not tracking
        let currentIdling = this.totalIdlingTime;
        if (!this.currentTrackingTaskId && this.idlingStartTime) {
            currentIdling += (Date.now() - this.idlingStartTime);
        }
        document.getElementById('idlingTime').textContent = this.formatTime(currentIdling);

        // Update last reset time display
        this.updateLastResetTimeDisplay();
    }

    async saveIdlingTime() {
        // Always save to localStorage first (instant, no quota usage, user-specific)
        if (this.userId) {
            localStorage.setItem(this.getUserStorageKey('totalIdlingTime'), this.totalIdlingTime.toString());
            localStorage.setItem(this.getUserStorageKey('pendingIdlingTime'), this.pendingIdlingTime.toString());
        }

        // Early return if quota exceeded or not initialized
        if (this.quotaExceeded) {
            return; // Already saved to localStorage above
        }

        if (!this.isInitialized) {
            return; // Already saved to localStorage above
        }

        try {
            if (!this.statsDocRef) {
                throw new Error('Stats document reference is null');
            }
            // OPTIMIZATION: No real-time listener for stats, so this write is the only sync
            await this.updateDoc(this.statsDocRef, {
                totalIdlingTime: this.totalIdlingTime
            });
            // Reset pending time after successful save
            this.pendingIdlingTime = 0;
            if (this.userId) {
                localStorage.removeItem(this.getUserStorageKey('pendingIdlingTime'));
            }
            // Clear quota exceeded flag if save succeeded
            if (this.quotaExceeded) {
                this.quotaExceeded = false;
                console.log('✅ Quota recovered - Firebase saves resumed');
            }
        } catch (error) {
            console.error('Error saving idling time:', error);

            // Check if quota exceeded - check multiple ways to catch all quota errors
            const isQuotaError = error.code === 'resource-exhausted' ||
                error.code === 'RESOURCE_EXHAUSTED' ||
                error.message?.toLowerCase().includes('quota') ||
                error.message?.toLowerCase().includes('resource-exhausted') ||
                String(error).toLowerCase().includes('quota');

            if (isQuotaError) {
                console.warn('⚠️ Firebase quota exceeded detected in saveIdlingTime');
                console.warn('Error details:', { code: error.code, message: error.message });
                // Stop all Firebase operations
                this.stopAllFirebaseOperations();
            }
            // Note: Already saved to localStorage above, so data is safe
        }
    }

    async resetTimes() {
        this.totalFocusTime = 0;
        this.totalIdlingTime = 0;
        this.idlingStartTime = Date.now();
        this.lastResetTime = Date.now();

        if (this.isInitialized) {
            // Always update localStorage (user-specific)
            if (this.userId) {
                localStorage.setItem(this.getUserStorageKey('totalFocusTime'), '0');
                localStorage.setItem(this.getUserStorageKey('totalIdlingTime'), '0');
                localStorage.setItem(this.getUserStorageKey('lastResetTime'), this.lastResetTime.toString());
            }
            this.updateDashboard();
            this.updateLastResetTimeDisplay();

            // Only update Firebase if quota not exceeded
            if (this.quotaExceeded) {
                console.log('Skipping Firebase update - quota exceeded');
                return;
            }

            try {
                if (!this.statsDocRef) {
                    throw new Error('Stats document reference is null');
                }
                await this.updateDoc(this.statsDocRef, {
                    totalFocusTime: 0,
                    totalIdlingTime: 0,
                    lastResetTime: this.lastResetTime
                });
            } catch (error) {
                console.error('Error resetting times:', error);

                // Check if quota exceeded
                if (error.code === 'resource-exhausted' || error.message?.toLowerCase().includes('quota')) {
                    this.stopAllFirebaseOperations();
                } else {
                    alert(`Failed to reset times: ${error.message || error}`);
                }
            }
        }
    }

    formatLastResetTime(timestamp) {
        if (!timestamp) return '';
        const resetDate = new Date(timestamp);
        const now = new Date();
        const diffMs = now - resetDate;
        const diffMins = Math.floor(diffMs / 60000);
        const diffHours = Math.floor(diffMs / 3600000);
        const diffDays = Math.floor(diffMs / 86400000);

        // Format based on how long ago it was
        if (diffMins < 1) {
            return 'Just now';
        } else if (diffMins < 60) {
            return `${diffMins} min${diffMins !== 1 ? 's' : ''} ago`;
        } else if (diffHours < 24) {
            return `${diffHours} hour${diffHours !== 1 ? 's' : ''} ago`;
        } else if (diffDays < 7) {
            return `${diffDays} day${diffDays !== 1 ? 's' : ''} ago`;
        } else {
            // Show date and time for older resets
            return resetDate.toLocaleString('en-US', {
                month: 'short',
                day: 'numeric',
                year: resetDate.getFullYear() !== now.getFullYear() ? 'numeric' : undefined,
                hour: '2-digit',
                minute: '2-digit'
            });
        }
    }

    formatFullTimestamp(timestamp) {
        if (!timestamp) return '';
        const resetDate = new Date(timestamp);
        return resetDate.toLocaleString('en-US', {
            weekday: 'short',
            month: 'short',
            day: 'numeric',
            year: 'numeric',
            hour: '2-digit',
            minute: '2-digit',
            second: '2-digit'
        });
    }

    updateLastResetTimeDisplay() {
        const lastResetTimeEl = document.getElementById('lastResetTime');
        if (!lastResetTimeEl) return;

        if (this.lastResetTime) {
            const formatted = this.formatLastResetTime(this.lastResetTime);
            const fullTimestamp = this.formatFullTimestamp(this.lastResetTime);
            lastResetTimeEl.textContent = `Last reset: ${formatted}`;
            lastResetTimeEl.setAttribute('title', fullTimestamp);
            lastResetTimeEl.style.display = 'inline';
        } else {
            lastResetTimeEl.textContent = '';
            lastResetTimeEl.removeAttribute('title');
            lastResetTimeEl.style.display = 'none';
        }
    }

    toggleSection(sectionId) {
        let section;
        if (sectionId === 'dashboard') {
            section = document.querySelector('.dashboard');
        } else if (sectionId === 'tasks') {
            section = document.querySelector('.tasks-section');
        } else if (sectionId === 'remark') {
            section = document.querySelector('.remark-section');
        }

        const icon = document.getElementById(`${sectionId}-icon`);

        if (section) {
            section.classList.toggle('collapsed');
            const isCollapsed = section.classList.contains('collapsed');

            // Save state to localStorage
            const states = JSON.parse(localStorage.getItem('sectionStates')) || {};
            states[sectionId] = isCollapsed;
            localStorage.setItem('sectionStates', JSON.stringify(states));
        }
    }

    loadSectionStates() {
        const states = JSON.parse(localStorage.getItem('sectionStates')) || {};

        ['dashboard', 'tasks', 'remark'].forEach(sectionId => {
            if (states[sectionId]) {
                let section;
                if (sectionId === 'dashboard') {
                    section = document.querySelector('.dashboard');
                } else if (sectionId === 'tasks') {
                    section = document.querySelector('.tasks-section');
                } else if (sectionId === 'remark') {
                    section = document.querySelector('.remark-section');
                }
                if (section) {
                    section.classList.add('collapsed');
                }
            }
        });

        // Remark section is collapsed by default if no state is saved
        if (states['remark'] === undefined) {
            const remarkSection = document.querySelector('.remark-section');
            if (remarkSection) {
                remarkSection.classList.add('collapsed');
            }
        }
    }
}

// Initialize the app and make it globally accessible immediately
window.app = new TodoApp();
const app = window.app;

// Create a global wrapper function for testFirebaseConnection to ensure it's always accessible
window.testFirebaseConnection = function (event) {
    if (window.app && typeof window.app.testFirebaseConnection === 'function') {
        return window.app.testFirebaseConnection(event);
    } else {
        console.error('App not initialized yet. Please wait a moment and try again.');
        alert('App is still loading. Please wait a moment and try again.');
    }
};

// Ensure testFirebaseConnection is accessible globally
if (window.app && typeof window.app.testFirebaseConnection === 'function') {
    // Function is already accessible
    console.log('Firebase test function is available');
} else {
    console.warn('Firebase test function may not be available yet');
}

// Update dashboard periodically
setInterval(() => {
    if (app) {
        app.updateDashboard();
    }
}, 1000);
