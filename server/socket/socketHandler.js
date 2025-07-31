const jwt = require('jsonwebtoken');
const User = require('../models/User');
const Game = require('../models/Game');
const Transaction = require('../models/Transaction');

// Store active games and rooms
const activeGames = new Map();
const userSockets = new Map();

// Socket authentication middleware
const authenticateSocket = async (socket, next) => {
  try {
    const token = socket.handshake.auth.token;
    if (!token) {
      return next(new Error('Authentication token required'));
    }

    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    const user = await User.findById(decoded.userId);
    
    if (!user) {
      return next(new Error('Invalid token - user not found'));
    }

    if (user.isBlocked) {
      return next(new Error('Account is blocked'));
    }

    socket.userId = user._id.toString();
    socket.user = user;
    next();
  } catch (error) {
    next(new Error('Authentication failed'));
  }
};

// Game room management
const joinGameRoom = async (socket, gameId) => {
  try {
    const game = await Game.findOne({ gameId }).populate('players.user', 'username avatar chips');
    if (!game) {
      socket.emit('error', { message: 'Game not found' });
      return;
    }

    // Check if user is in this game
    const playerInGame = game.players.find(p => p.user._id.toString() === socket.userId);
    if (!playerInGame) {
      socket.emit('error', { message: 'You are not in this game' });
      return;
    }

    socket.join(gameId);
    socket.currentGameId = gameId;

    // Update user's socket ID and current game
    await User.findByIdAndUpdate(socket.userId, {
      socketId: socket.id,
      currentGameId: game._id,
      isOnline: true
    });

    // Store socket reference
    userSockets.set(socket.userId, socket);

    // Send game state to the user
    socket.emit('game_joined', {
      game: formatGameForClient(game, socket.userId),
      message: 'Successfully joined game'
    });

    // Notify other players
    socket.to(gameId).emit('player_joined', {
      player: {
        id: socket.userId,
        username: socket.user.username,
        avatar: socket.user.avatar
      }
    });

  } catch (error) {
    console.error('Join game room error:', error);
    socket.emit('error', { message: 'Failed to join game' });
  }
};

// Format game data for client (hide cards of other players)
const formatGameForClient = (game, userId) => {
  const gameData = game.toObject();
  
  // Hide other players' cards
  gameData.players = gameData.players.map(player => {
    if (player.user._id.toString() !== userId) {
      // Hide cards but show card count
      player.cards = new Array(player.cards.length).fill({ hidden: true });
    }
    return player;
  });

  return gameData;
};

// Handle game actions
const handleGameAction = async (socket, data) => {
  try {
    const { gameId, action, amount = 0 } = data;
    
    const game = await Game.findOne({ gameId }).populate('players.user');
    if (!game) {
      socket.emit('error', { message: 'Game not found' });
      return;
    }

    const playerIndex = game.players.findIndex(p => p.user._id.toString() === socket.userId);
    if (playerIndex === -1) {
      socket.emit('error', { message: 'You are not in this game' });
      return;
    }

    const player = game.players[playerIndex];
    
    // Check if it's player's turn
    if (game.currentPlayerIndex !== playerIndex) {
      socket.emit('error', { message: 'Not your turn' });
      return;
    }

    // Validate action based on game state
    switch (action) {
      case 'fold':
        await handleFold(socket, game, playerIndex);
        break;
      case 'call':
        await handleCall(socket, game, playerIndex);
        break;
      case 'raise':
        await handleRaise(socket, game, playerIndex, amount);
        break;
      case 'check':
        await handleCheck(socket, game, playerIndex);
        break;
      case 'show':
        await handleShow(socket, game, playerIndex);
        break;
      case 'blind':
        await handleBlind(socket, game, playerIndex);
        break;
      default:
        socket.emit('error', { message: 'Invalid action' });
    }

  } catch (error) {
    console.error('Game action error:', error);
    socket.emit('error', { message: 'Failed to process action' });
  }
};

// Handle fold action
const handleFold = async (socket, game, playerIndex) => {
  const player = game.players[playerIndex];
  player.isFolded = true;
  player.isPlaying = false;
  player.lastAction = 'fold';

  game.addToHistory('fold', player.user._id, 0, `${player.user.username} folded`);

  // Check if only one player remains
  const activePlayers = game.players.filter(p => !p.isFolded && p.isPlaying);
  if (activePlayers.length === 1) {
    await endGame(game, activePlayers[0]);
  } else {
    // Move to next player
    moveToNextPlayer(game);
    await game.save();
  }

  // Broadcast action to all players in the game
  socket.to(game.gameId).emit('player_action', {
    playerId: socket.userId,
    action: 'fold',
    gameState: formatGameForClient(game, socket.userId)
  });
};

// Handle call action
const handleCall = async (socket, game, playerIndex) => {
  const player = game.players[playerIndex];
  const user = await User.findById(player.user._id);

  const callAmount = game.currentBet - player.currentBet;
  
  if (user.chips < callAmount) {
    socket.emit('error', { message: 'Insufficient chips to call' });
    return;
  }

  // Deduct chips from user
  await user.updateChips(callAmount, 'subtract');
  
  player.currentBet += callAmount;
  player.totalBet += callAmount;
  player.lastAction = 'call';
  game.pot += callAmount;

  game.addToHistory('call', player.user._id, callAmount, `${player.user.username} called ${callAmount}`);

  moveToNextPlayer(game);
  await game.save();

  // Broadcast action
  socket.to(game.gameId).emit('player_action', {
    playerId: socket.userId,
    action: 'call',
    amount: callAmount,
    gameState: formatGameForClient(game, socket.userId)
  });
};

// Handle raise action
const handleRaise = async (socket, game, playerIndex, raiseAmount) => {
  const player = game.players[playerIndex];
  const user = await User.findById(player.user._id);

  if (raiseAmount < game.minBet || raiseAmount > game.maxBet) {
    socket.emit('error', { message: `Raise amount must be between ${game.minBet} and ${game.maxBet}` });
    return;
  }

  const totalRequired = game.currentBet - player.currentBet + raiseAmount;
  
  if (user.chips < totalRequired) {
    socket.emit('error', { message: 'Insufficient chips to raise' });
    return;
  }

  // Deduct chips from user
  await user.updateChips(totalRequired, 'subtract');
  
  player.currentBet += totalRequired;
  player.totalBet += totalRequired;
  player.lastAction = 'raise';
  game.currentBet += raiseAmount;
  game.pot += totalRequired;

  game.addToHistory('raise', player.user._id, totalRequired, `${player.user.username} raised by ${raiseAmount}`);

  moveToNextPlayer(game);
  await game.save();

  // Broadcast action
  socket.to(game.gameId).emit('player_action', {
    playerId: socket.userId,
    action: 'raise',
    amount: raiseAmount,
    gameState: formatGameForClient(game, socket.userId)
  });
};

// Handle check action
const handleCheck = async (socket, game, playerIndex) => {
  const player = game.players[playerIndex];
  
  if (game.currentBet > player.currentBet) {
    socket.emit('error', { message: 'Cannot check - must call or raise' });
    return;
  }

  player.lastAction = 'check';
  game.addToHistory('check', player.user._id, 0, `${player.user.username} checked`);

  moveToNextPlayer(game);
  await game.save();

  // Broadcast action
  socket.to(game.gameId).emit('player_action', {
    playerId: socket.userId,
    action: 'check',
    gameState: formatGameForClient(game, socket.userId)
  });
};

// Handle show action (reveal cards)
const handleShow = async (socket, game, playerIndex) => {
  const player = game.players[playerIndex];
  player.isBlind = false;
  player.lastAction = 'show';

  game.addToHistory('show', player.user._id, 0, `${player.user.username} showed cards`);

  await game.save();

  // Broadcast action
  socket.to(game.gameId).emit('player_action', {
    playerId: socket.userId,
    action: 'show',
    cards: player.cards,
    handRank: player.handRank,
    gameState: formatGameForClient(game, socket.userId)
  });
};

// Handle blind play action
const handleBlind = async (socket, game, playerIndex) => {
  const player = game.players[playerIndex];
  const user = await User.findById(player.user._id);

  const blindAmount = game.minBet;
  
  if (user.chips < blindAmount) {
    socket.emit('error', { message: 'Insufficient chips for blind bet' });
    return;
  }

  // Deduct chips from user
  await user.updateChips(blindAmount, 'subtract');
  
  player.currentBet += blindAmount;
  player.totalBet += blindAmount;
  player.lastAction = 'blind';
  player.isBlind = true;
  game.pot += blindAmount;

  if (blindAmount > game.currentBet) {
    game.currentBet = blindAmount;
  }

  game.addToHistory('blind', player.user._id, blindAmount, `${player.user.username} played blind for ${blindAmount}`);

  moveToNextPlayer(game);
  await game.save();

  // Broadcast action
  socket.to(game.gameId).emit('player_action', {
    playerId: socket.userId,
    action: 'blind',
    amount: blindAmount,
    gameState: formatGameForClient(game, socket.userId)
  });
};

// Move to next active player
const moveToNextPlayer = (game) => {
  const activePlayers = game.players.filter(p => !p.isFolded && p.isPlaying);
  if (activePlayers.length <= 1) return;

  let nextIndex = (game.currentPlayerIndex + 1) % game.players.length;
  
  // Find next active player
  while (game.players[nextIndex].isFolded || !game.players[nextIndex].isPlaying) {
    nextIndex = (nextIndex + 1) % game.players.length;
  }
  
  game.currentPlayerIndex = nextIndex;
};

// End game and distribute winnings
const endGame = async (game, winner) => {
  try {
    game.status = 'completed';
    game.winner = winner.user._id;
    game.winningHand = winner.handRank;
    game.completedAt = new Date();

    // Calculate commission (3% of total pot)
    const commissionRate = parseFloat(process.env.PLATFORM_COMMISSION_RATE) || 0.03;
    const commission = Math.floor(game.pot * commissionRate);
    const winnings = game.pot - commission;

    // Update winner's chips and stats
    const winnerUser = await User.findById(winner.user._id);
    await winnerUser.updateChips(winnings, 'add');
    
    winnerUser.gamesWon += 1;
    winnerUser.gamesPlayed += 1;
    winnerUser.totalChipsWon += winnings;
    await winnerUser.save();

    // Update all players' game stats
    await Promise.all(game.players.map(async (player) => {
      const user = await User.findById(player.user._id);
      user.gamesPlayed += 1;
      
      if (player.user._id.toString() !== winner.user._id.toString()) {
        user.totalChipsLost += player.totalBet;
      }
      
      user.currentGameId = null;
      await user.save();
    }));

    // Create transaction records
    await Transaction.createGameWinTransaction(winner.user._id, winnings, game._id, game.pot, commissionRate);
    await Transaction.createCommissionTransaction(commission, game._id);

    // Create loss transactions for other players
    await Promise.all(game.players.map(async (player) => {
      if (player.user._id.toString() !== winner.user._id.toString() && player.totalBet > 0) {
        await Transaction.createGameLossTransaction(player.user._id, player.totalBet, game._id);
      }
    }));

    await game.save();

    // Broadcast game end to all players
    game.players.forEach(player => {
      const socket = userSockets.get(player.user._id.toString());
      if (socket) {
        socket.emit('game_ended', {
          winner: {
            id: winner.user._id,
            username: winnerUser.username,
            winnings,
            handRank: winner.handRank,
            cards: winner.cards
          },
          commission,
          finalPot: game.pot,
          gameHistory: game.gameHistory
        });
        
        // Remove from game room
        socket.leave(game.gameId);
        socket.currentGameId = null;
      }
    });

  } catch (error) {
    console.error('End game error:', error);
  }
};

// Main socket handler
module.exports = (io) => {
  // Authentication middleware
  io.use(authenticateSocket);

  io.on('connection', async (socket) => {
    console.log(`User ${socket.user.username} connected with socket ${socket.id}`);

    // Update user's online status and socket ID
    await User.findByIdAndUpdate(socket.userId, {
      isOnline: true,
      socketId: socket.id,
      lastSeen: new Date()
    });

    userSockets.set(socket.userId, socket);

    // Join user to their personal room for direct messages
    socket.join(`user_${socket.userId}`);

    // If user was in a game, rejoin the game room
    if (socket.user.currentGameId) {
      const game = await Game.findById(socket.user.currentGameId);
      if (game && game.status === 'active') {
        socket.join(game.gameId);
        socket.currentGameId = game.gameId;
        socket.emit('game_rejoined', {
          game: formatGameForClient(game, socket.userId)
        });
      }
    }

    // Handle joining a game room
    socket.on('join_game', (data) => {
      joinGameRoom(socket, data.gameId);
    });

    // Handle leaving a game room
    socket.on('leave_game', async () => {
      if (socket.currentGameId) {
        socket.leave(socket.currentGameId);
        socket.to(socket.currentGameId).emit('player_left', {
          playerId: socket.userId,
          username: socket.user.username
        });
        socket.currentGameId = null;

        // Update user's current game
        await User.findByIdAndUpdate(socket.userId, {
          currentGameId: null
        });
      }
    });

    // Handle game actions
    socket.on('game_action', (data) => {
      handleGameAction(socket, data);
    });

    // Handle chat messages
    socket.on('chat_message', (data) => {
      if (socket.currentGameId) {
        socket.to(socket.currentGameId).emit('chat_message', {
          playerId: socket.userId,
          username: socket.user.username,
          message: data.message,
          timestamp: new Date()
        });
      }
    });

    // Handle private messages
    socket.on('private_message', async (data) => {
      const { recipientId, message } = data;
      const recipientSocket = userSockets.get(recipientId);
      
      if (recipientSocket) {
        recipientSocket.emit('private_message', {
          fromId: socket.userId,
          fromUsername: socket.user.username,
          message,
          timestamp: new Date()
        });
      }
    });

    // Handle friend invitations to games
    socket.on('invite_friend', async (data) => {
      const { friendId, gameId } = data;
      const friendSocket = userSockets.get(friendId);
      
      if (friendSocket) {
        friendSocket.emit('game_invitation', {
          fromId: socket.userId,
          fromUsername: socket.user.username,
          gameId,
          timestamp: new Date()
        });
      }
    });

    // Handle typing indicators
    socket.on('typing_start', () => {
      if (socket.currentGameId) {
        socket.to(socket.currentGameId).emit('user_typing', {
          playerId: socket.userId,
          username: socket.user.username
        });
      }
    });

    socket.on('typing_stop', () => {
      if (socket.currentGameId) {
        socket.to(socket.currentGameId).emit('user_stopped_typing', {
          playerId: socket.userId
        });
      }
    });

    // Handle disconnection
    socket.on('disconnect', async () => {
      console.log(`User ${socket.user.username} disconnected`);

      // Update user's online status
      await User.findByIdAndUpdate(socket.userId, {
        isOnline: false,
        lastSeen: new Date(),
        socketId: null
      });

      // Remove from active sockets
      userSockets.delete(socket.userId);

      // Notify game room if user was in a game
      if (socket.currentGameId) {
        socket.to(socket.currentGameId).emit('player_disconnected', {
          playerId: socket.userId,
          username: socket.user.username
        });
      }
    });

    // Send welcome message
    socket.emit('connected', {
      message: 'Welcome to Teen Patti Casino!',
      user: socket.user.toJSON()
    });
  });
};