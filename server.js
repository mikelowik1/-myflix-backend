// server.js

// Import necessary modules
require('dotenv').config(); // Loads environment variables from .env file
const express = require('express');
const cors = require('cors');
const { Pool } = require('pg'); // PostgreSQL client

// --- Configuration ---
const PORT = process.env.PORT || 3001; // Port for the backend server to run on

// --- Initialize Express App ---
const app = express();

// --- Middleware ---
app.use(cors()); // Enable CORS for all routes
app.use(express.json()); // Enable Express to parse JSON request bodies

// --- Database Connection ---
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: {
    rejectUnauthorized: false
  }
});

// Test database connection (runs once on server start)
pool.query('SELECT NOW()', (err, res) => {
  if (err) {
    console.error('Error connecting to the database or running query:', err.stack);
  } else {
    console.log('Successfully connected to PostgreSQL database. Server time:', res.rows[0].now);
  }
});

// --- API Routes ---

// == Favorites Endpoints ==

// GET all favorites
app.get('/api/favorites', async (req, res) => {
  try {
    const result = await pool.query('SELECT imdb_id, title, poster_url, media_type, added_date FROM favorites ORDER BY added_date DESC');
    res.status(200).json(result.rows);
  } catch (err) {
    console.error('Error fetching favorites:', err.stack);
    res.status(500).json({ error: 'Failed to fetch favorites' });
  }
});

// POST a new favorite
app.post('/api/favorites', async (req, res) => {
  const { imdb_id, title, poster_url, media_type } = req.body;
  if (!imdb_id || !title || !media_type) {
    return res.status(400).json({ error: 'Missing required fields: imdb_id, title, media_type' });
  }
  if (!['movie', 'tv'].includes(media_type)) {
    return res.status(400).json({ error: 'Invalid media_type. Must be "movie" or "tv".' });
  }
  try {
    const result = await pool.query(
      'INSERT INTO favorites (imdb_id, title, poster_url, media_type) VALUES ($1, $2, $3, $4) ON CONFLICT (imdb_id) DO NOTHING RETURNING *',
      [imdb_id, title, poster_url, media_type]
    );
    if (result.rows.length > 0) {
      res.status(201).json(result.rows[0]);
    } else {
      const existingFavorite = await pool.query('SELECT * FROM favorites WHERE imdb_id = $1', [imdb_id]);
      if (existingFavorite.rows.length > 0) {
        res.status(200).json({ message: 'Favorite already exists.', favorite: existingFavorite.rows[0] });
      } else {
        res.status(409).json({ error: 'Favorite already exists or failed to add.'})
      }
    }
  } catch (err) {
    console.error('Error adding favorite:', err.stack);
    res.status(500).json({ error: 'Failed to add favorite' });
  }
});

// DELETE a favorite by imdb_id
app.delete('/api/favorites/:imdb_id', async (req, res) => {
  const { imdb_id } = req.params;
  if (!imdb_id) {
    return res.status(400).json({ error: 'IMDB ID is required' });
  }
  try {
    const result = await pool.query('DELETE FROM favorites WHERE imdb_id = $1 RETURNING *', [imdb_id]);
    if (result.rowCount > 0) {
      res.status(200).json({ message: 'Favorite removed successfully', removed_favorite: result.rows[0] });
    } else {
      res.status(404).json({ error: 'Favorite not found' });
    }
  } catch (err) {
    console.error('Error removing favorite:', err.stack);
    res.status(500).json({ error: 'Failed to remove favorite' });
  }
});


// == Watched Progress Endpoints ==

// GET all watched progress items
app.get('/api/watched', async (req, res) => {
  try {
    // Select all relevant fields. The watched_episodes, episodes_in_season, and last_watched_episode are JSONB.
    const result = await pool.query(
      'SELECT imdb_id, media_type, title, poster_url, status, watched_episodes, total_seasons, episodes_in_season, last_watched_episode, last_interaction_date FROM watched_progress ORDER BY last_interaction_date DESC'
    );
    res.status(200).json(result.rows);
  } catch (err) {
    console.error('Error fetching watched progress:', err.stack);
    res.status(500).json({ error: 'Failed to fetch watched progress' });
  }
});

// GET watched progress for a specific item by imdb_id
app.get('/api/watched/:imdb_id', async (req, res) => {
  const { imdb_id } = req.params;
  if (!imdb_id) {
    return res.status(400).json({ error: 'IMDB ID is required' });
  }
  try {
    const result = await pool.query(
      'SELECT imdb_id, media_type, title, poster_url, status, watched_episodes, total_seasons, episodes_in_season, last_watched_episode, last_interaction_date FROM watched_progress WHERE imdb_id = $1',
      [imdb_id]
    );
    if (result.rows.length > 0) {
      res.status(200).json(result.rows[0]);
    } else {
      // It's okay if an item isn't in watched progress yet, send an empty object or specific status
      res.status(200).json({}); // Or res.status(404).json({ message: 'No watched progress found for this item.' });
    }
  } catch (err) {
    console.error('Error fetching specific watched progress:', err.stack);
    res.status(500).json({ error: 'Failed to fetch watched progress for item' });
  }
});

// POST (add or update) watched progress for an item
// This endpoint is more complex as it handles movies and TV shows (with episodes)
app.post('/api/watched', async (req, res) => {
  const {
    imdb_id,            // Required
    media_type,         // Required: 'movie' or 'tv'
    title,              // Required
    poster_url,         // Optional
    status,             // For movies: 'watched' or 'unwatched'
    watched_episode,    // For TV: { season: S, episode: E, watched: true/false }
    total_seasons,      // For TV: total number of seasons
    episodes_in_season, // For TV: { "1": count, "2": count } - can be updated incrementally
    last_watched_episode // For TV: { season: S, episode: E, timestamp: T }
  } = req.body;

  const last_interaction_date = new Date(); // Always update interaction date

  // Basic validation
  if (!imdb_id || !media_type || !title) {
    return res.status(400).json({ error: 'Missing required fields: imdb_id, media_type, title' });
  }
  if (!['movie', 'tv'].includes(media_type)) {
    return res.status(400).json({ error: 'Invalid media_type. Must be "movie" or "tv".' });
  }

  try {
    let result;
    if (media_type === 'movie') {
      // For movies, we insert or update the status.
      // If status is 'unwatched', we could delete the row, or just update status.
      // For simplicity, we'll insert/update. Frontend can decide not to show 'unwatched'.
      if (status === 'unwatched') {
        // If marking as unwatched, delete the record
        result = await pool.query(
            'DELETE FROM watched_progress WHERE imdb_id = $1 AND media_type = \'movie\' RETURNING *',
            [imdb_id]
        );
         if (result.rowCount > 0) {
            return res.status(200).json({ message: 'Movie progress removed (marked unwatched).', data: result.rows[0] });
        } else {
            return res.status(200).json({ message: 'Movie progress was not previously tracked.' });
        }
      } else { // 'watched'
        result = await pool.query(
          `INSERT INTO watched_progress (imdb_id, media_type, title, poster_url, status, last_interaction_date)
           VALUES ($1, $2, $3, $4, $5, $6)
           ON CONFLICT (imdb_id) DO UPDATE SET
             title = EXCLUDED.title,
             poster_url = EXCLUDED.poster_url,
             status = EXCLUDED.status,
             last_interaction_date = EXCLUDED.last_interaction_date
           RETURNING *`,
          [imdb_id, media_type, title, poster_url, 'watched', last_interaction_date]
        );
      }
    } else if (media_type === 'tv') {
      // For TV shows, we need to handle individual episodes and overall series info
      // This involves fetching the existing record, updating JSONB fields, then saving.

      // Ensure watched_episode has the correct structure if provided
      if (watched_episode && (typeof watched_episode.season === 'undefined' || typeof watched_episode.episode === 'undefined' || typeof watched_episode.watched === 'undefined')) {
        return res.status(400).json({ error: 'Invalid watched_episode structure. Required: { season, episode, watched }' });
      }

      // Start a transaction
      await pool.query('BEGIN');

      let existingProgress = await pool.query('SELECT * FROM watched_progress WHERE imdb_id = $1', [imdb_id]);
      let currentWatchedEpisodes = {};
      let currentEpisodesInSeason = {};
      let currentLastWatchedEpisode = null;
      let currentTotalSeasons = total_seasons; // Use provided total_seasons if available

      if (existingProgress.rows.length > 0) {
        currentWatchedEpisodes = existingProgress.rows[0].watched_episodes || {};
        currentEpisodesInSeason = existingProgress.rows[0].episodes_in_season || {};
        currentLastWatchedEpisode = existingProgress.rows[0].last_watched_episode || null;
        if (typeof currentTotalSeasons === 'undefined') { // Only use existing if new not provided
            currentTotalSeasons = existingProgress.rows[0].total_seasons;
        }
      }

      if (watched_episode) {
        const epKey = `S${watched_episode.season}E${watched_episode.episode}`;
        if (watched_episode.watched) {
          currentWatchedEpisodes[epKey] = true;
          // Update last_watched_episode only if this newly watched episode is later
          // For simplicity, we'll just update it if this episode is marked watched.
          // A more robust logic would compare timestamps or S/E numbers.
          currentLastWatchedEpisode = {
            season: parseInt(watched_episode.season),
            episode: parseInt(watched_episode.episode),
            timestamp: new Date().toISOString()
          };
        } else {
          delete currentWatchedEpisodes[epKey];
          // If the unwatched episode was the last watched one, clear last_watched_episode
          if (currentLastWatchedEpisode &&
              currentLastWatchedEpisode.season === parseInt(watched_episode.season) &&
              currentLastWatchedEpisode.episode === parseInt(watched_episode.episode)) {
            currentLastWatchedEpisode = null; // Or find the previous one
          }
        }
      }

      // Update episodes_in_season if provided
      if (episodes_in_season) {
        for (const seasonNum in episodes_in_season) {
            currentEpisodesInSeason[seasonNum] = episodes_in_season[seasonNum];
        }
      }


      if (existingProgress.rows.length > 0) {
        // Update existing TV show progress
        result = await pool.query(
          `UPDATE watched_progress SET
             title = $1,
             poster_url = $2,
             watched_episodes = $3,
             total_seasons = $4,
             episodes_in_season = $5,
             last_watched_episode = $6,
             last_interaction_date = $7
           WHERE imdb_id = $8
           RETURNING *`,
          [title, poster_url, currentWatchedEpisodes, currentTotalSeasons, currentEpisodesInSeason, currentLastWatchedEpisode, last_interaction_date, imdb_id]
        );
      } else {
        // Insert new TV show progress
        result = await pool.query(
          `INSERT INTO watched_progress (imdb_id, media_type, title, poster_url, watched_episodes, total_seasons, episodes_in_season, last_watched_episode, last_interaction_date)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
           RETURNING *`,
          [imdb_id, media_type, title, poster_url, currentWatchedEpisodes, currentTotalSeasons, currentEpisodesInSeason, currentLastWatchedEpisode, last_interaction_date]
        );
      }
      await pool.query('COMMIT'); // Commit transaction
    } else {
      return res.status(400).json({ error: 'Invalid media_type for watched progress.' });
    }

    if (result && result.rows.length > 0) {
      res.status(200).json(result.rows[0]); // Send back the updated/created progress
    } else if (media_type === 'movie' && status === 'unwatched') {
      // Handled above, this path shouldn't be hit if deletion was successful or item wasn't tracked.
      // But as a safe guard:
      res.status(200).json({ message: 'Movie progress state handled.' });
    }
    else {
      // This case might be hit if INSERT OR UPDATE logic for TV didn't yield rows, which is unlikely with RETURNING *
      console.warn('Watched progress POST did not return rows, imdb_id:', imdb_id);
      res.status(500).json({ error: 'Failed to update or create watched progress, no rows returned.' });
    }

  } catch (err) {
    await pool.query('ROLLBACK'); // Rollback transaction on error for TV shows
    console.error('Error posting/updating watched progress:', err.stack);
    res.status(500).json({ error: 'Failed to save watched progress' });
  }
});


// --- Basic Route (for server health check) ---
app.get('/', (req, res) => {
  res.send('MyFlix Backend is alive and connected to database (check server console for DB status).');
});


// --- Start the Server ---
app.listen(PORT, () => {
  console.log(`MyFlix Backend server is running on http://localhost:${PORT}`);
});

// --- Graceful Shutdown ---
process.on('SIGINT', async () => {
  console.log('Backend server shutting down...');
  try {
    await pool.end();
    console.log('Database pool has ended');
  } catch (err) {
    console.error('Error during pool ending:', err.stack);
  }
  process.exit(0);
});
