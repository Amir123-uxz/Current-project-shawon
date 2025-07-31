const mongoose = require('mongoose');

const transactionSchema = new mongoose.Schema({
  transactionId: {
    type: String,
    required: true,
    unique: true
  },
  type: {
    type: String,
    enum: [
      'game_win',
      'game_loss', 
      'transfer_send',
      'transfer_receive',
      'admin_add',
      'admin_deduct',
      'commission_deduct',
      'registration_bonus',
      'refund'
    ],
    required: true
  },
  from: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    default: null
  },
  to: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true
  },
  amount: {
    type: Number,
    required: true,
    min: 0
  },
  balanceBefore: {
    type: Number,
    required: true,
    min: 0
  },
  balanceAfter: {
    type: Number,
    required: true,
    min: 0
  },
  description: {
    type: String,
    required: true
  },
  gameId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Game',
    default: null
  },
  status: {
    type: String,
    enum: ['pending', 'completed', 'failed', 'cancelled'],
    default: 'completed'
  },
  metadata: {
    adminId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      default: null
    },
    reason: {
      type: String,
      default: ''
    },
    originalAmount: {
      type: Number,
      default: null
    },
    commissionRate: {
      type: Number,
      default: null
    },
    ipAddress: {
      type: String,
      default: ''
    },
    userAgent: {
      type: String,
      default: ''
    }
  },
  createdBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    default: null
  }
}, {
  timestamps: true
});

// Indexes for better query performance
transactionSchema.index({ transactionId: 1 });
transactionSchema.index({ to: 1, createdAt: -1 });
transactionSchema.index({ from: 1, createdAt: -1 });
transactionSchema.index({ type: 1, createdAt: -1 });
transactionSchema.index({ gameId: 1 });
transactionSchema.index({ status: 1 });

// Generate unique transaction ID
transactionSchema.statics.generateTransactionId = function() {
  return 'TXN' + Date.now() + Math.random().toString(36).substr(2, 8).toUpperCase();
};

// Create a transaction record
transactionSchema.statics.createTransaction = async function(data) {
  const {
    type,
    from,
    to,
    amount,
    description,
    gameId = null,
    adminId = null,
    reason = '',
    ipAddress = '',
    userAgent = ''
  } = data;

  const User = mongoose.model('User');
  
  // Get recipient's current balance
  const recipient = await User.findById(to);
  if (!recipient) {
    throw new Error('Recipient not found');
  }

  const balanceBefore = recipient.chips;
  
  // Calculate new balance based on transaction type
  let balanceAfter = balanceBefore;
  if (['game_win', 'transfer_receive', 'admin_add', 'registration_bonus', 'refund'].includes(type)) {
    balanceAfter = balanceBefore + amount;
  } else if (['game_loss', 'transfer_send', 'admin_deduct', 'commission_deduct'].includes(type)) {
    balanceAfter = balanceBefore - amount;
    if (balanceAfter < 0) {
      throw new Error('Insufficient balance');
    }
  }

  // Create transaction record
  const transaction = new this({
    transactionId: this.generateTransactionId(),
    type,
    from,
    to,
    amount,
    balanceBefore,
    balanceAfter,
    description,
    gameId,
    metadata: {
      adminId,
      reason,
      ipAddress,
      userAgent
    },
    createdBy: from || adminId
  });

  // Update user's balance
  await User.findByIdAndUpdate(to, { chips: balanceAfter });

  // Save transaction
  await transaction.save();
  
  return transaction;
};

// Create game win transaction
transactionSchema.statics.createGameWinTransaction = async function(userId, amount, gameId, originalAmount, commissionRate) {
  return this.createTransaction({
    type: 'game_win',
    to: userId,
    amount,
    description: `Won ${amount} chips in game ${gameId}`,
    gameId,
    metadata: {
      originalAmount,
      commissionRate
    }
  });
};

// Create game loss transaction  
transactionSchema.statics.createGameLossTransaction = async function(userId, amount, gameId) {
  return this.createTransaction({
    type: 'game_loss',
    to: userId,
    amount,
    description: `Lost ${amount} chips in game ${gameId}`,
    gameId
  });
};

// Create commission deduction transaction
transactionSchema.statics.createCommissionTransaction = async function(amount, gameId) {
  // Commission goes to platform (no specific user)
  const transaction = new this({
    transactionId: this.generateTransactionId(),
    type: 'commission_deduct',
    to: null, // Platform commission
    amount,
    balanceBefore: 0,
    balanceAfter: 0,
    description: `Platform commission (${amount} chips) from game ${gameId}`,
    gameId,
    status: 'completed'
  });

  await transaction.save();
  return transaction;
};

// Create transfer transaction (both send and receive)
transactionSchema.statics.createTransferTransaction = async function(fromUserId, toUserId, amount, description = '') {
  const User = mongoose.model('User');
  
  // Validate sender has sufficient balance
  const sender = await User.findById(fromUserId);
  if (!sender || sender.chips < amount) {
    throw new Error('Insufficient balance');
  }

  // Create send transaction
  const sendTransaction = await this.createTransaction({
    type: 'transfer_send',
    from: fromUserId,
    to: fromUserId,
    amount,
    description: description || `Sent ${amount} chips to user`
  });

  // Create receive transaction
  const receiveTransaction = await this.createTransaction({
    type: 'transfer_receive',
    from: fromUserId,
    to: toUserId,
    amount,
    description: description || `Received ${amount} chips from user`
  });

  return { sendTransaction, receiveTransaction };
};

// Create admin transaction
transactionSchema.statics.createAdminTransaction = async function(adminId, userId, amount, type, reason = '') {
  if (!['admin_add', 'admin_deduct'].includes(type)) {
    throw new Error('Invalid admin transaction type');
  }

  return this.createTransaction({
    type,
    to: userId,
    amount,
    description: type === 'admin_add' 
      ? `Admin added ${amount} chips` 
      : `Admin deducted ${amount} chips`,
    adminId,
    reason
  });
};

// Get user transaction history
transactionSchema.statics.getUserTransactions = async function(userId, page = 1, limit = 20, type = null) {
  const query = {
    $or: [
      { to: userId },
      { from: userId }
    ]
  };

  if (type) {
    query.type = type;
  }

  const transactions = await this.find(query)
    .populate('from', 'username email')
    .populate('to', 'username email')
    .populate('gameId', 'gameId')
    .sort({ createdAt: -1 })
    .skip((page - 1) * limit)
    .limit(limit);

  const total = await this.countDocuments(query);

  return {
    transactions,
    pagination: {
      page,
      limit,
      total,
      pages: Math.ceil(total / limit)
    }
  };
};

// Get game transactions
transactionSchema.statics.getGameTransactions = async function(gameId) {
  return this.find({ gameId })
    .populate('to', 'username email')
    .populate('from', 'username email')
    .sort({ createdAt: -1 });
};

// Calculate user's total winnings/losses
transactionSchema.statics.getUserStats = async function(userId) {
  const stats = await this.aggregate([
    {
      $match: {
        to: new mongoose.Types.ObjectId(userId),
        status: 'completed'
      }
    },
    {
      $group: {
        _id: '$type',
        totalAmount: { $sum: '$amount' },
        count: { $sum: 1 }
      }
    }
  ]);

  const result = {
    totalWinnings: 0,
    totalLosses: 0,
    totalTransfers: 0,
    gamesPlayed: 0,
    transactionCount: 0
  };

  stats.forEach(stat => {
    result.transactionCount += stat.count;
    
    switch (stat._id) {
      case 'game_win':
        result.totalWinnings += stat.totalAmount;
        result.gamesPlayed += stat.count;
        break;
      case 'game_loss':
        result.totalLosses += stat.totalAmount;
        break;
      case 'transfer_receive':
        result.totalTransfers += stat.totalAmount;
        break;
    }
  });

  result.netWinnings = result.totalWinnings - result.totalLosses;
  
  return result;
};

module.exports = mongoose.model('Transaction', transactionSchema);