// Task management and time tracking application

class TodoApp {
    constructor() {
        this.tasks = [];
        this.totalFocusTime = 0;
        this.totalIdlingTime = 0;
        this.lastActivityTime = Date.now();
        this.currentTrackingTaskId = null;
        this.trackingStartTime = null;
        this.idlingStartTime = Date.now();
        this.db = null;
        this.statsDocRef = null;
        this.tasksCollectionRef = null;
        this.isInitialized = false;

        this.initFirebase();
    }

    async initFirebase() {
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

        // Set up Firestore references
        this.statsDocRef = doc(this.db, 'stats', 'userStats');
        this.tasksCollectionRef = collection(this.db, 'tasks');

        if (!this.statsDocRef || !this.tasksCollectionRef) {
            console.error('Failed to create Firestore references');
            alert('Failed to initialize database references. Please check your Firebase configuration.');
            return;
        }

        // Load initial data
        await this.loadStats();
        await this.loadTasks();
        this.setupRealtimeListeners();

        this.isInitialized = true;
        this.init();
    }

    async loadStats() {
        try {
            const statsSnap = await this.getDoc(this.statsDocRef);
            if (statsSnap.exists()) {
                const data = statsSnap.data();
                this.totalFocusTime = data.totalFocusTime || 0;
                this.totalIdlingTime = data.totalIdlingTime || 0;
            } else {
                // Create initial stats document
                await this.setDoc(this.statsDocRef, {
                    totalFocusTime: 0,
                    totalIdlingTime: 0
                });
            }
        } catch (error) {
            console.error('Error loading stats:', error);
            // Fallback to localStorage if Firebase fails
            this.totalFocusTime = parseInt(localStorage.getItem('totalFocusTime')) || 0;
            this.totalIdlingTime = parseInt(localStorage.getItem('totalIdlingTime')) || 0;
        }
    }

    async loadTasks() {
        try {
            // Tasks will be loaded via real-time listener
            // This is just a placeholder for any initial setup needed
        } catch (error) {
            console.error('Error loading tasks:', error);
            // Fallback to localStorage
            this.tasks = JSON.parse(localStorage.getItem('tasks')) || [];
        }
    }

    setupRealtimeListeners() {
        // Listen for tasks changes
        this.onSnapshot(this.tasksCollectionRef, (snapshot) => {
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
        });

        // Listen for stats changes
        this.onSnapshot(this.statsDocRef, (doc) => {
            if (doc.exists()) {
                const data = doc.data();
                this.totalFocusTime = data.totalFocusTime || 0;
                this.totalIdlingTime = data.totalIdlingTime || 0;
                if (this.isInitialized) {
                    this.updateDashboard();
                }
            }
        }, (error) => {
            console.error('Error listening to stats:', error);
        });
    }

    init() {
        this.renderTasks();
        this.updateDashboard();
        this.setupEventListeners();
        this.startIdlingTimer();
        this.loadSectionStates();
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

    async addTask() {
        if (!this.isInitialized) {
            alert('Please wait for Firebase to initialize...');
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
            alert('Failed to add task. Please try again.');
        }
    }

    async deleteTask(id) {
        console.log('deleteTask called with id:', id);
        if (!this.isInitialized) {
            console.warn('Firebase not initialized yet');
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
            const taskDocRef = this.doc(this.db, 'tasks', taskId);
            if (!taskDocRef) {
                throw new Error('Task document reference is null');
            }
            await this.deleteDoc(taskDocRef);
        } catch (error) {
            console.error('Error deleting task:', error);
            alert(`Failed to delete task: ${error.message || error}`);
        }
    }

    async toggleComplete(id) {
        console.log('toggleComplete called with id:', id);
        if (!this.isInitialized) {
            console.warn('Firebase not initialized yet');
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
                const taskDocRef = this.doc(this.db, 'tasks', taskId);
                if (!taskDocRef) {
                    throw new Error('Task document reference is null');
                }
                await this.updateDoc(taskDocRef, {
                    completed: !task.completed
                });
            } catch (error) {
                console.error('Error updating task:', error);
                alert(`Failed to update task: ${error.message || error}`);
            }
        }
    }

    async updateTaskDescription(id, newDescription) {
        const taskId = String(id);
        const trimmed = (newDescription || '').trim();
        if (!trimmed) return;
        if (!this.isInitialized) return;
        try {
            const taskDocRef = this.doc(this.db, 'tasks', taskId);
            if (!taskDocRef) {
                throw new Error('Task document reference is null');
            }
            await this.updateDoc(taskDocRef, { description: trimmed });
        } catch (error) {
            console.error('Error updating task description:', error);
            alert(`Failed to update task: ${error.message || error}`);
        }
    }

    async updateTaskDeadline(id, newDeadline) {
        const taskId = String(id);
        if (!newDeadline || !this.isInitialized) return;
        try {
            const taskDocRef = this.doc(this.db, 'tasks', taskId);
            if (!taskDocRef) {
                throw new Error('Task document reference is null');
            }
            await this.updateDoc(taskDocRef, { deadline: newDeadline });
        } catch (error) {
            console.error('Error updating task deadline:', error);
            alert(`Failed to update deadline: ${error.message || error}`);
        }
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
            const taskDocRef = this.doc(this.db, 'tasks', taskId);
            if (!taskDocRef) {
                throw new Error('Task document reference is null');
            }
            await this.updateDoc(taskDocRef, {
                isTracking: true,
                trackingStartTime: this.trackingStartTime // Store as number for easier calculation
            });
        } catch (error) {
            console.error('Error starting tracking:', error);
            alert(`Failed to start tracking: ${error.message || error}`);
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
            const taskDocRef = this.doc(this.db, 'tasks', taskId);
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
            alert(`Failed to update database: ${error.message || error}`);
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
        this.idlingInterval = setInterval(async () => {
            if (!this.currentTrackingTaskId && this.isInitialized) {
                const idlingElapsed = Date.now() - this.idlingStartTime;
                this.totalIdlingTime += idlingElapsed;
                this.idlingStartTime = Date.now();
                await this.saveIdlingTime();
                this.updateDashboard();
            }
        }, 1000);
    }

    async stopIdlingTimer() {
        if (this.idlingInterval) {
            clearInterval(this.idlingInterval);
        }
        if (this.idlingStartTime && this.isInitialized) {
            const idlingElapsed = Date.now() - this.idlingStartTime;
            this.totalIdlingTime += idlingElapsed;
            this.idlingStartTime = null;
            await this.saveIdlingTime();
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
                isOverdue: isOverdue
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
                isOverdue: isOverdue
            };
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

            // Escape task ID and description for HTML
            // Use task.id directly in JSON.stringify for safe onclick handler
            const taskIdStr = String(task.id);
            const taskId = JSON.stringify(taskIdStr);
            const description = this.escapeHtml(task.description);

            return `
                <div class="task-item ${task.completed ? 'completed' : ''}" data-task-id="${task.id}" draggable="true">
                    <div class="task-content-wrapper">
                        <div class="task-description" data-task-id="${task.id}" title="Click to edit">${description}</div>
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
        const updates = this.tasks.map((task, index) => ({ id: task.id, order: index }));
        try {
            for (const { id, order } of updates) {
                const taskDocRef = this.doc(this.db, 'tasks', id);
                if (!taskDocRef) {
                    console.warn(`Task document reference is null for task ${id}`);
                    continue;
                }
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
    }

    async saveIdlingTime() {
        if (!this.isInitialized) return;

        try {
            if (!this.statsDocRef) {
                throw new Error('Stats document reference is null');
            }
            await this.updateDoc(this.statsDocRef, {
                totalIdlingTime: this.totalIdlingTime
            });
        } catch (error) {
            console.error('Error saving idling time:', error);
            // Fallback to localStorage
            localStorage.setItem('totalIdlingTime', this.totalIdlingTime.toString());
        }
    }

    async resetTimes() {
        this.totalFocusTime = 0;
        this.totalIdlingTime = 0;
        this.idlingStartTime = Date.now();

        if (this.isInitialized) {
            try {
                if (!this.statsDocRef) {
                    throw new Error('Stats document reference is null');
                }
                await this.updateDoc(this.statsDocRef, {
                    totalFocusTime: 0,
                    totalIdlingTime: 0
                });
            } catch (error) {
                console.error('Error resetting times:', error);
                alert(`Failed to reset times: ${error.message || error}`);
            }
            localStorage.setItem('totalFocusTime', '0');
            localStorage.setItem('totalIdlingTime', '0');
            this.updateDashboard();
        }
    }

    toggleSection(sectionId) {
        const section = document.querySelector(`.${sectionId === 'dashboard' ? 'dashboard' : 'tasks-section'}`);
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

        ['dashboard', 'tasks'].forEach(sectionId => {
            if (states[sectionId]) {
                const section = document.querySelector(`.${sectionId === 'dashboard' ? 'dashboard' : 'tasks-section'}`);
                if (section) {
                    section.classList.add('collapsed');
                }
            }
        });
    }
}

// Initialize the app and make it globally accessible immediately
window.app = new TodoApp();
const app = window.app;

// Update dashboard periodically
setInterval(() => {
    if (app) {
        app.updateDashboard();
    }
}, 1000);
