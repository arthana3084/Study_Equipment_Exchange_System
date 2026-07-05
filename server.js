// server.js (FINAL ROBUST & SCHEMA-MATCHED VERSION)

const express = require('express');
const mysql = require('mysql2/promise');
const session = require('express-session');
const bcrypt = require('bcrypt');
const path = require('path');

const app = express();
const port = 3000;

// =====================================
// 1. DATABASE CONFIGURATION (UPDATED CREDENTIALS)
// =====================================
const dbConfig = {
    host: 'localhost',
    user: 'root',
    // CRITICAL: UPDATED PASSWORD AS REQUESTED
    password: 'Arthana@2004', 
    // CRITICAL: UPDATED DATABASE NAME AS REQUESTED
    database: 'study_equipment', 
    waitForConnections: true,
    connectionLimit: 10,
    queueLimit: 0
};

let db;
(async () => {
    try {
        db = await mysql.createPool(dbConfig);
        console.log('✅ Database pool created successfully.');
    } catch (err) {
        console.error('❌ Failed to create database pool. Check MySQL is running and credentials are correct:', err.message);
        process.exit(1);
    }
})();

// =====================================
// 2. MIDDLEWARE SETUP (SESSION PERSISTENCE FIX)
// =====================================

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.use(session({
    secret: 'a_secure_secret_key_for_session',
    resave: false,
    saveUninitialized: true,
    cookie: { 
        maxAge: 1000 * 60 * 60 * 24 // 24 hours
    } 
}));

// CRITICAL FIX FOR REPEATED LOGIN: Forces session saving before redirects
app.use((req, res, next) => {
    // Only apply if the user is not yet confirmed in the session, but a session ID exists.
    if (!req.session.user && req.session.id && req.url !== '/api/login') {
        req.session.regenerate(next);
    } else {
        next();
    }
});


app.use(express.static(path.join(__dirname, 'public')));


// Authentication Middleware
function isAuthenticated(req, res, next) {
    // CRITICAL FIX: Ensure the session is actively loaded and user data is present.
    // If the session exists but user data is missing (which happens on navigation after login), 
    // it forces the system to recognize the current session ID.
    if (req.session && req.session.user && req.session.user.id) {
        // If the user is logged in, proceed.
        next();
    } else {
        // If not logged in, send 401 Unauthorized.
        // The client-side (e.g., categories.html) will catch this and redirect to login.
        res.status(401).json({ error: 'Unauthorized. Please log in.' });
    }
}

// =====================================
// 3. AUTHENTICATION ROUTES
// =====================================

// Register User
app.post('/api/register', async (req, res) => {
    const { name, email, password, phone, role } = req.body;
    try {
        const hashedPassword = await bcrypt.hash(password, 10);
        await db.query(
            'INSERT INTO users (name, email, password, phone, role) VALUES (?, ?, ?, ?, ?)',
            [name, email, hashedPassword, phone || null, role || 'requester']
        );
        res.json({ ok: true });
    } catch (err) {
        if (err.code === 'ER_DUP_ENTRY') {
            return res.status(400).json({ error: 'Email already registered.' });
        }
        console.error('Registration error:', err);
        res.status(500).json({ error: 'Internal server error.' });
    }
});

// Login User
app.post('/api/login', async (req, res) => {
    try {
        const { email, password } = req.body;
        const [rows] = await db.query('SELECT * FROM users WHERE email=?', [email]);

        if (!rows.length) return res.status(400).json({ error: 'Invalid credentials' });
        
        const user = rows[0];
        const match = await bcrypt.compare(password, user.password);

        if (!match) return res.status(400).json({ error: 'Invalid credentials' });
        
        req.session.user = { 
            id: user.id, 
            name: user.name, 
            email: user.email, 
            role: user.role 
        };

        // CRITICAL: Force save session before responding to ensure persistence on redirect
        req.session.save(err => {
            if (err) console.error('Session Save Error:', err);
            res.json({ ok: true, user: req.session.user });
        });

    } catch (err) {
        console.error('Login Error:', err);
        res.status(500).json({ error: 'Server error during login.' });
    }
});

// Logout User
app.post('/api/logout', (req, res) => {
    req.session.destroy(err => {
        if (err) return res.status(500).json({ error: 'Could not log out.' });
        res.json({ ok: true });
    });
});


// =====================================
// 4. APPLICATION ROUTES (SCHEMA MATCHED & FIXED)
// =====================================

// Get Categories
app.get('/api/categories', isAuthenticated, async (req, res) => {
    try {
        const [categories] = await db.query('SELECT id, name, description FROM categories ORDER BY name');
        res.json({ categories });
    } catch (err) {
        console.error('Categories error:', err);
        res.status(500).json({ error: 'Failed to fetch categories.' });
    }
});

// Get Items by Category (FILTERS BY STATUS)
app.get('/api/items', isAuthenticated, async (req, res) => {
    const categoryId = req.query.category_id;
    if (!categoryId) return res.status(400).json({ error: 'Category ID is required.' });

    try {
        const query = `
            SELECT 
                i.id, i.title, i.description, u.name AS donor_name
            FROM items i
            JOIN users u ON i.donor_id = u.id
            WHERE i.category_id = ? AND i.status = 'available'
        `;
        const [items] = await db.query(query, [categoryId]);
        res.json({ items });
    } catch (err) {
        console.error('Items error:', err);
        res.status(500).json({ error: 'Failed to fetch items.' });
    }
});

// Submit Donation (INSERTS STATUS)
app.post('/api/donate', isAuthenticated, async (req, res) => {
    const { title, description, category_id } = req.body;
    const donorId = req.session.user.id; 

    if (!title || !category_id) {
        return res.status(400).json({ error: 'Missing required donation fields (title, category).' });
    }

    try {
        // INCLUDES THE STATUS COLUMN
        await db.query(
            'INSERT INTO items (donor_id, category_id, title, description, status) VALUES (?,?,?,?,?)',
            [donorId, category_id, title, description || '', 'available']
        );
        res.json({ ok: true, message: 'Donation submitted successfully.' });
    } catch (err) {
        console.error('Donation submission server error:', err);
        res.status(500).json({ error: 'Failed to submit donation due to server error.' });
    }
});

// Submit Request (CHANGES ITEM STATUS)
app.post('/api/request', isAuthenticated, async (req, res) => {
    const conn = await db.getConnection(); 
    try {
        await conn.beginTransaction(); 
        
        const { item_id } = req.body;
        const requesterId = req.session.user.id;

        // 1. Check item status
        const [[item]] = await conn.query('SELECT status FROM items WHERE id = ?', [item_id]);
        if (!item || item.status !== 'available') {
            await conn.rollback();
            return res.status(400).json({ error: 'Item not available or already requested.' });
        }
        
        // 2. Create the request
        await conn.query(
            'INSERT INTO requests (item_id, requester_id, status) VALUES (?, ?, "pending")',
            [item_id, requesterId]
        );

        // 3. CRITICAL FIX: Update item status to make it unavailable
        await conn.query('UPDATE items SET status = "requested" WHERE id = ?', [item_id]);
        
        await conn.commit(); 
        res.json({ ok: true, message: 'Request submitted and item status updated.' });
    } catch (err) {
        await conn.rollback(); 
        console.error('Request submission server error:', err);
        res.status(500).json({ error: 'Server error occurred during request submission.' });
    } finally {
        conn.release(); 
    }
});


// =====================================
// 5. START SERVER
// =====================================

app.listen(port, () => {
    console.log(`🚀 Server listening at http://localhost:${port}`);
});