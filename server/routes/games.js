const express = require('express');
const { body, validationResult, query } = require('express-validator');
const Game = require('../models/Game');
const User = require('../models/User');
const { authenticateToken, checkChips, requireNotInGame, logActivity } = require('../middleware/auth');

const router = express.Router();

// Get available games (lobby)
router.get('/lobby', authenticateToken, [
  query('page').optional().isInt({ min: 1 }).withMessage('Page must be a positive integer'),
  query('limit').optional().isInt({ min: 1, max: 50 }).withMessage('Limit must be between 1 and 50'),
  query('minBet').optional().isInt({ min: 1 }).withMessage('Min bet must be positive'),
  query('maxBet').optional().isInt({ min: 1 }).withMessage('Max bet must be positive'),
  query('gameType').optional().isIn(['classic', 'joker', 'muflis', 'ak47']).withMessage('Invalid game type')
], async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({
        message: 'Validation failed',
        errors: errors.array()
      });
    }

    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 20;
    const { minBet, maxBet, gameType } = req.query;

    // Build query
    const query = { 
      status: { $in: ['waiting', 'active'] },
      isPrivate: false
    };

    if (minBet) query.minBet = { $gte: parseInt(minBet) };
    if (maxBet) query.maxBet = { $lte: parseInt(maxBet) };
    if (gameType) query.gameType = gameType;

    const games = await Game.find(query)
      .populate('players.user', 'username avatar chips city country')
      .populate('createdBy', 'username avatar')
      .sort({ createdAt: -1 })
      .skip((page - 1) * limit)
      .limit(limit);

    const total = await Game.countDocuments(query);

    // Format games for lobby display (hide sensitive information)
    const formattedGames = games.map(game => ({
      gameId: game.gameId,
      gameType: game.gameType,
      status: game.status,
      maxPlayers: game.maxPlayers,
      currentPlayers: game.players.length,
      minBet: game.minBet,
      maxBet: game.maxBet,
      pot: game.pot,
      players: game.players.map(p => ({
        username: p.user.username,
        avatar: p.user.avatar,
        city: p.user.city,
        country: p.user.country,
        isPlaying: p.isPlaying
      })),
      createdBy: game.createdBy.username,
      createdAt: game.createdAt,
      startedAt: game.startedAt
    }));

    res.json({
      games: formattedGames,
      pagination: {
        page,
        limit,
        total,
        pages: Math.ceil(total / limit)
      }
    });

  } catch (error) {
    console.error('Lobby fetch error:', error);
    res.status(500).json({ message: 'Failed to fetch games' });
  }
});

// Create new game
router.post('/create', authenticateToken, requireNotInGame, [
  body('gameType')
    .isIn(['classic', 'joker', 'muflis', 'ak47'])
    .withMessage('Invalid game type'),
  body('maxPlayers')
    .isInt({ min: 2, max: 6 })
    .withMessage('Max players must be between 2 and 6'),
  body('minBet')
    .isInt({ min: 1 })
    .withMessage('Min bet must be positive'),
  body('maxBet')
    .isInt({ min: 1 })
    .withMessage('Max bet must be positive'),
  body('isPrivate')
    .optional()
    .isBoolean()
    .withMessage('isPrivate must be boolean'),
  body('password')
    .optional()
    .isLength({ min: 4, max: 20 })
    .withMessage('Password must be between 4 and 20 characters')
], logActivity('create_game'), async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({
        message: 'Validation failed',
        errors: errors.array()
      });
    }

    const { gameType, maxPlayers, minBet, maxBet, isPrivate = false, password } = req.body;

    // Validate bet range
    if (maxBet < minBet) {
      return res.status(400).json({ message: 'Max bet must be greater than or equal to min bet' });
    }

    // Check if user has enough chips for minimum bet
    if (req.user.chips < minBet) {
      return res.status(400).json({ 
        message: 'Insufficient chips to create this game',
        required: minBet,
        current: req.user.chips
      });
    }

    // Create new game
    const game = new Game({
      gameId: Game.generateGameId(),
      gameType,
      maxPlayers,
      minBet,
      maxBet,
      isPrivate,
      password: isPrivate && password ? password : null,
      createdBy: req.user._id
    });

    // Add creator as first player
    await game.addPlayer(req.user._id);
    await game.save();

    // Update user's current game
    await User.findByIdAndUpdate(req.user._id, {
      currentGameId: game._id
    });

    res.status(201).json({
      message: 'Game created successfully',
      game: {
        gameId: game.gameId,
        gameType: game.gameType,
        status: game.status,
        maxPlayers: game.maxPlayers,
        minBet: game.minBet,
        maxBet: game.maxBet,
        isPrivate: game.isPrivate,
        players: game.players.length,
        createdAt: game.createdAt
      }
    });

  } catch (error) {
    console.error('Game creation error:', error);
    res.status(500).json({ message: 'Failed to create game' });
  }
});

// Join existing game
router.post('/join/:gameId', authenticateToken, requireNotInGame, [
  body('password')
    .optional()
    .isString()
    .withMessage('Password must be a string')
], logActivity('join_game'), async (req, res) => {
  try {
    const { gameId } = req.params;
    const { password } = req.body;

    const game = await Game.findOne({ gameId })
      .populate('players.user', 'username avatar chips');

    if (!game) {
      return res.status(404).json({ message: 'Game not found' });
    }

    if (game.status !== 'waiting') {
      return res.status(400).json({ message: 'Game has already started or ended' });
    }

    if (game.players.length >= game.maxPlayers) {
      return res.status(400).json({ message: 'Game is full' });
    }

    // Check if game is private and password is required
    if (game.isPrivate && game.password !== password) {
      return res.status(403).json({ message: 'Invalid password for private game' });
    }

    // Check if user has enough chips
    if (req.user.chips < game.minBet) {
      return res.status(400).json({ 
        message: 'Insufficient chips to join this game',
        required: game.minBet,
        current: req.user.chips
      });
    }

    // Add player to game
    await game.addPlayer(req.user._id);

    // Update user's current game
    await User.findByIdAndUpdate(req.user._id, {
      currentGameId: game._id
    });

    res.json({
      message: 'Successfully joined game',
      game: {
        gameId: game.gameId,
        status: game.status,
        players: game.players.length,
        maxPlayers: game.maxPlayers
      }
    });

  } catch (error) {
    console.error('Game join error:', error);
    if (error.message.includes('already in game') || error.message.includes('Game is full')) {
      return res.status(400).json({ message: error.message });
    }
    res.status(500).json({ message: 'Failed to join game' });
  }
});

// Leave current game
router.post('/leave', authenticateToken, logActivity('leave_game'), async (req, res) => {
  try {
    if (!req.user.currentGameId) {
      return res.status(400).json({ message: 'You are not in any game' });
    }

    const game = await Game.findById(req.user.currentGameId);
    if (!game) {
      // Clean up user's current game reference
      await User.findByIdAndUpdate(req.user._id, { currentGameId: null });
      return res.status(404).json({ message: 'Game not found' });
    }

    // If game has started, player folds instead of leaving
    if (game.status === 'active') {
      const playerIndex = game.players.findIndex(p => p.user.toString() === req.user._id.toString());
      if (playerIndex !== -1) {
        game.players[playerIndex].isFolded = true;
        game.players[playerIndex].isPlaying = false;
        game.addToHistory('fold', req.user._id, 0, `${req.user.username} left the game (folded)`);
        
        // Check if game should end
        const activePlayers = game.players.filter(p => !p.isFolded && p.isPlaying);
        if (activePlayers.length === 1) {
          game.status = 'completed';
          game.winner = activePlayers[0].user;
          game.completedAt = new Date();
        }
        
        await game.save();
      }
    } else {
      // Remove player from waiting game
      await game.removePlayer(req.user._id);
    }

    // Update user's current game
    await User.findByIdAndUpdate(req.user._id, {
      currentGameId: null
    });

    res.json({ message: 'Successfully left game' });

  } catch (error) {
    console.error('Game leave error:', error);
    res.status(500).json({ message: 'Failed to leave game' });
  }
});

// Start game (only creator can start)
router.post('/start/:gameId', authenticateToken, logActivity('start_game'), async (req, res) => {
  try {
    const { gameId } = req.params;

    const game = await Game.findOne({ gameId }).populate('players.user');
    if (!game) {
      return res.status(404).json({ message: 'Game not found' });
    }

    // Check if user is the creator
    if (game.createdBy.toString() !== req.user._id.toString()) {
      return res.status(403).json({ message: 'Only game creator can start the game' });
    }

    if (game.status !== 'waiting') {
      return res.status(400).json({ message: 'Game has already started or ended' });
    }

    if (game.players.length < 2) {
      return res.status(400).json({ message: 'Need at least 2 players to start' });
    }

    // Validate all players have enough chips
    for (const player of game.players) {
      const user = await User.findById(player.user._id);
      if (user.chips < game.minBet) {
        return res.status(400).json({ 
          message: `Player ${user.username} has insufficient chips`,
          player: user.username,
          required: game.minBet,
          current: user.chips
        });
      }
    }

    // Start the game
    await game.startGame();

    res.json({
      message: 'Game started successfully',
      game: {
        gameId: game.gameId,
        status: game.status,
        startedAt: game.startedAt,
        players: game.players.length
      }
    });

  } catch (error) {
    console.error('Game start error:', error);
    res.status(500).json({ message: 'Failed to start game' });
  }
});

// Get current game state
router.get('/current', authenticateToken, async (req, res) => {
  try {
    if (!req.user.currentGameId) {
      return res.status(404).json({ message: 'You are not in any game' });
    }

    const game = await Game.findById(req.user.currentGameId)
      .populate('players.user', 'username avatar chips city country')
      .populate('createdBy', 'username avatar')
      .populate('winner', 'username avatar');

    if (!game) {
      // Clean up user's current game reference
      await User.findByIdAndUpdate(req.user._id, { currentGameId: null });
      return res.status(404).json({ message: 'Game not found' });
    }

    // Format game for client (hide other players' cards)
    const gameData = game.toObject();
    const userPlayer = gameData.players.find(p => p.user._id.toString() === req.user._id.toString());
    
    if (!userPlayer) {
      return res.status(403).json({ message: 'You are not in this game' });
    }

    // Hide other players' cards if game is active
    if (game.status === 'active') {
      gameData.players = gameData.players.map(player => {
        if (player.user._id.toString() !== req.user._id.toString()) {
          player.cards = new Array(player.cards.length).fill({ hidden: true });
        }
        return player;
      });
    }

    res.json({
      game: gameData,
      isCurrentPlayer: game.currentPlayerIndex === gameData.players.findIndex(p => p.user._id.toString() === req.user._id.toString())
    });

  } catch (error) {
    console.error('Current game fetch error:', error);
    res.status(500).json({ message: 'Failed to fetch current game' });
  }
});

// Get game history for user
router.get('/history', authenticateToken, [
  query('page').optional().isInt({ min: 1 }).withMessage('Page must be a positive integer'),
  query('limit').optional().isInt({ min: 1, max: 50 }).withMessage('Limit must be between 1 and 50'),
  query('status').optional().isIn(['waiting', 'active', 'completed', 'cancelled']).withMessage('Invalid status')
], async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({
        message: 'Validation failed',
        errors: errors.array()
      });
    }

    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 20;
    const { status } = req.query;

    const query = {
      'players.user': req.user._id
    };

    if (status) {
      query.status = status;
    }

    const games = await Game.find(query)
      .populate('players.user', 'username avatar')
      .populate('winner', 'username avatar')
      .populate('createdBy', 'username avatar')
      .sort({ createdAt: -1 })
      .skip((page - 1) * limit)
      .limit(limit);

    const total = await Game.countDocuments(query);

    // Format games for history
    const formattedGames = games.map(game => {
      const userPlayer = game.players.find(p => p.user._id.toString() === req.user._id.toString());
      return {
        gameId: game.gameId,
        gameType: game.gameType,
        status: game.status,
        result: game.winner && game.winner._id.toString() === req.user._id.toString() ? 'won' : 'lost',
        winnings: game.winner && game.winner._id.toString() === req.user._id.toString() ? game.pot : 0,
        losses: userPlayer ? userPlayer.totalBet : 0,
        players: game.players.length,
        pot: game.pot,
        handRank: userPlayer ? userPlayer.handRank : null,
        createdAt: game.createdAt,
        completedAt: game.completedAt
      };
    });

    res.json({
      games: formattedGames,
      pagination: {
        page,
        limit,
        total,
        pages: Math.ceil(total / limit)
      }
    });

  } catch (error) {
    console.error('Game history fetch error:', error);
    res.status(500).json({ message: 'Failed to fetch game history' });
  }
});

// Get game details by ID
router.get('/:gameId', authenticateToken, async (req, res) => {
  try {
    const { gameId } = req.params;

    const game = await Game.findOne({ gameId })
      .populate('players.user', 'username avatar chips city country')
      .populate('createdBy', 'username avatar')
      .populate('winner', 'username avatar');

    if (!game) {
      return res.status(404).json({ message: 'Game not found' });
    }

    // Check if user is in this game or if game is completed (for viewing)
    const userInGame = game.players.some(p => p.user._id.toString() === req.user._id.toString());
    
    if (!userInGame && game.status !== 'completed' && !game.isPrivate) {
      // Allow viewing of public games for joining
      const gameData = {
        gameId: game.gameId,
        gameType: game.gameType,
        status: game.status,
        maxPlayers: game.maxPlayers,
        currentPlayers: game.players.length,
        minBet: game.minBet,
        maxBet: game.maxBet,
        pot: game.pot,
        isPrivate: game.isPrivate,
        players: game.players.map(p => ({
          username: p.user.username,
          avatar: p.user.avatar,
          city: p.user.city,
          country: p.user.country
        })),
        createdBy: game.createdBy,
        createdAt: game.createdAt
      };
      
      return res.json({ game: gameData, canJoin: true });
    }

    if (!userInGame && game.isPrivate) {
      return res.status(403).json({ message: 'Private game - access denied' });
    }

    // Format game data based on game status and user access
    let gameData = game.toObject();
    
    if (game.status === 'active' && userInGame) {
      // Hide other players' cards for active games
      gameData.players = gameData.players.map(player => {
        if (player.user._id.toString() !== req.user._id.toString()) {
          player.cards = new Array(player.cards.length).fill({ hidden: true });
        }
        return player;
      });
    }

    res.json({
      game: gameData,
      userInGame,
      canJoin: !userInGame && game.status === 'waiting' && game.players.length < game.maxPlayers
    });

  } catch (error) {
    console.error('Game details fetch error:', error);
    res.status(500).json({ message: 'Failed to fetch game details' });
  }
});

module.exports = router;