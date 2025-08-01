const express = require('express');
const { body, validationResult, query } = require('express-validator');
const Transaction = require('../models/Transaction');
const User = require('../models/User');
const { authenticateToken, rateLimitByUser, requireNotInGame, logActivity } = require('../middleware/auth');

const router = express.Router();

// Get user's transaction history
router.get('/history', authenticateToken, [
  query('page').optional().isInt({ min: 1 }).withMessage('Page must be a positive integer'),
  query('limit').optional().isInt({ min: 1, max: 50 }).withMessage('Limit must be between 1 and 50'),
  query('type').optional().isIn([
    'game_win', 'game_loss', 'transfer_send', 'transfer_receive', 
    'admin_add', 'admin_deduct', 'commission_deduct', 'registration_bonus', 'refund'
  ]).withMessage('Invalid transaction type')
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
    const { type } = req.query;

    const result = await Transaction.getUserTransactions(req.user._id, page, limit, type);

    res.json(result);

  } catch (error) {
    console.error('Transaction history fetch error:', error);
    res.status(500).json({ message: 'Failed to fetch transaction history' });
  }
});

// Get user's wallet balance and stats
router.get('/wallet', authenticateToken, async (req, res) => {
  try {
    const user = await User.findById(req.user._id);
    const stats = await Transaction.getUserStats(req.user._id);

    res.json({
      balance: user.chips,
      stats: {
        ...stats,
        winRate: user.gamesPlayed > 0 ? ((user.gamesWon / user.gamesPlayed) * 100).toFixed(2) : 0
      },
      lastUpdated: user.updatedAt
    });

  } catch (error) {
    console.error('Wallet fetch error:', error);
    res.status(500).json({ message: 'Failed to fetch wallet information' });
  }
});

// Send chips to another user
router.post('/send', authenticateToken, requireNotInGame, [
  body('recipientEmail')
    .isEmail()
    .normalizeEmail()
    .withMessage('Please provide a valid recipient email'),
  body('amount')
    .isInt({ min: 1 })
    .withMessage('Amount must be a positive integer'),
  body('message')
    .optional()
    .isLength({ max: 200 })
    .withMessage('Message too long (max 200 characters)')
], rateLimitByUser(5 * 60 * 1000, 5), logActivity('send_chips'), async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({
        message: 'Validation failed',
        errors: errors.array()
      });
    }

    const { recipientEmail, amount, message = '' } = req.body;

    // Can't send to yourself
    if (recipientEmail === req.user.email) {
      return res.status(400).json({ message: 'Cannot send chips to yourself' });
    }

    // Check if sender has sufficient balance
    if (req.user.chips < amount) {
      return res.status(400).json({ 
        message: 'Insufficient chips',
        required: amount,
        current: req.user.chips
      });
    }

    // Find recipient
    const recipient = await User.findOne({ email: recipientEmail });
    if (!recipient) {
      return res.status(404).json({ message: 'Recipient not found' });
    }

    // Check if recipient is blocked
    if (recipient.isBlocked) {
      return res.status(400).json({ message: 'Cannot send chips to blocked user' });
    }

    // Create transfer transactions
    const description = message ? `Transfer: ${message}` : 'Chip transfer';
    const { sendTransaction, receiveTransaction } = await Transaction.createTransferTransaction(
      req.user._id,
      recipient._id,
      amount,
      description
    );

    res.json({
      message: 'Chips sent successfully',
      transaction: {
        id: sendTransaction.transactionId,
        amount,
        recipient: {
          username: recipient.username,
          email: recipient.email
        },
        description,
        timestamp: sendTransaction.createdAt
      },
      newBalance: req.user.chips - amount
    });

  } catch (error) {
    console.error('Send chips error:', error);
    if (error.message === 'Insufficient balance') {
      return res.status(400).json({ message: error.message });
    }
    res.status(500).json({ message: 'Failed to send chips' });
  }
});

// Request chips from another user (create a chip request)
router.post('/request', authenticateToken, [
  body('fromEmail')
    .isEmail()
    .normalizeEmail()
    .withMessage('Please provide a valid email'),
  body('amount')
    .isInt({ min: 1 })
    .withMessage('Amount must be a positive integer'),
  body('message')
    .optional()
    .isLength({ max: 200 })
    .withMessage('Message too long (max 200 characters)')
], rateLimitByUser(10 * 60 * 1000, 3), async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({
        message: 'Validation failed',
        errors: errors.array()
      });
    }

    const { fromEmail, amount, message = '' } = req.body;

    // Can't request from yourself
    if (fromEmail === req.user.email) {
      return res.status(400).json({ message: 'Cannot request chips from yourself' });
    }

    // Find the user to request from
    const fromUser = await User.findOne({ email: fromEmail });
    if (!fromUser) {
      return res.status(404).json({ message: 'User not found' });
    }

    // Check if they are friends (optional security measure)
    if (!req.user.friends.includes(fromUser._id)) {
      return res.status(403).json({ message: 'Can only request chips from friends' });
    }

    // For now, we'll just return success - in a real app you might store requests
    // and notify the other user via socket or email
    res.json({
      message: 'Chip request sent successfully',
      request: {
        amount,
        from: {
          username: fromUser.username,
          email: fromUser.email
        },
        message,
        timestamp: new Date()
      }
    });

  } catch (error) {
    console.error('Request chips error:', error);
    res.status(500).json({ message: 'Failed to send chip request' });
  }
});

// Get transaction details by ID
router.get('/:transactionId', authenticateToken, async (req, res) => {
  try {
    const { transactionId } = req.params;

    const transaction = await Transaction.findOne({ transactionId })
      .populate('from', 'username email avatar')
      .populate('to', 'username email avatar')
      .populate('gameId', 'gameId gameType status')
      .populate('metadata.adminId', 'username email');

    if (!transaction) {
      return res.status(404).json({ message: 'Transaction not found' });
    }

    // Check if user is involved in this transaction
    const isInvolved = transaction.to && transaction.to._id.toString() === req.user._id.toString() ||
                      transaction.from && transaction.from._id.toString() === req.user._id.toString();

    if (!isInvolved) {
      return res.status(403).json({ message: 'Access denied' });
    }

    res.json({ transaction });

  } catch (error) {
    console.error('Transaction details fetch error:', error);
    res.status(500).json({ message: 'Failed to fetch transaction details' });
  }
});

// Get user's chip statistics
router.get('/stats/summary', authenticateToken, async (req, res) => {
  try {
    const stats = await Transaction.getUserStats(req.user._id);
    const user = await User.findById(req.user._id);

    const summary = {
      currentBalance: user.chips,
      totalEarned: stats.totalWinnings + stats.totalTransfers,
      totalSpent: stats.totalLosses,
      netGain: stats.netWinnings,
      gamesPlayed: user.gamesPlayed,
      gamesWon: user.gamesWon,
      winRate: user.gamesPlayed > 0 ? ((user.gamesWon / user.gamesPlayed) * 100).toFixed(2) : 0,
      totalTransactions: stats.transactionCount,
      lastActivity: user.lastSeen
    };

    res.json({ summary });

  } catch (error) {
    console.error('Stats summary error:', error);
    res.status(500).json({ message: 'Failed to fetch statistics' });
  }
});

// Get recent transactions (last 10)
router.get('/recent/activity', authenticateToken, async (req, res) => {
  try {
    const result = await Transaction.getUserTransactions(req.user._id, 1, 10);
    
    res.json({
      transactions: result.transactions,
      count: result.transactions.length
    });

  } catch (error) {
    console.error('Recent transactions error:', error);
    res.status(500).json({ message: 'Failed to fetch recent transactions' });
  }
});

// Search users by email for chip transfers
router.get('/users/search', authenticateToken, [
  query('email')
    .isEmail()
    .normalizeEmail()
    .withMessage('Please provide a valid email')
], async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({
        message: 'Validation failed',
        errors: errors.array()
      });
    }

    const { email } = req.query;

    // Don't allow searching for yourself
    if (email === req.user.email) {
      return res.status(400).json({ message: 'Cannot search for yourself' });
    }

    const user = await User.findOne({ email }).select('username email avatar city country isOnline');
    
    if (!user) {
      return res.status(404).json({ message: 'User not found' });
    }

    if (user.isBlocked) {
      return res.status(404).json({ message: 'User not found' });
    }

    res.json({
      user: {
        username: user.username,
        email: user.email,
        avatar: user.avatar,
        city: user.city,
        country: user.country,
        isOnline: user.isOnline,
        isFriend: req.user.friends.includes(user._id)
      }
    });

  } catch (error) {
    console.error('User search error:', error);
    res.status(500).json({ message: 'Failed to search user' });
  }
});

// Get monthly transaction summary
router.get('/stats/monthly', authenticateToken, async (req, res) => {
  try {
    const currentDate = new Date();
    const startOfMonth = new Date(currentDate.getFullYear(), currentDate.getMonth(), 1);
    const endOfMonth = new Date(currentDate.getFullYear(), currentDate.getMonth() + 1, 0);

    const monthlyStats = await Transaction.aggregate([
      {
        $match: {
          $or: [
            { to: req.user._id },
            { from: req.user._id }
          ],
          createdAt: {
            $gte: startOfMonth,
            $lte: endOfMonth
          },
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

    const summary = {
      month: currentDate.toLocaleString('default', { month: 'long', year: 'numeric' }),
      winnings: 0,
      losses: 0,
      transfers: 0,
      gamesPlayed: 0,
      totalTransactions: 0
    };

    monthlyStats.forEach(stat => {
      summary.totalTransactions += stat.count;
      
      switch (stat._id) {
        case 'game_win':
          summary.winnings += stat.totalAmount;
          summary.gamesPlayed += stat.count;
          break;
        case 'game_loss':
          summary.losses += stat.totalAmount;
          break;
        case 'transfer_receive':
          summary.transfers += stat.totalAmount;
          break;
      }
    });

    summary.netGain = summary.winnings - summary.losses;

    res.json({ summary });

  } catch (error) {
    console.error('Monthly stats error:', error);
    res.status(500).json({ message: 'Failed to fetch monthly statistics' });
  }
});

module.exports = router;