// server.js

// Import necessary modules
require('dotenv').config(); // Loads environment variables from .env file
const express = require('express');
const cors = require('cors');
// const { Pool } = require('pg'); // We'll uncomment and use this later for database

// --- Configuration ---
const PORT = process.env.PORT || 3001; // Port for the backend server to run on

// --- Initialize Express App ---
const app = express();

// --- Middleware ---
app.use(cors()); // Enable CORS for all routes
app.use(express.json()); // Enable Express to parse JSON request bodies

// --- Basic Routes (Placeholders) ---
app.get('/', (req, res) => {
  res.send('Hello from MyFlix Backend!');
});

// Placeholder for API routes - we will expand this significantly
// Example: app.get('/api/favorites', (req, res) => { /* ... logic ... */ });

// --- Database Connection (Placeholder for now) ---
/*
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false,
});

pool.connect()
  .then(() => console.log('Connected to PostgreSQL database'))
  .catch(err => console.error('Database connection error', err.stack));
*/

// --- Start the Server ---
app.listen(PORT, () => {
  console.log(`MyFlix Backend server is running on http://localhost:${PORT}`);
});

// --- Graceful Shutdown (Optional but good practice) ---
process.on('SIGINT', () => {
  console.log('Backend server shutting down...');
  // Perform cleanup if needed (e.g., close database connections)
  process.exit(0);
});
