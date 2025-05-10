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
  if (req.method === 'POST' || req.method === 'PUT' || req.method === 'PATCH') {
    // Use a middleware to parse JSON and then log
    express.json()(req, res, (err) => {
      if (err) {
        console.error("Error parsing JSON body for logging:", err);
      }
      console.log('Body:', JSON.stringify(req.body, null, 2));
      next();
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
// Note: express.json() is effectively applied for relevant methods by the logger.
// If you need it globally for other methods or before the logger, uncomment:
// app.use(express.json());

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
        // This case should ideally not be reached if ON CONFLICT DO NOTHING works and item existed.
        // If it didn't exist and insert failed for other reasons, this might be hit.
        res.status(409).json({ error: 'Favorite already exists or failed to add.' });
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
      'SELECT progress_id, imdb_id, media_type, title, poster_url, status, watched_episodes, total_seasons, episodes_in_season, last_watched_episode, last_interaction_date FROM watched_progress ORDER BY last_interaction_date DESC'
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
      'SELECT progress_id, imdb_id, media_type, title, poster_url, status, watched_episodes, total_seasons, episodes_in_season, last_watched_episode, last_interaction_date FROM watched_progress WHERE imdb_id = $1',
      [imdb_id]
    );
    if (result.rows.length > 0) {
      res.status(200).json(result.rows[0]);
    } else {
      // Return empty object or 404 if preferred when no progress found
      res.status(200).json({});
    }
  } catch (err) {
    console.error('Error fetching specific watched progress:', err.stack);
    res.status(500).json({ error: 'Failed to fetch watched progress for item' });
  }
});

app.post('/api/watched', async (req, res) => {
  const {
    imdb_id, media_type, title, poster_url,
    status, // Status from request body (e.g., 'plan_to_watch')
    watched_episode, // Singular: for toggling one episode {season, episode, watched}
    total_seasons,   // From request body
    episodes_in_season, // From request body (plural, map of season counts)
    // These are also directly from req.body for full object overrides:
    watched_episodes,   // Plural: from request body (e.g. {} for reset)
    last_watched_episode // Singular: from request body (e.g. null for reset)
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
      if (status === 'unwatched') {
        result = await pool.query(
            'DELETE FROM watched_progress WHERE imdb_id = $1 AND media_type = \'movie\' RETURNING *, \'deleted\' AS operation_type', // Add operation_type for clarity
            [imdb_id]
        );
        if (result.rowCount > 0) {
            // Send back the deleted item details if needed, or just a success message
            return res.status(200).json(result.rows[0]); // Frontend expects the item or true for 204
        } else {
            // If not found to delete, can send 204 or a specific message. Frontend currently handles 204 as 'true'.
            return res.status(204).send(); // No content, implies success or already done
        }
      } else { // 'watched' or any other status for a movie (assuming 'watched' is the primary "active" state)
        const movieStatusToSave = status || 'watched'; // Default to 'watched' if status is omitted
        result = await pool.query(
          `INSERT INTO watched_progress (imdb_id, media_type, title, poster_url, status, last_interaction_date)
           VALUES ($1, $2, $3, $4, $5, $6)
           ON CONFLICT (imdb_id) DO UPDATE SET
             title = EXCLUDED.title, poster_url = EXCLUDED.poster_url,
             status = EXCLUDED.status, last_interaction_date = EXCLUDED.last_interaction_date
           RETURNING *`,
          [imdb_id, media_type, title, poster_url, movieStatusToSave, last_interaction_date]
        );
      }

    } else if (media_type === 'tv') {
      // Validate watched_episode (singular) structure if it's present
      if (req.body.watched_episode && (typeof req.body.watched_episode.season === 'undefined' || typeof req.body.watched_episode.episode === 'undefined' || typeof req.body.watched_episode.watched === 'undefined')) {
          return res.status(400).json({ error: 'Invalid watched_episode structure. Required: { season, episode, watched }' });
      }

      await pool.query('BEGIN');
      let existingProgressResult = await pool.query('SELECT * FROM watched_progress WHERE imdb_id = $1', [imdb_id]);

      // Initialize variables that will hold the final state to be saved
      let finalTitle = title;
      let finalPosterUrl = poster_url;
      let finalTotalSeasons = req.body.total_seasons !== undefined ? parseInt(req.body.total_seasons, 10) : null;
      if (req.body.total_seasons !== undefined && isNaN(finalTotalSeasons)) finalTotalSeasons = null;

      let finalWatchedEpisodes = {};
      let finalEpisodesInSeason = {};
      let finalLastWatchedEpisode = null;
      let determinedStatus = req.body.status;

      if (existingProgressResult.rows.length > 0) {
          const existing = existingProgressResult.rows[0];
          // Start with existing values as defaults
          finalTitle = title || existing.title; // Prefer new title if provided
          finalPosterUrl = poster_url || existing.poster_url; // Prefer new poster if provided
          if (finalTotalSeasons === null) finalTotalSeasons = existing.total_seasons; // If not in req, use existing

          finalWatchedEpisodes = existing.watched_episodes || {};
          finalEpisodesInSeason = existing.episodes_in_season || {};
          finalLastWatchedEpisode = existing.last_watched_episode || null;
          if (!determinedStatus) determinedStatus = existing.status;
      }

      // --- START OF CRITICAL FIX ---
      // If the main request body (req.body, not the destructured 'watched_episodes' from top)
      // explicitly includes 'watched_episodes' (plural), it overrides.
      // This is used for resetting the show (payload includes watched_episodes: {})
      if (req.body.hasOwnProperty('watched_episodes')) {
          finalWatchedEpisodes = req.body.watched_episodes || {};
      }

      // If the main request body explicitly includes 'last_watched_episode', it overrides.
      // Used for resetting (payload includes last_watched_episode: null)
      if (req.body.hasOwnProperty('last_watched_episode')) {
          finalLastWatchedEpisode = req.body.last_watched_episode; // Can be null
      }

      // Now, if 'watched_episode' (singular, for toggling one episode) is present in req.body,
      // apply its change to the potentially reset 'finalWatchedEpisodes'.
      if (req.body.watched_episode) {
          const epKey = `S${req.body.watched_episode.season}E${req.body.watched_episode.episode}`;
          if (req.body.watched_episode.watched) {
              finalWatchedEpisodes[epKey] = true;
              finalLastWatchedEpisode = { season: parseInt(req.body.watched_episode.season), episode: parseInt(req.body.watched_episode.episode), timestamp: new Date().toISOString() };
          } else {
              delete finalWatchedEpisodes[epKey];
              if (finalLastWatchedEpisode &&
                  finalLastWatchedEpisode.season === parseInt(req.body.watched_episode.season) &&
                  finalLastWatchedEpisode.episode === parseInt(req.body.watched_episode.episode)) {
                  finalLastWatchedEpisode = null;
              }
          }
      }
      // --- END OF CRITICAL FIX ---

      // Merge episodes_in_season from request (metadata)
      if (req.body.episodes_in_season) { // Using 'episodes_in_season' from destructured req.body
          for (const seasonNum in req.body.episodes_in_season) {
              if (Object.prototype.hasOwnProperty.call(req.body.episodes_in_season, seasonNum)) {
                  const count = parseInt(req.body.episodes_in_season[seasonNum], 10);
                  if (!isNaN(count)) {
                      finalEpisodesInSeason[String(seasonNum)] = count;
                  } else {
                      console.warn(`Invalid episode count for season ${seasonNum}: ${req.body.episodes_in_season[seasonNum]}`);
                  }
              }
          }
      }

      // Validate and set finalTvStatus
      const validTvStatusesFromDB = ['watching', 'completed', 'on_hold', 'dropped', 'plan_to_watch'];
      let finalTvStatusToSave;
      if (determinedStatus && validTvStatusesFromDB.includes(determinedStatus)) {
          finalTvStatusToSave = determinedStatus;
      } else {
          finalTvStatusToSave = validTvStatusesFromDB.includes('watching') ? 'watching' : validTvStatusesFromDB[0];
          if (!finalTvStatusToSave) {
              console.error("CRITICAL: No valid TV statuses defined in validTvStatusesFromDB. Cannot proceed.");
              await pool.query('ROLLBACK');
              return res.status(500).json({ error: 'Server configuration error for TV statuses.' });
          }
          console.warn(`TV status from request/DB ('${determinedStatus}') is invalid or missing. Defaulting to '${finalTvStatusToSave}'.`);
      }

      console.log('--- TV Progress Data for DB ---');
      console.log('IMDB ID:', imdb_id);
      console.log('Final Title for DB:', finalTitle);
      console.log('Final Poster URL for DB:', finalPosterUrl);
      console.log('Final TV Status for DB:', finalTvStatusToSave);
      console.log('Final Total Seasons for DB:', finalTotalSeasons);
      console.log('Final Watched Episodes FOR DB:', JSON.stringify(finalWatchedEpisodes));
      console.log('Final Episodes In Season FOR DB:', JSON.stringify(finalEpisodesInSeason));
      console.log('Final Last Watched Episode FOR DB:', JSON.stringify(finalLastWatchedEpisode));
      console.log('Last Interaction Date:', last_interaction_date);
      console.log('-------------------------------');

      if (existingProgressResult.rows.length > 0) {
          result = await pool.query(
              `UPDATE watched_progress SET
                  title = $1, poster_url = $2, watched_episodes = $3, total_seasons = $4,
                  episodes_in_season = $5, last_watched_episode = $6, last_interaction_date = $7, status = $8
              WHERE imdb_id = $9 RETURNING *`,
              [finalTitle, finalPosterUrl, finalWatchedEpisodes, finalTotalSeasons, finalEpisodesInSeason, finalLastWatchedEpisode, last_interaction_date, finalTvStatusToSave, imdb_id]
          );
      } else {
          result = await pool.query(
              `INSERT INTO watched_progress (
                  imdb_id, media_type, title, poster_url, status, watched_episodes,
                  total_seasons, episodes_in_season, last_watched_episode, last_interaction_date
              ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING *`,
              [imdb_id, media_type, finalTitle, finalPosterUrl, finalTvStatusToSave, finalWatchedEpisodes,
              finalTotalSeasons, finalEpisodesInSeason, finalLastWatchedEpisode, last_interaction_date]
          );
      }
      await pool.query('COMMIT');
    } else {
      // This case should not be reached if media_type is validated earlier
      return res.status(400).json({ error: 'Invalid media_type processing error.' });
    }

    if (result && result.rows.length > 0) {
      res.status(200).json(result.rows[0]);
    } else if (media_type === 'movie' && status === 'unwatched') {
      // This specific case for movies (delete returning 204) is handled above.
      // If we reach here, it means the 'DELETE' didn't return rows but we already sent 204.
      // This part of the conditional might be redundant if movie delete always returns or sends 204 above.
    } else {
      console.warn('Watched progress POST/UPDATE did not yield rows as expected or was handled.', { imdb_id, media_type, status_sent: status });
      // Attempt to fetch current state as a fallback response if no rows returned from INSERT/UPDATE
      const currentState = await pool.query('SELECT * FROM watched_progress WHERE imdb_id = $1', [imdb_id]);
      if (currentState.rows.length > 0) {
        return res.status(200).json(currentState.rows[0]); // Return current state if operation didn't yield data
      }
      res.status(500).json({ error: 'Failed to update or create watched progress; operation did not return data and current state not found.' });
    }
  } catch (err) {
    if (media_type === 'tv' && !app.locals.rolledBack) { // Check if already rolled back to prevent errors
        try {
            await pool.query('ROLLBACK');
            console.log('Transaction rolled back due to error for TV type.');
            app.locals.rolledBack = true; // Mark that rollback was attempted
        } catch (rollbackError) {
            console.error('Error during ROLLBACK:', rollbackError.stack);
        }
    }
    console.error('Error posting/updating watched progress. IMDB_ID:', imdb_id, 'Error Stack:', err.stack);
    res.status(500).json({ error: 'Failed to save watched progress' });
  } finally {
    if (media_type === 'tv') delete app.locals.rolledBack; // Reset flag
  }
});


// --- Basic Route (for server health check) ---
app.get('/', (req, res) => {
  res.send('MyFlix Backend is alive and connected to database (check server console for DB status).');
});


// --- Start the Server ---
app.listen(PORT, '0.0.0.0', () => {
    console.log(`MyFlix Backend server is running on port ${PORT}`);
    console.log(`CORS configured for origin: ${FRONTEND_URL}`);
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
