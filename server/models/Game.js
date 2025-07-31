const mongoose = require('mongoose');

const gameSchema = new mongoose.Schema({
  gameId: {
    type: String,
    required: true,
    unique: true
  },
  gameType: {
    type: String,
    enum: ['classic', 'joker', 'muflis', 'ak47'],
    default: 'classic'
  },
  status: {
    type: String,
    enum: ['waiting', 'active', 'completed', 'cancelled'],
    default: 'waiting'
  },
  maxPlayers: {
    type: Number,
    default: 6,
    min: 2,
    max: 6
  },
  minBet: {
    type: Number,
    required: true,
    min: 1
  },
  maxBet: {
    type: Number,
    required: true
  },
  currentBet: {
    type: Number,
    default: 0
  },
  pot: {
    type: Number,
    default: 0
  },
  platformCommission: {
    type: Number,
    default: 0
  },
  players: [{
    user: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true
    },
    position: {
      type: Number,
      required: true
    },
    cards: [{
      suit: {
        type: String,
        enum: ['hearts', 'diamonds', 'clubs', 'spades']
      },
      rank: {
        type: String,
        enum: ['2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K', 'A']
      }
    }],
    handRank: {
      type: String,
      enum: ['high-card', 'pair', 'color', 'sequence', 'pure-sequence', 'trail'],
      default: 'high-card'
    },
    handValue: {
      type: Number,
      default: 0
    },
    isPlaying: {
      type: Boolean,
      default: true
    },
    isFolded: {
      type: Boolean,
      default: false
    },
    isBlind: {
      type: Boolean,
      default: true
    },
    currentBet: {
      type: Number,
      default: 0
    },
    totalBet: {
      type: Number,
      default: 0
    },
    isAllIn: {
      type: Boolean,
      default: false
    },
    lastAction: {
      type: String,
      enum: ['fold', 'call', 'raise', 'check', 'all-in'],
      default: null
    },
    joinedAt: {
      type: Date,
      default: Date.now
    }
  }],
  currentPlayerIndex: {
    type: Number,
    default: 0
  },
  dealerIndex: {
    type: Number,
    default: 0
  },
  round: {
    type: Number,
    default: 1
  },
  deck: [{
    suit: {
      type: String,
      enum: ['hearts', 'diamonds', 'clubs', 'spades']
    },
    rank: {
      type: String,
      enum: ['2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K', 'A']
    }
  }],
  winner: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    default: null
  },
  winningHand: {
    type: String,
    default: null
  },
  gameHistory: [{
    action: {
      type: String,
      required: true
    },
    player: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User'
    },
    amount: {
      type: Number,
      default: 0
    },
    timestamp: {
      type: Date,
      default: Date.now
    },
    details: {
      type: String,
      default: ''
    }
  }],
  isPrivate: {
    type: Boolean,
    default: false
  },
  password: {
    type: String,
    default: null
  },
  createdBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true
  },
  startedAt: {
    type: Date,
    default: null
  },
  completedAt: {
    type: Date,
    default: null
  },
  timeLimit: {
    type: Number,
    default: 30 // seconds per turn
  },
  autoFoldTimer: {
    type: Date,
    default: null
  }
}, {
  timestamps: true
});

// Indexes for better performance
gameSchema.index({ gameId: 1 });
gameSchema.index({ status: 1 });
gameSchema.index({ createdBy: 1 });
gameSchema.index({ 'players.user': 1 });

// Generate unique game ID
gameSchema.statics.generateGameId = function() {
  return 'TP' + Date.now() + Math.random().toString(36).substr(2, 5).toUpperCase();
};

// Add player to game
gameSchema.methods.addPlayer = function(userId) {
  if (this.players.length >= this.maxPlayers) {
    throw new Error('Game is full');
  }
  
  if (this.status !== 'waiting') {
    throw new Error('Cannot join game in progress');
  }
  
  // Check if player already in game
  const existingPlayer = this.players.find(p => p.user.toString() === userId.toString());
  if (existingPlayer) {
    throw new Error('Player already in game');
  }
  
  this.players.push({
    user: userId,
    position: this.players.length,
    cards: [],
    isPlaying: true,
    isFolded: false,
    isBlind: true,
    currentBet: 0,
    totalBet: 0
  });
  
  return this.save();
};

// Remove player from game
gameSchema.methods.removePlayer = function(userId) {
  this.players = this.players.filter(p => p.user.toString() !== userId.toString());
  
  // Reposition remaining players
  this.players.forEach((player, index) => {
    player.position = index;
  });
  
  if (this.players.length < 2 && this.status === 'active') {
    this.status = 'cancelled';
  }
  
  return this.save();
};

// Start the game
gameSchema.methods.startGame = function() {
  if (this.players.length < 2) {
    throw new Error('Need at least 2 players to start');
  }
  
  this.status = 'active';
  this.startedAt = new Date();
  this.dealCards();
  
  return this.save();
};

// Deal cards to all players
gameSchema.methods.dealCards = function() {
  const deck = this.createDeck();
  this.deck = this.shuffleDeck(deck);
  
  // Deal 3 cards to each player
  this.players.forEach(player => {
    player.cards = [];
    for (let i = 0; i < 3; i++) {
      player.cards.push(this.deck.pop());
    }
    player.handRank = this.evaluateHand(player.cards);
    player.handValue = this.getHandValue(player.cards, player.handRank);
  });
};

// Create a standard deck
gameSchema.methods.createDeck = function() {
  const suits = ['hearts', 'diamonds', 'clubs', 'spades'];
  const ranks = ['2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K', 'A'];
  const deck = [];
  
  suits.forEach(suit => {
    ranks.forEach(rank => {
      deck.push({ suit, rank });
    });
  });
  
  return deck;
};

// Shuffle deck
gameSchema.methods.shuffleDeck = function(deck) {
  const shuffled = [...deck];
  for (let i = shuffled.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
  }
  return shuffled;
};

// Evaluate hand ranking
gameSchema.methods.evaluateHand = function(cards) {
  if (!cards || cards.length !== 3) return 'high-card';
  
  const ranks = cards.map(c => c.rank).sort();
  const suits = cards.map(c => c.suit);
  
  // Check for trail (three of a kind)
  if (ranks[0] === ranks[1] && ranks[1] === ranks[2]) {
    return 'trail';
  }
  
  // Check for pure sequence
  const rankValues = ranks.map(r => this.getRankValue(r)).sort((a, b) => a - b);
  const isSequence = rankValues[1] === rankValues[0] + 1 && rankValues[2] === rankValues[1] + 1;
  
  if (isSequence && suits[0] === suits[1] && suits[1] === suits[2]) {
    return 'pure-sequence';
  }
  
  // Check for sequence
  if (isSequence) {
    return 'sequence';
  }
  
  // Check for color (flush)
  if (suits[0] === suits[1] && suits[1] === suits[2]) {
    return 'color';
  }
  
  // Check for pair
  if (ranks[0] === ranks[1] || ranks[1] === ranks[2] || ranks[0] === ranks[2]) {
    return 'pair';
  }
  
  return 'high-card';
};

// Get numeric value for rank
gameSchema.methods.getRankValue = function(rank) {
  const values = {
    '2': 2, '3': 3, '4': 4, '5': 5, '6': 6, '7': 7, '8': 8, '9': 9, '10': 10,
    'J': 11, 'Q': 12, 'K': 13, 'A': 14
  };
  return values[rank] || 0;
};

// Calculate hand value for comparison
gameSchema.methods.getHandValue = function(cards, handRank) {
  const rankValues = cards.map(c => this.getRankValue(c.rank)).sort((a, b) => b - a);
  
  switch (handRank) {
    case 'trail':
      return 6000 + rankValues[0];
    case 'pure-sequence':
      return 5000 + rankValues[2]; // lowest card in sequence
    case 'sequence':
      return 4000 + rankValues[2];
    case 'color':
      return 3000 + rankValues[0] * 100 + rankValues[1] * 10 + rankValues[2];
    case 'pair':
      const pairValue = rankValues.find((val, idx) => 
        rankValues.indexOf(val) !== idx
      );
      const kicker = rankValues.find(val => val !== pairValue);
      return 2000 + pairValue * 100 + kicker;
    default:
      return rankValues[0] * 100 + rankValues[1] * 10 + rankValues[2];
  }
};

// Determine winner
gameSchema.methods.determineWinner = function() {
  const activePlayers = this.players.filter(p => !p.isFolded && p.isPlaying);
  
  if (activePlayers.length === 1) {
    return activePlayers[0];
  }
  
  let winner = activePlayers[0];
  activePlayers.forEach(player => {
    if (player.handValue > winner.handValue) {
      winner = player;
    }
  });
  
  return winner;
};

// Add action to game history
gameSchema.methods.addToHistory = function(action, playerId, amount = 0, details = '') {
  this.gameHistory.push({
    action,
    player: playerId,
    amount,
    details,
    timestamp: new Date()
  });
};

module.exports = mongoose.model('Game', gameSchema);