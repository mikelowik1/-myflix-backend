// server.js

// Import necessary modules
require('dotenv').config(); // Loads environment variables from .env file
const express = require('express');
const cors = require('cors');
const { Pool } = require('pg'); // PostgreSQL client

// --- Configuration ---
const PORT = process.env.PORT || 3001;
const FRONTEND_URL = process.env.FRONTEND_URL || 'https://mikesflix.free.nf';

// --- Initialize Express App ---
const app = express();

// --- Middleware ---

// Request Logger
app.use((req, res, next) => {
  console.log(`\n--- Incoming Request ---`);
  console.log(`${req.method} ${req.url}`);
  console.log('Headers:', JSON.stringify(req.headers, null, 2));
  if (req.method === 'POST' || req.method === 'PUT' || req.method === 'PATCH') { // Added PATCH
    // Use a middleware to parse JSON and then log
    express.json()(req, res, (err) => {
      if (err) {
        console.error("Error parsing JSON body for logging:", err);
        // Don't stop the request, but log the error
      }
      console.log('Body:', JSON.stringify(req.body, null, 2));
      next(); // Proceed even if JSON parsing failed for logging
    });
  } else {
    next();
  }
});

// Configure CORS
const corsOptions = {
  origin: FRONTEND_URL,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS'],
  allowedHeaders: [
    'Content-Type',
    'Authorization',
    'X-Requested-With'
  ],
  optionsSuccessStatus: 200,
};
app.use(cors(corsOptions));

// Ensure express.json() is available for routes if not handled by logger for all cases
// app.use(express.json()); // Already integrated into logger for relevant methods

// --- Database Connection ---
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: {
    rejectUnauthorized: false
  }
});

pool.query('SELECT NOW()', (err, res) => {
  if (err) {
    console.error('Error connecting to the database or running query:', err.stack);
  } else {
    console.log('Successfully connected to PostgreSQL database. Server time:', res.rows[0].now);
  }
});

// --- API Routes ---

// == Favorites Endpoints ==
app.get('/api/favorites', async (req, res) => {
  try {
    const result = await pool.query('SELECT imdb_id, title, poster_url, media_type, added_date FROM favorites ORDER BY added_date DESC');
    res.status(200).json(result.rows);
  } catch (err) {
    console.error('Error fetching favorites:', err.stack);
    res.status(500).json({ error: 'Failed to fetch favorites' });
  }
});

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
        res.status(409).json({ error: 'Favorite already exists or failed to add for an unknown reason.' });
      }
    }
  } catch (err) {
    console.error('Error adding favorite:', err.stack);
    res.status(500).json({ error: 'Failed to add favorite' });
  }
});

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
app.get('/api/watched', async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT imdb_id, media_type, title, poster_url, status, watched_episodes, total_seasons, episodes_in_season, last_watched_episode, last_interaction_date FROM watched_progress ORDER BY last_interaction_date DESC'
    );
    res.status(200).json(result.rows);
  } catch (err) {
    console.error('Error fetching watched progress:', err.stack);
    res.status(500).json({ error: 'Failed to fetch watched progress' });
  }
});

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
      res.status(200).json({});
    }
  } catch (err) {
    console.error('Error fetching specific watched progress:', err.stack);
    res.status(500).json({ error: 'Failed to fetch watched progress for item' });
  }
});

app.post('/api/watched', async (req, res) => {
  const {
    imdb_id, media_type, title, poster_url, status, // status from request body
    watched_episode, total_seasons, episodes_in_season, last_watched_episode
  } = req.body;
  const last_interaction_date = new Date();

  if (!imdb_id || !media_type || !title) {
    return res.status(400).json({ error: 'Missing required fields: imdb_id, media_type, title' });
  }
  if (!['movie', 'tv'].includes(media_type)) {
    return res.status(400).json({ error: 'Invalid media_type. Must be "movie" or "tv".' });
  }

  try {
    let result;
    if (media_type === 'movie') {
      // For movies, status is simpler: 'watched' or 'unwatched' (which implies deletion)
      let movieStatus = 'watched'; // Default if adding/updating
      if (status === 'unwatched') { // If frontend explicitly says 'unwatched' for a movie
        result = await pool.query(
            'DELETE FROM watched_progress WHERE imdb_id = $1 AND media_type = \'movie\' RETURNING *',
            [imdb_id]
        );
         if (result.rowCount > 0) {
            return res.status(200).json({ message: 'Movie progress removed (marked unwatched).', data: result.rows[0] });
        } else {
            return res.status(200).json({ message: 'Movie progress was not previously tracked or already removed.' });
        }
      }
      // If not 'unwatched', then it's 'watched' (either new or update)
      result = await pool.query(
        `INSERT INTO watched_progress (imdb_id, media_type, title, poster_url, status, last_interaction_date)
         VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (imdb_id) DO UPDATE SET
           title = EXCLUDED.title, poster_url = EXCLUDED.poster_url,
           status = EXCLUDED.status, last_interaction_date = EXCLUDED.last_interaction_date
         RETURNING *`,
        [imdb_id, media_type, title, poster_url, movieStatus, last_interaction_date]
      );

    } else if (media_type === 'tv') {
      if (watched_episode && (typeof watched_episode.season === 'undefined' || typeof watched_episode.episode === 'undefined' || typeof watched_episode.watched === 'undefined')) {
        return res.status(400).json({ error: 'Invalid watched_episode structure. Required: { season, episode, watched }' });
      }

      await pool.query('BEGIN');
      let existingProgressResult = await pool.query('SELECT * FROM watched_progress WHERE imdb_id = $1', [imdb_id]);

      let currentWatchedEpisodes = {};
      let currentEpisodesInSeason = {};
      let currentLastWatchedEpisode = null;

      // Define YOUR valid statuses for TV shows based on your DB constraint
      // Example: const validTvStatusesFromDB = ['watching', 'completed', 'on_hold', 'dropped', 'plan_to_watch'];
      // Replace this with the actual allowed values from your 'watched_progress_status_check'
      const validTvStatusesFromDB = ['watching', 'completed', 'on_hold', 'dropped', 'plan_to_watch']; // << --- IMPORTANT: ADJUST THIS LIST

      let determinedStatus = status; // Status from request body

      if (!determinedStatus && existingProgressResult.rows.length > 0) {
        determinedStatus = existingProgressResult.rows[0].status; // Status from existing DB record
      }

      let finalTvStatus;
      if (determinedStatus && validTvStatusesFromDB.includes(determinedStatus)) {
        finalTvStatus = determinedStatus;
      } else {
        // If status from request/DB is invalid or missing, default to the first valid status or 'watching' if it's valid
        finalTvStatus = validTvStatusesFromDB.includes('watching') ? 'watching' : validTvStatusesFromDB[0];
        if (!finalTvStatus) { // Should not happen if validTvStatusesFromDB is populated
            console.error("CRITICAL: No valid TV statuses defined in validTvStatusesFromDB or list is empty. Cannot proceed to set a default status.");
            await pool.query('ROLLBACK');
            return res.status(500).json({ error: 'Server configuration error for TV statuses.' });
        }
        console.warn(`TV status from request/DB ('${determinedStatus}') is invalid or missing. Defaulting to '${finalTvStatus}'. Check DB constraint 'watched_progress_status_check'.`);
      }


      let currentTotalSeasons;
      if (total_seasons !== undefined && total_seasons !== null && String(total_seasons).trim() !== '') {
          const parsed = parseInt(total_seasons, 10);
          currentTotalSeasons = !isNaN(parsed) ? parsed : null;
          if (isNaN(parsed)) {
            console.warn(`POST /api/watched: Invalid total_seasons in request body: ${total_seasons}. Using null.`);
          }
      } else {
        currentTotalSeasons = null; // Default to null if not provided or empty
      }


      if (existingProgressResult.rows.length > 0) {
        const existing = existingProgressResult.rows[0];
        currentWatchedEpisodes = existing.watched_episodes || {};
        currentEpisodesInSeason = existing.episodes_in_season || {};
        currentLastWatchedEpisode = existing.last_watched_episode || null;
        if (currentTotalSeasons === null && existing.total_seasons !== null) {
          currentTotalSeasons = existing.total_seasons;
        }
      }


      if (watched_episode) {
        const epKey = `S${watched_episode.season}E${watched_episode.episode}`;
        if (watched_episode.watched) {
          currentWatchedEpisodes[epKey] = true;
          currentLastWatchedEpisode = { season: parseInt(watched_episode.season), episode: parseInt(watched_episode.episode), timestamp: new Date().toISOString() };
        } else {
          delete currentWatchedEpisodes[epKey];
          if (currentLastWatchedEpisode && currentLastWatchedEpisode.season === parseInt(watched_episode.season) && currentLastWatchedEpisode.episode === parseInt(watched_episode.episode)) {
            currentLastWatchedEpisode = null;
          }
        }
      }

      if (episodes_in_season) {
        for (const seasonNum in episodes_in_season) {
            if (Object.prototype.hasOwnProperty.call(episodes_in_season, seasonNum)) {
                 const count = parseInt(episodes_in_season[seasonNum], 10);
                 if(!isNaN(count)) {
                    currentEpisodesInSeason[String(seasonNum)] = count;
                 } else {
                    console.warn(`Invalid episode count for season ${seasonNum}: ${episodes_in_season[seasonNum]}`);
                 }
            }
        }
      }

      console.log('--- TV Progress Data for DB ---');
      console.log('IMDB ID:', imdb_id);
      console.log('Title:', title);
      console.log('Poster URL:', poster_url);
      console.log('Final TV Status for DB:', finalTvStatus); // Log the status being used
      console.log('Current Total Seasons:', currentTotalSeasons);
      console.log('Current Watched Episodes:', JSON.stringify(currentWatchedEpisodes));
      console.log('Current Episodes In Season:', JSON.stringify(currentEpisodesInSeason));
      console.log('Current Last Watched Episode:', JSON.stringify(currentLastWatchedEpisode));
      console.log('Last Interaction Date:', last_interaction_date);
      console.log('-------------------------------');


      if (existingProgressResult.rows.length > 0) {
        result = await pool.query(
          `UPDATE watched_progress SET
             title = $1, poster_url = $2, watched_episodes = $3, total_seasons = $4,
             episodes_in_season = $5, last_watched_episode = $6, last_interaction_date = $7, status = $8
           WHERE imdb_id = $9 RETURNING *`,
          [title, poster_url, currentWatchedEpisodes, currentTotalSeasons, currentEpisodesInSeason, currentLastWatchedEpisode, last_interaction_date, finalTvStatus, imdb_id]
        );
      } else {
        result = await pool.query(
          `INSERT INTO watched_progress (
             imdb_id, media_type, title, poster_url, status, watched_episodes,
             total_seasons, episodes_in_season, last_watched_episode, last_interaction_date
           ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING *`,
          [imdb_id, media_type, title, poster_url, finalTvStatus, currentWatchedEpisodes,
           currentTotalSeasons, currentEpisodesInSeason, currentLastWatchedEpisode, last_interaction_date]
        );
      }
      await pool.query('COMMIT');
    } else {
      return res.status(400).json({ error: 'Invalid media_type processing.' });
    }

    if (result && result.rows.length > 0) {
      res.status(200).json(result.rows[0]);
    } else if (media_type === 'movie' && status === 'unwatched') {
      // This case is handled above by returning directly
    } else {
      console.warn('Watched progress POST did not return rows as expected', { imdb_id, media_type, status_sent: status });
      const currentState = await pool.query('SELECT * FROM watched_progress WHERE imdb_id = $1', [imdb_id]);
      if (currentState.rows.length > 0) {
        return res.status(200).json(currentState.rows[0]);
      }
      res.status(500).json({ error: 'Failed to update or create watched progress; no rows returned and current state not found.' });
    }
  } catch (err) {
    if (media_type === 'tv') await pool.query('ROLLBACK');
    console.error('Error posting/updating watched progress. IMDB_ID:', imdb_id, 'Error Stack:', err.stack);
    res.status(500).json({ error: 'Failed to save watched progress' });
  }
});


// --- Basic Route (for server health check) ---
app.get('/', (req, res) => {
  res.send('MyFlix Backend is alive and connected to database (check server console for DB status).');
});


// --- Start the Server ---
app.listen(PORT, '0.0.0.0', () => { // <--- Added '0.0.0.0' here
    console.log(`MyFlix Backend server is running on port ${PORT}`); // Simpler log for production
    console.log(`CORS configured for origin: ${FRONTEND_URL}`);
  //  console.log(`Raw process.env.FRONTEND_URL: ${process.env.FRONTEND_URL}`); // You can comment this out for production if you like
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
