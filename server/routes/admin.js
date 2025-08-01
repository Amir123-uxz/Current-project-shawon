const express = require('express');
const { body, validationResult, query } = require('express-validator');
const User = require('../models/User');
const Game = require('../models/Game');
const Transaction = require('../models/Transaction');
const { authenticateToken, requireAdmin, rateLimitByUser, logActivity } = require('../middleware/auth');

const router = express.Router();

// Get platform statistics (admin dashboard)
router.get('/dashboard', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const totalUsers = await User.countDocuments();
    const activeUsers = await User.countDocuments({ isOnline: true });
    const blockedUsers = await User.countDocuments({ isBlocked: true });
    
    const totalGames = await Game.countDocuments();
    const activeGames = await Game.countDocuments({ status: 'active' });
    const completedGames = await Game.countDocuments({ status: 'completed' });
    
    const totalTransactions = await Transaction.countDocuments();
    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);
    const todayTransactions = await Transaction.countDocuments({ 
      createdAt: { $gte: todayStart } 
    });

    // Calculate total chips in circulation
    const chipStats = await User.aggregate([
      {
        $group: {
          _id: null,
          totalChips: { $sum: '$chips' },
          averageChips: { $avg: '$chips' }
        }
      }
    ]);

    // Calculate platform commission earned
    const commissionStats = await Transaction.aggregate([
      {
        $match: { type: 'commission_deduct' }
      },
      {
        $group: {
          _id: null,
          totalCommission: { $sum: '$amount' },
          count: { $sum: 1 }
        }
      }
    ]);

    const dashboard = {
      users: {
        total: totalUsers,
        active: activeUsers,
        blocked: blockedUsers,
        registrationRate: totalUsers // Could be enhanced with time-based calculations
      },
      games: {
        total: totalGames,
        active: activeGames,
        completed: completedGames,
        completionRate: totalGames > 0 ? ((completedGames / totalGames) * 100).toFixed(2) : 0
      },
      transactions: {
        total: totalTransactions,
        today: todayTransactions
      },
      chips: {
        totalInCirculation: chipStats[0]?.totalChips || 0,
        averagePerUser: chipStats[0]?.averageChips || 0
      },
      platform: {
        totalCommission: commissionStats[0]?.totalCommission || 0,
        commissionTransactions: commissionStats[0]?.count || 0
      }
    };

    res.json({ dashboard });

  } catch (error) {
    console.error('Admin dashboard error:', error);
    res.status(500).json({ message: 'Failed to fetch dashboard data' });
  }
});

// Get all users with pagination and filters
router.get('/users', authenticateToken, requireAdmin, [
  query('page').optional().isInt({ min: 1 }).withMessage('Page must be a positive integer'),
  query('limit').optional().isInt({ min: 1, max: 100 }).withMessage('Limit must be between 1 and 100'),
  query('search').optional().isLength({ max: 50 }).withMessage('Search term too long'),
  query('status').optional().isIn(['all', 'active', 'blocked', 'online']).withMessage('Invalid status filter'),
  query('sortBy').optional().isIn(['createdAt', 'chips', 'gamesPlayed', 'lastSeen']).withMessage('Invalid sort field'),
  query('sortOrder').optional().isIn(['asc', 'desc']).withMessage('Invalid sort order')
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
    const { search, status = 'all', sortBy = 'createdAt', sortOrder = 'desc' } = req.query;

    // Build query
    const query = {};
    
    if (search) {
      query.$or = [
        { username: { $regex: search, $options: 'i' } },
        { email: { $regex: search, $options: 'i' } }
      ];
    }

    switch (status) {
      case 'active':
        query.isBlocked = false;
        break;
      case 'blocked':
        query.isBlocked = true;
        break;
      case 'online':
        query.isOnline = true;
        break;
    }

    // Build sort
    const sort = {};
    sort[sortBy] = sortOrder === 'desc' ? -1 : 1;

    const users = await User.find(query)
      .select('-password -verificationCode -passwordResetToken')
      .sort(sort)
      .skip((page - 1) * limit)
      .limit(limit);

    const total = await User.countDocuments(query);

    res.json({
      users,
      pagination: {
        page,
        limit,
        total,
        pages: Math.ceil(total / limit)
      }
    });

  } catch (error) {
    console.error('Admin users fetch error:', error);
    res.status(500).json({ message: 'Failed to fetch users' });
  }
});

// Get user details by ID
router.get('/users/:userId', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const { userId } = req.params;

    const user = await User.findById(userId)
      .select('-password -verificationCode -passwordResetToken')
      .populate('friends', 'username email avatar')
      .populate('currentGameId', 'gameId gameType status');

    if (!user) {
      return res.status(404).json({ message: 'User not found' });
    }

    // Get user's transaction stats
    const transactionStats = await Transaction.getUserStats(userId);
    
    // Get recent transactions
    const recentTransactions = await Transaction.getUserTransactions(userId, 1, 10);

    res.json({
      user,
      stats: {
        ...transactionStats,
        winRate: user.gamesPlayed > 0 ? ((user.gamesWon / user.gamesPlayed) * 100).toFixed(2) : 0
      },
      recentTransactions: recentTransactions.transactions
    });

  } catch (error) {
    console.error('Admin user details error:', error);
    res.status(500).json({ message: 'Failed to fetch user details' });
  }
});

// Add chips to user account
router.post('/users/:userId/add-chips', authenticateToken, requireAdmin, [
  body('amount')
    .isInt({ min: 1 })
    .withMessage('Amount must be a positive integer'),
  body('reason')
    .isLength({ min: 1, max: 200 })
    .withMessage('Reason is required and must be less than 200 characters')
], rateLimitByUser(60 * 1000, 10), logActivity('admin_add_chips'), async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({
        message: 'Validation failed',
        errors: errors.array()
      });
    }

    const { userId } = req.params;
    const { amount, reason } = req.body;

    const user = await User.findById(userId);
    if (!user) {
      return res.status(404).json({ message: 'User not found' });
    }

    // Create admin transaction
    const transaction = await Transaction.createAdminTransaction(
      req.user._id,
      userId,
      amount,
      'admin_add',
      reason
    );

    res.json({
      message: 'Chips added successfully',
      transaction: {
        id: transaction.transactionId,
        amount,
        newBalance: user.chips + amount,
        reason
      }
    });

  } catch (error) {
    console.error('Admin add chips error:', error);
    res.status(500).json({ message: 'Failed to add chips' });
  }
});

// Deduct chips from user account
router.post('/users/:userId/deduct-chips', authenticateToken, requireAdmin, [
  body('amount')
    .isInt({ min: 1 })
    .withMessage('Amount must be a positive integer'),
  body('reason')
    .isLength({ min: 1, max: 200 })
    .withMessage('Reason is required and must be less than 200 characters')
], rateLimitByUser(60 * 1000, 10), logActivity('admin_deduct_chips'), async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({
        message: 'Validation failed',
        errors: errors.array()
      });
    }

    const { userId } = req.params;
    const { amount, reason } = req.body;

    const user = await User.findById(userId);
    if (!user) {
      return res.status(404).json({ message: 'User not found' });
    }

    if (user.chips < amount) {
      return res.status(400).json({ 
        message: 'User has insufficient chips',
        current: user.chips,
        requested: amount
      });
    }

    // Create admin transaction
    const transaction = await Transaction.createAdminTransaction(
      req.user._id,
      userId,
      amount,
      'admin_deduct',
      reason
    );

    res.json({
      message: 'Chips deducted successfully',
      transaction: {
        id: transaction.transactionId,
        amount,
        newBalance: user.chips - amount,
        reason
      }
    });

  } catch (error) {
    console.error('Admin deduct chips error:', error);
    res.status(500).json({ message: 'Failed to deduct chips' });
  }
});

// Block/unblock user
router.post('/users/:userId/block', authenticateToken, requireAdmin, [
  body('blocked')
    .isBoolean()
    .withMessage('Blocked status must be boolean'),
  body('reason')
    .optional()
    .isLength({ max: 200 })
    .withMessage('Reason must be less than 200 characters')
], logActivity('admin_block_user'), async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({
        message: 'Validation failed',
        errors: errors.array()
      });
    }

    const { userId } = req.params;
    const { blocked, reason = '' } = req.body;

    const user = await User.findById(userId);
    if (!user) {
      return res.status(404).json({ message: 'User not found' });
    }

    // Can't block other admins
    if (user.role === 'admin' && user._id.toString() !== req.user._id.toString()) {
      return res.status(403).json({ message: 'Cannot block other administrators' });
    }

    // Update user status
    await User.findByIdAndUpdate(userId, {
      isBlocked: blocked,
      blockedReason: blocked ? reason : '',
      isOnline: blocked ? false : user.isOnline // Force offline if blocked
    });

    res.json({
      message: blocked ? 'User blocked successfully' : 'User unblocked successfully',
      user: {
        id: userId,
        username: user.username,
        isBlocked: blocked,
        reason: blocked ? reason : ''
      }
    });

  } catch (error) {
    console.error('Admin block user error:', error);
    res.status(500).json({ message: 'Failed to update user status' });
  }
});

// Delete user account
router.delete('/users/:userId', authenticateToken, requireAdmin, [
  body('confirmDelete')
    .equals('DELETE')
    .withMessage('Must confirm deletion with "DELETE"'),
  body('reason')
    .isLength({ min: 1, max: 200 })
    .withMessage('Reason is required and must be less than 200 characters')
], rateLimitByUser(60 * 1000, 3), logActivity('admin_delete_user'), async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({
        message: 'Validation failed',
        errors: errors.array()
      });
    }

    const { userId } = req.params;
    const { reason } = req.body;

    const user = await User.findById(userId);
    if (!user) {
      return res.status(404).json({ message: 'User not found' });
    }

    // Can't delete other admins
    if (user.role === 'admin') {
      return res.status(403).json({ message: 'Cannot delete administrator accounts' });
    }

    // Can't delete if user is in active game
    if (user.currentGameId) {
      const game = await Game.findById(user.currentGameId);
      if (game && game.status === 'active') {
        return res.status(400).json({ message: 'Cannot delete user in active game' });
      }
    }

    // Remove user from friends lists
    await User.updateMany(
      { friends: userId },
      { $pull: { friends: userId } }
    );

    // Remove user from friend requests
    await User.updateMany(
      { 'friendRequests.from': userId },
      { $pull: { friendRequests: { from: userId } } }
    );

    // Delete the user
    await User.findByIdAndDelete(userId);

    res.json({
      message: 'User deleted successfully',
      deletedUser: {
        id: userId,
        username: user.username,
        email: user.email
      },
      reason
    });

  } catch (error) {
    console.error('Admin delete user error:', error);
    res.status(500).json({ message: 'Failed to delete user' });
  }
});

// Generate massive amount of chips (billion+ for testing/special events)
router.post('/generate-chips', authenticateToken, requireAdmin, [
  body('amount')
    .isInt({ min: 1, max: 1000000000000 }) // Up to 1 trillion
    .withMessage('Amount must be between 1 and 1 trillion'),
  body('targetUserId')
    .optional()
    .isMongoId()
    .withMessage('Invalid user ID'),
  body('reason')
    .isLength({ min: 1, max: 200 })
    .withMessage('Reason is required and must be less than 200 characters')
], rateLimitByUser(5 * 60 * 1000, 2), logActivity('admin_generate_chips'), async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({
        message: 'Validation failed',
        errors: errors.array()
      });
    }

    const { amount, targetUserId, reason } = req.body;

    let targetUser;
    if (targetUserId) {
      targetUser = await User.findById(targetUserId);
      if (!targetUser) {
        return res.status(404).json({ message: 'Target user not found' });
      }
    } else {
      // If no target user specified, add to admin's account
      targetUser = req.user;
    }

    // Create admin transaction for chip generation
    const transaction = await Transaction.createAdminTransaction(
      req.user._id,
      targetUser._id,
      amount,
      'admin_add',
      `CHIP GENERATION: ${reason}`
    );

    res.json({
      message: 'Chips generated successfully',
      transaction: {
        id: transaction.transactionId,
        amount,
        recipient: {
          id: targetUser._id,
          username: targetUser.username,
          email: targetUser.email
        },
        newBalance: targetUser.chips + amount,
        reason
      }
    });

  } catch (error) {
    console.error('Admin generate chips error:', error);
    res.status(500).json({ message: 'Failed to generate chips' });
  }
});

// Get all transactions (admin view)
router.get('/transactions', authenticateToken, requireAdmin, [
  query('page').optional().isInt({ min: 1 }).withMessage('Page must be a positive integer'),
  query('limit').optional().isInt({ min: 1, max: 100 }).withMessage('Limit must be between 1 and 100'),
  query('type').optional().isIn([
    'game_win', 'game_loss', 'transfer_send', 'transfer_receive', 
    'admin_add', 'admin_deduct', 'commission_deduct', 'registration_bonus', 'refund'
  ]).withMessage('Invalid transaction type'),
  query('userId').optional().isMongoId().withMessage('Invalid user ID'),
  query('startDate').optional().isISO8601().withMessage('Invalid start date'),
  query('endDate').optional().isISO8601().withMessage('Invalid end date')
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
    const { type, userId, startDate, endDate } = req.query;

    // Build query
    const query = {};
    
    if (type) query.type = type;
    if (userId) {
      query.$or = [
        { to: userId },
        { from: userId }
      ];
    }
    
    if (startDate || endDate) {
      query.createdAt = {};
      if (startDate) query.createdAt.$gte = new Date(startDate);
      if (endDate) query.createdAt.$lte = new Date(endDate);
    }

    const transactions = await Transaction.find(query)
      .populate('from', 'username email')
      .populate('to', 'username email')
      .populate('gameId', 'gameId gameType')
      .populate('metadata.adminId', 'username email')
      .sort({ createdAt: -1 })
      .skip((page - 1) * limit)
      .limit(limit);

    const total = await Transaction.countDocuments(query);

    res.json({
      transactions,
      pagination: {
        page,
        limit,
        total,
        pages: Math.ceil(total / limit)
      }
    });

  } catch (error) {
    console.error('Admin transactions fetch error:', error);
    res.status(500).json({ message: 'Failed to fetch transactions' });
  }
});

// Get platform analytics
router.get('/analytics', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const thirtyDaysAgo = new Date();
    thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);

    // User registration trend (last 30 days)
    const userRegistrations = await User.aggregate([
      {
        $match: { createdAt: { $gte: thirtyDaysAgo } }
      },
      {
        $group: {
          _id: { $dateToString: { format: "%Y-%m-%d", date: "$createdAt" } },
          count: { $sum: 1 }
        }
      },
      { $sort: { _id: 1 } }
    ]);

    // Game activity trend
    const gameActivity = await Game.aggregate([
      {
        $match: { createdAt: { $gte: thirtyDaysAgo } }
      },
      {
        $group: {
          _id: { $dateToString: { format: "%Y-%m-%d", date: "$createdAt" } },
          games: { $sum: 1 },
          completedGames: {
            $sum: { $cond: [{ $eq: ["$status", "completed"] }, 1, 0] }
          }
        }
      },
      { $sort: { _id: 1 } }
    ]);

    // Revenue from commissions
    const revenueData = await Transaction.aggregate([
      {
        $match: { 
          type: 'commission_deduct',
          createdAt: { $gte: thirtyDaysAgo }
        }
      },
      {
        $group: {
          _id: { $dateToString: { format: "%Y-%m-%d", date: "$createdAt" } },
          revenue: { $sum: '$amount' },
          transactions: { $sum: 1 }
        }
      },
      { $sort: { _id: 1 } }
    ]);

    res.json({
      analytics: {
        userRegistrations,
        gameActivity,
        revenueData,
        period: '30 days'
      }
    });

  } catch (error) {
    console.error('Admin analytics error:', error);
    res.status(500).json({ message: 'Failed to fetch analytics' });
  }
});

module.exports = router;